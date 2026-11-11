/**
 * DeepSeek Harness plugin that exposes a loopback-bound Host (Desktop) on one
 * network address, so browsers on other devices use the same running Host and
 * its Sessions. Every field is live: the plugin's page on the Plugins screen
 * edits them and the listener follows without a restart. See README.md.
 */

import { createSocket } from 'node:dgram'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { assertTrustedAuthority, literalHostname, startProxy } from './proxy.ts'
import type { RunningProxy } from './proxy.ts'

/** Cordis plugin name. */
export const name = 'dsh-remote-access'

/** Services this plugin waits for: the Host listener and its browser authentication. */
export const inject = ['webServer', 'connection']

/** Listener port used until the page saves another. */
export const DEFAULT_PORT = 30990

/** Shortest accepted token: a guessable token on a network listener grants remote code execution. */
export const MIN_TOKEN_LENGTH = 16

/** Authenticated route answering the listener status for the plugin page. */
export const STATUS_PATH = '/remote-access/status'

/** A live configuration value. */
export interface Volatile<T> { get(): T }

/** Plugin configuration; every field is edited live from the plugin page. */
export interface Config {
  /** IP literal to bind; empty selects the active LAN address automatically. */
  host: Volatile<string>
  /** Listener port. */
  port: Volatile<number>
  /** Fixed login token; empty keeps the listener stopped. */
  token: Volatile<string>
  /** Extra authorities admitted as Host, such as a DNS name or a reverse-proxy authority. */
  trustedHosts: Volatile<string[]>
}

/** Configuration schema; the Host validates saves against it before writing the profile patch. */
export const Config = z.object({
  host: z.string().pattern(/^[0-9A-Fa-f.:]*$/).default('').volatile(),
  port: z.natural().min(1).max(65535).default(DEFAULT_PORT).volatile(),
  token: z.string().pattern(new RegExp(`^(?:|\\S{${String(MIN_TOKEN_LENGTH)},})$`)).default('').volatile(),
  trustedHosts: z.array(z.string()).default([]).volatile(),
})

/** Listener state reported to the plugin page. */
export type ListenerStatus =
  | { state: 'starting' }
  | { state: 'no-token' }
  | { state: 'listening'; url: string; host: string; port: number; auto: boolean }
  | { state: 'failed'; error: string; port: number; auto: boolean }

/** The members of the Cordis context this plugin uses. */
export interface HostContext {
  readonly webServer: {
    readonly port: number | undefined
    readonly protocol: 'http:' | 'https:'
    register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  }
  readonly connection: {
    authenticatedUrl(baseUrl: string): string
    requestRejection(request: IncomingMessage): number | undefined
  }
  readonly logger: { info(message: string): void; warn(message: string): void }
  on(event: 'loader/volatile-update', listener: () => void): unknown
  effect(execute: () => () => unknown, label?: string): unknown
}

const WILDCARDS = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0', '0:0:0:0:0:0:0:0'])

/** Interface names of virtual, VPN, and tunnel adapters, which never name the LAN address. */
const VIRTUAL_INTERFACE = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|^br-|^veth|utun|^tun|^tap|tailscale|ZeroTier|^zt|Clash|Mihomo|Meta|WireGuard|^wg|Npcap|Bluetooth|Loopback/i

/** Private IPv4 ranges a home or office LAN uses, most common first; -1 for any other address. */
function lanRank(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  const second = Number(address.split('.')[1])
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2
  return -1
}

/**
 * Non-internal IPv4 addresses of physical-looking interfaces, LAN ranges first.
 * @returns `{ address, name }` per interface address.
 */
export function lanAddresses(): { address: string; name: string }[] {
  const out: { address: string; name: string; rank: number }[] = []
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(interfaceName)) continue
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      const rank = lanRank(entry.address)
      out.push({ address: entry.address, name: interfaceName, rank: rank === -1 ? 9 : rank })
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ address, name: interfaceName }) => ({ address, name: interfaceName }))
}

/** The source address the OS would use for the default route; connecting a UDP socket sends nothing. */
function routedAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const finish = (address: string | undefined): void => {
      socket.close()
      resolve(address)
    }
    socket.once('error', () => { finish(undefined) })
    socket.connect(53, '223.5.5.5', () => { finish(socket.address().address) })
  })
}

/**
 * Pick the LAN address of the interface in use: the default-route source when
 * it is a LAN address of a physical-looking interface (a VPN or proxy TUN
 * adapter often owns the default route), otherwise the best-ranked LAN address.
 * @returns the address, or undefined when the machine has none.
 */
