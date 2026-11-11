import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { Config, DEFAULT_PORT, RemoteListener, STATUS_PATH, apply, lanAddresses } from '../src/index.ts'
import type { Config as ConfigValues, HostContext } from '../src/index.ts'

const TOKEN = 'fixed-token-0123456789'

function live(values: { host?: string; port?: number; token?: string; trustedHosts?: string[] }): ConfigValues & { set: (next: typeof values) => void } {
  let current = { host: '', port: DEFAULT_PORT, token: '', trustedHosts: [] as string[], ...values }
  return {
    host: { get: () => current.host },
    port: { get: () => current.port },
    token: { get: () => current.token },
    trustedHosts: { get: () => current.trustedHosts },
    set: (next) => { current = { ...current, ...next } },
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

function fakeContext(protocol: 'http:' | 'https:' = 'http:'): {
  ctx: HostContext; disposers: (() => unknown)[]; routes: Map<string, Handler>; volatile: (() => void)[]; rejection: { value: number | undefined }
} {
  const disposers: (() => unknown)[] = []
  const routes = new Map<string, Handler>()
  const volatile: (() => void)[] = []
  const rejection = { value: undefined as number | undefined }
  const ctx: HostContext = {
    webServer: { port: 1, protocol, register: (route) => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } },
    connection: { authenticatedUrl: base => `${new URL(base).href}?token=REAL`, requestRejection: () => rejection.value },
    logger: { info: () => {}, warn: () => {} },
    on: (_event, listener) => { volatile.push(listener) },
    effect: (execute) => { disposers.push(execute()) },
  }
  return { ctx, disposers, routes, volatile, rejection }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${String(port)}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

describe('Config schema', () => {
  it('defaults every field', () => {
    const value = Config({}) as unknown as ConfigValues
    assert.equal(value.host.get(), '')
    assert.equal(value.port.get(), 30990)
    assert.equal(value.token.get(), '')
    assert.deepEqual(value.trustedHosts.get(), [])
  })
  it('refuses short tokens, spaces, and non-IP hosts', () => {
    assert.throws(() => Config({ token: 'short' }))
    assert.throws(() => Config({ token: `${TOKEN} x` }))
    assert.throws(() => Config({ host: 'pc.local' }))
    assert.throws(() => Config({ port: 0 }))
    assert.equal((Config({ token: TOKEN }) as unknown as ConfigValues).token.get(), TOKEN)
  })
})

describe('RemoteListener', () => {
  it('stays stopped without a token, then follows live edits', async () => {
    const config = live({ host: '127.0.0.1', port: await freePort() })
    const listener = new RemoteListener(fakeContext().ctx, config)
    await listener.reconcile()
    assert.deepEqual(listener.status, { state: 'no-token' })

    config.set({ token: TOKEN })
    await listener.reconcile()
    assert.equal(listener.status.state, 'listening')
    const first = config.port.get()
    assert.equal(await get(first, '/'), 502)

    const second = await freePort()
    config.set({ port: second })
    await listener.reconcile()
    assert.deepEqual(listener.status, { state: 'listening', url: `http://127.0.0.1:${String(second)}/`, host: '127.0.0.1', port: second, auto: false })
    await assert.rejects(get(first, '/'))

    config.set({ token: '' })
    await listener.reconcile()
    assert.deepEqual(listener.status, { state: 'no-token' })
    await assert.rejects(get(second, '/'))
    await listener.dispose()
  })

  it('uses the detected address in automatic mode', async () => {
    const port = await freePort()
    const listener = new RemoteListener(fakeContext().ctx, live({ port, token: TOKEN }), () => Promise.resolve('127.0.0.1'))
    await listener.reconcile()
    assert.deepEqual(listener.status, { state: 'listening', url: `http://127.0.0.1:${String(port)}/`, host: '127.0.0.1', port, auto: true })
    await listener.dispose()
    await assert.rejects(get(port, '/'))

    const none = new RemoteListener(fakeContext().ctx, live({ port, token: TOKEN }), () => Promise.resolve(undefined))
    await none.reconcile()
    assert.deepEqual(none.status, { state: 'failed', error: 'this computer has no LAN address', port, auto: true })
  })

  it('reports configuration and bind problems instead of throwing', async () => {
    const report = async (values: Parameters<typeof live>[0]): Promise<unknown> => {
      const listener = new RemoteListener(fakeContext().ctx, live({ token: TOKEN, ...values }))
      await listener.reconcile()
      await listener.dispose()
      return listener.status
    }
    assert.deepEqual(await report({ host: '0.0.0.0', port: 1 }), { state: 'failed', error: '0.0.0.0 is not a single IP address', port: 1, auto: false })
    assert.match((await report({ host: '127.0.0.1', port: 1, trustedHosts: ['a/b'] }) as { error: string }).error, /not a bare host/)
    assert.deepEqual(await report({ host: '192.0.2.123', port: 30990 }), { state: 'failed', error: '192.0.2.123 is not an address of this computer', port: 30990, auto: false })
    const busy = createServer()
    await new Promise<void>((resolve) => { busy.listen(0, '127.0.0.1', resolve) })
    const { port } = busy.address() as AddressInfo
    assert.deepEqual(await report({ host: '127.0.0.1', port }), { state: 'failed', error: `port ${String(port)} is already in use`, port, auto: false })
    await new Promise<void>((resolve) => { busy.close(() => { resolve() }) })
  })
})

describe('apply', () => {
  it('serves the authenticated status route and reconciles on volatile updates', async () => {
    const { ctx, disposers, routes, volatile, rejection } = fakeContext()
    const config = live({ host: '127.0.0.1', port: await freePort() })
    apply(ctx, config)
    const handler = routes.get(STATUS_PATH) as Handler
    const call = (): Promise<{ status: number; body: string }> => new Promise((resolve) => {
      const res = {
        statusCode: 200,
        writeHead(status: number) { this.statusCode = status; return this },
        end(chunk?: string) { resolve({ status: this.statusCode, body: chunk ?? '' }) },
      }
      handler({} as IncomingMessage, res as unknown as ServerResponse)
    })
    rejection.value = 401
    assert.equal((await call()).status, 401)
    rejection.value = undefined
    await new Promise(resolve => setTimeout(resolve, 20))
    const answer = JSON.parse((await call()).body) as { state: string; addresses: unknown[] }
    assert.equal(answer.state, 'no-token')
    assert.ok(Array.isArray(answer.addresses))

    config.set({ token: TOKEN })
    for (const listener of volatile) listener()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((JSON.parse((await call()).body) as { state: string }).state, 'listening')
    for (const dispose of disposers.reverse()) await dispose()
  })

  it('refuses an HTTPS Host listener', () => {
    assert.throws(() => { apply(fakeContext('https:').ctx, live({})) }, /serves HTTPS/)
  })
})

describe('lanAddresses', () => {
  it('lists IPv4 addresses with interface names', () => {
    for (const entry of lanAddresses()) {
      assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/)
      assert.ok(entry.name.length > 0)
    }
  })
})
