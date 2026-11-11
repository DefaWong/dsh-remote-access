/**
 * Network listener that forwards remote browser traffic to a DeepSeek Harness
 * Host listening on loopback.
 *
 * The Host's own `/api` fence trusts loopback Host headers, so this listener
 * performs the equivalent fence for its own address before forwarding: Host
 * must name the bind address, a loopback name, or a declared `trustedHosts`
 * authority; an attached Origin must be the same authority; explicit
 * cross-site requests are refused. Admitted requests are forwarded with Host
 * and Origin rewritten to `127.0.0.1:<listener port>`, which the Host accepts
 * and which binds its login cookie to an authority that stays stable across
 * Host restarts (the Host's own port is OS-assigned per launch).
 *
 * A configured fixed token is translated into the Host's per-process launch
 * token on the way in, so `/?token=<fixed>` logs in after every restart.
 */

import { timingSafeEqual } from 'node:crypto'
import { Agent, createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** Settings for one remote listener. */
export interface ProxyOptions {
  /** Concrete IP literal the listener binds. */
  readonly host: string
  /** Listener port; zero requests an OS-assigned port. */
  readonly port: number
  /** Current fixed login token translated into the Host's launch token; undefined passes tokens through unchanged. */
  readonly token: () => string | undefined
  /** Current extra authorities admitted as Host: `host` (any port) or exact `host:port`. */
  readonly trustedHosts: () => readonly string[]
  /** Current loopback port of the Host, or undefined while it is not listening. */
  readonly upstreamPort: () => number | undefined
  /** The Host's current launch token. */
  readonly launchToken: () => string
}

/** A started listener. */
export interface RunningProxy {
  /** The bound port. */
  readonly port: number
  /** Stop listening and destroy every forwarded connection; resolves after all sockets closed. */
  close(): Promise<void>
}

const TOKEN_QUERY = 'token'

/** Request headers that describe one hop and are never forwarded on plain HTTP requests. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string, scheme: 'http:' | 'https:' = 'http:'): URL | undefined {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    // An unparsable authority is refused by every caller.
    return undefined
  }
}

/**
 * Normalized URL hostname of an IP literal (IPv6 bracketed), or undefined when it is not one.
 * @param address - IPv4 or IPv6 literal without brackets.
 * @returns the hostname as `URL.hostname` spells it.
 */
export function literalHostname(address: string): string | undefined {
  return parseAuthority(address.includes(':') ? `[${address}]` : address)?.hostname
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') return true
  // WHATWG parsing canonicalizes IPv4 spellings to dotted decimal.
  return /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/**
 * Assert one `trustedHosts` entry is a bare `host` or `host:port` authority in canonical form.
 * @param entry - configured value, verbatim.
 * @throws when parsing would rewrite the entry or it carries URL parts beyond the authority.
 */
export function assertTrustedAuthority(entry: string): void {
  const url = parseAuthority(entry)
  if (url !== undefined && url.username === '' && url.password === '' && url.pathname === '/'
    && url.search === '' && url.hash === '' && canonicalAuthority(entry, url) === entry.toLowerCase()) return
  throw new Error(`dsh-remote-access: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/** The port written in an authority, including a scheme-default one that URL parsing strips. */
function writtenPort(entry: string): string | undefined {
  return /\]$/.test(entry) ? undefined : /:(\d+)$/.exec(entry)?.[1]
}

function canonicalAuthority(entry: string, url: URL): string {
  const port = writtenPort(entry)
  return port === undefined ? url.hostname : `${url.hostname}:${String(Number(port))}`
}

function matchesTrusted(entry: string, hostUrl: URL): boolean {
  const entryUrl = parseAuthority(entry)
  if (entryUrl === undefined) return false
  return writtenPort(entry) === undefined ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
}

/**
 * Decide whether one request may be forwarded.
 * @param headers - request headers.
 * @param bindHostname - normalized hostname of the bind address.
 * @param trustedHosts - entries accepted by {@link assertTrustedAuthority}.
 * @returns undefined when admitted, otherwise the refused check.
 */
export function rejection(
  headers: IncomingHttpHeaders,
  bindHostname: string,
  trustedHosts: readonly string[],
): 'host' | 'cross-site' | 'origin' | undefined {
  const host = header(headers, 'host')
  const hostUrl = host === undefined ? undefined : parseAuthority(host)
  if (host === undefined || hostUrl === undefined) return 'host'
  const trusted = hostUrl.hostname === bindHostname || isLoopbackHostname(hostUrl.hostname)
    || trustedHosts.some(entry => matchesTrusted(entry, hostUrl))
  if (!trusted) return 'host'
  if (header(headers, 'sec-fetch-site') === 'cross-site') return 'cross-site'
  const origin = header(headers, 'origin')
  if (origin === undefined) return undefined
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    // The opaque "null" origin and malformed values name no authority.
    return 'origin'
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return 'origin'
  return parseAuthority(host, originUrl.protocol)?.host === originUrl.host ? undefined : 'origin'
}

/**
 * Forwarded request headers in raw-header form.
 * @param rawHeaders - `IncomingMessage.rawHeaders` of the admitted request.
 * @param authority - loopback authority replacing Host and the Origin authority.
 * @param keepHopByHop - true for upgrade requests, which need Connection and Upgrade.
 * @returns flat name/value list.
 */
export function forwardedRequestHeaders(rawHeaders: readonly string[], authority: string, keepHopByHop: boolean): string[] {
  const out: string[] = []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] as string
    const value = rawHeaders[index + 1] as string
    const lower = name.toLowerCase()
    if (lower === 'host') out.push(name, authority)
    else if (lower === 'origin') out.push(name, `http://${authority}`)
    else if (keepHopByHop || !HOP_BY_HOP.has(lower)) out.push(name, value)
  }
  return out
}

/**
 * Response headers forwarded to the remote browser, without hop-by-hop fields.
 * @param rawHeaders - upstream `IncomingMessage.rawHeaders`.
 * @returns flat name/value list.
 */
export function forwardedResponseHeaders(rawHeaders: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] as string
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.push(name, rawHeaders[index + 1] as string)
  }
  return out
}

function sameToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/**
 * Request target with a matching fixed token replaced by the launch token.
 * @param target - request-target as received.
 * @param fixed - configured fixed token, or undefined for pass-through.
 * @param launchToken - reads the Host's launch token.
 * @returns the target to forward.
 */
export function translateToken(target: string, fixed: string | undefined, launchToken: () => string): string {
  if (fixed === undefined || !target.includes(`${TOKEN_QUERY}=`)) return target
  const url = new URL(target, 'http://dsh.invalid')
  const tokens = url.searchParams.getAll(TOKEN_QUERY)
  if (tokens.length !== 1 || !sameToken(tokens[0] as string, fixed)) return target
  url.searchParams.set(TOKEN_QUERY, launchToken())
  return `${url.pathname}${url.search}`
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  res.end(`dsh-remote-access: ${message}\n`)
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Bind the listener and start forwarding.
 * @param options - listener settings.
 * @returns the running listener once bound.
 * @throws the bind error (for example EADDRNOTAVAIL or EADDRINUSE).
 */
export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const bindHostname = literalHostname(options.host)
  if (bindHostname === undefined) throw new Error(`dsh-remote-access: host ${JSON.stringify(options.host)} is not an IP literal`)
  const agent = new Agent({ keepAlive: true })
  const upgraded = new Set<Duplex>()
  const server: Server = createServer()
  let authority = ''

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const refused = rejection(req.headers, bindHostname, options.trustedHosts())
    if (refused !== undefined) {
      refuse(res, 403, `request refused (${refused})`)
      return
    }
    const upstreamPort = options.upstreamPort()
    if (upstreamPort === undefined) {
      refuse(res, 503, 'DeepSeek Harness is not listening yet')
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests. */
    const path = translateToken(req.url ?? '/', options.token(), options.launchToken)
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: upstreamPort,
      method: req.method,
      path,
      headers: forwardedRequestHeaders(req.rawHeaders, authority, false),
      agent,
    })
    upstream.on('response', (response) => {
      /* v8 ignore next -- node:http always sets statusCode on client responses. */
      res.writeHead(response.statusCode ?? 502, response.statusMessage, forwardedResponseHeaders(response.rawHeaders))
      response.pipe(res)
    })
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      else refuse(res, 502, 'DeepSeek Harness did not answer')
    })
    // A remote client that goes away (closed tab, ended event stream) releases the upstream request.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    req.pipe(upstream)
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => { socket.destroy() })
    if (rejection(req.headers, bindHostname, options.trustedHosts()) !== undefined) {
      refuseUpgrade(socket, '403 Forbidden')
      return
    }
    const upstreamPort = options.upstreamPort()
    if (upstreamPort === undefined) {
      refuseUpgrade(socket, '503 Service Unavailable')
      return
    }
    upgraded.add(socket)
    const upstream: Socket = connect(upstreamPort, '127.0.0.1')
    upgraded.add(upstream)
    const release = (): void => {
      socket.destroy()
      upstream.destroy()
      upgraded.delete(socket)
      upgraded.delete(upstream)
    }
    socket.on('close', release)
    upstream.on('close', release)
    upstream.on('error', release)
    upstream.on('connect', () => {
      const headers = forwardedRequestHeaders(req.rawHeaders, authority, true)
      let text = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`
      for (let index = 0; index + 1 < headers.length; index += 2) text += `${headers[index] as string}: ${headers[index + 1] as string}\r\n`
      upstream.write(`${text}\r\n`)
      if (head.byteLength > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  authority = `127.0.0.1:${String(port)}`

  return {
    port,
    async close() {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      for (const socket of upgraded) socket.destroy()
      upgraded.clear()
      agent.destroy()
      await closed
    },
  }
}