export async function detectAddress(): Promise<string | undefined> {
  const candidates = lanAddresses()
  const routed = await routedAddress()
  const preferred = candidates.find(candidate => candidate.address === routed && lanRank(candidate.address) !== -1)
  return (preferred ?? candidates[0])?.address
}

function bindError(error: unknown, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRNOTAVAIL') return `${host} is not an address of this computer`
  if (code === 'EADDRINUSE') return `port ${String(port)} is already in use`
  if (code === 'EACCES') return `port ${String(port)} is reserved by the system`
  return error instanceof Error ? error.message : String(error)
}

/** Binds, rebinds, and stops the listener as the live configuration and the network change. */
export class RemoteListener {
  /** The state the plugin page reports. */
  status: ListenerStatus = { state: 'starting' }
  private current: { proxy: RunningProxy; host: string; port: number } | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly ctx: HostContext
  private readonly config: Config
  private readonly detect: () => Promise<string | undefined>

  /**
   * @param ctx - Host context.
   * @param config - live configuration.
   * @param detect - picks the address in automatic mode.
   */
  constructor(ctx: HostContext, config: Config, detect: () => Promise<string | undefined> = detectAddress) {
    this.ctx = ctx
    this.config = config
    this.detect = detect
  }

  /**
   * Bring the listener in line with the current configuration. Calls are serialized.
   * @returns settlement of this reconciliation.
   */
  reconcile(): Promise<void> {
    this.queue = this.queue.then(() => this.run()).catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-remote-access: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.queue
  }

  /**
   * Stop listening after any reconciliation in progress.
   * @returns settlement once the listener is closed.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.queue
    await this.stop()
  }

  private async run(): Promise<void> {
    if (this.disposed) return
    const port = this.config.port.get()
    const configured = this.config.host.get().trim()
    const auto = configured === ''
    const fail = async (error: string): Promise<void> => {
      await this.stop()
      this.status = { state: 'failed', error, port, auto }
    }
    if (this.config.token.get().length < MIN_TOKEN_LENGTH) {
      await this.stop()
      this.status = { state: 'no-token' }
      return
    }
    let host = configured
    if (auto) {
      const detected = await this.detect()
      if (detected === undefined) return fail('this computer has no LAN address')
      host = detected
    } else if (isIP(host) === 0 || literalHostname(host) === undefined || WILDCARDS.has(host.toLowerCase())) {
      return fail(`${host} is not a single IP address`)
    }
    try {
      for (const entry of this.config.trustedHosts.get()) assertTrustedAuthority(entry)
    } catch (error) {
      return fail((error as Error).message)
    }
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}/`
    if (this.current?.host === host && this.current.port === port) {
      this.status = { state: 'listening', url, host, port, auto }
      return
    }
    await this.stop()
    let proxy: RunningProxy
    try {
      proxy = await startProxy({
        host,
        port,
        token: () => this.config.token.get(),
        trustedHosts: () => this.config.trustedHosts.get(),
        upstreamPort: () => this.ctx.webServer.port,
        launchToken: () => new URL(this.ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token') ?? '',
      })
    } catch (error) {
      return fail(bindError(error, host, port))
    }
    if (this.disposed) {
      await proxy.close()
      return
    }
    this.current = { proxy, host, port }
    this.status = { state: 'listening', url, host, port, auto }
    this.ctx.logger.info(`dsh-remote-access: listening on ${url}`)
  }

  private async stop(): Promise<void> {
    const current = this.current
    this.current = undefined
    await current?.proxy.close()
  }
}

/** How often automatic mode checks whether the LAN address changed. */
const ADDRESS_CHECK_MS = 30_000

/**
 * Start the remote listener for the lifetime of this plugin. Configuration and
 * bind problems are reported through the status route, never by failing the
 * plugin, so the plugin page stays available to correct them.
 * @param ctx - Cordis context with `webServer` and `connection`.
 * @param config - live configuration.
 */
export function apply(ctx: HostContext, config: Config): void {
  if (ctx.webServer.protocol !== 'http:') throw new Error('dsh-remote-access: the Host listener serves HTTPS; only a plain-HTTP loopback Host is supported')
  const listener = new RemoteListener(ctx, config)
  ctx.effect(() => () => listener.dispose(), 'remoteAccess.listener')
  ctx.on('loader/volatile-update', () => { void listener.reconcile() })
  ctx.effect(() => {
    const timer = setInterval(() => { if (config.host.get().trim() === '') void listener.reconcile() }, ADDRESS_CHECK_MS)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'remoteAccess.addressCheck')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ...listener.status, addresses: lanAddresses() }))
    },
  }), `remoteAccess: GET ${STATUS_PATH}`)
  void listener.reconcile()
}
