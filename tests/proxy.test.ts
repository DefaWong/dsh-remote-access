import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import {
  assertTrustedAuthority, forwardedRequestHeaders, forwardedResponseHeaders, rejection, startProxy, translateToken,
} from '../src/proxy.ts'
import type { RunningProxy } from '../src/proxy.ts'

describe('rejection', () => {
  const bind = '192.168.1.5'
  it('admits the bind address on any port, loopback names, and declared authorities', () => {
    assert.equal(rejection({ host: '192.168.1.5:3090' }, bind, []), undefined)
    assert.equal(rejection({ host: '192.168.1.5' }, bind, []), undefined)
    assert.equal(rejection({ host: 'localhost:3090' }, bind, []), undefined)
    assert.equal(rejection({ host: '127.0.0.2:1' }, bind, []), undefined)
    assert.equal(rejection({ host: 'pc.tail.ts.net:3090' }, bind, ['pc.tail.ts.net']), undefined)
    assert.equal(rejection({ host: 'dsh.example:8443' }, bind, ['dsh.example:8443']), undefined)
  })
  it('refuses other Host values', () => {
    assert.equal(rejection({}, bind, []), 'host')
    assert.equal(rejection({ host: 'evil.example' }, bind, []), 'host')
    assert.equal(rejection({ host: 'dsh.example:9000' }, bind, ['dsh.example:8443']), 'host')
    assert.equal(rejection({ host: 'a b' }, bind, []), 'host')
  })
  it('applies the cross-site and Origin checks', () => {
    const host = '192.168.1.5:3090'
    assert.equal(rejection({ host, 'sec-fetch-site': 'cross-site' }, bind, []), 'cross-site')
    assert.equal(rejection({ host, origin: 'http://192.168.1.5:3090' }, bind, []), undefined)
    assert.equal(rejection({ host: '192.168.1.5', origin: 'http://192.168.1.5:80' }, bind, []), undefined)
    assert.equal(rejection({ host: 'pc.example', origin: 'https://pc.example' }, bind, ['pc.example']), undefined)
    assert.equal(rejection({ host, origin: 'http://192.168.1.5:3091' }, bind, []), 'origin')
    assert.equal(rejection({ host, origin: 'http://evil.example' }, bind, []), 'origin')
    assert.equal(rejection({ host, origin: 'null' }, bind, []), 'origin')
    assert.equal(rejection({ host, origin: 'file:///x' }, bind, []), 'origin')
  })
})

describe('assertTrustedAuthority', () => {
  it('accepts bare authorities', () => {
    for (const entry of ['pc.example', 'pc.example:8443', 'pc.example:80', '10.0.0.8:20031', '[fd00::1]:3090']) assertTrustedAuthority(entry)
  })
  it('refuses rewritten or extended values', () => {
    for (const entry of ['pc.example/x', 'user@pc.example', ' pc.example', 'pc.example:', 'pc.example:080', '0x7f.0.0.1', 'pc.example?x', '']) {
      assert.throws(() => { assertTrustedAuthority(entry) }, /not a bare host/)
    }
  })
})

describe('header rewriting', () => {
  const raw = ['Host', '192.168.1.5:3090', 'Origin', 'http://192.168.1.5:3090', 'Connection', 'keep-alive', 'Upgrade', 'websocket', 'Cookie', 'a=1', 'Cookie', 'b=2']
  it('rewrites Host and Origin and drops hop-by-hop fields', () => {
    assert.deepEqual(forwardedRequestHeaders(raw, '127.0.0.1:3090', false),
      ['Host', '127.0.0.1:3090', 'Origin', 'http://127.0.0.1:3090', 'Cookie', 'a=1', 'Cookie', 'b=2'])
  })
  it('keeps Connection and Upgrade for upgrades', () => {
    assert.deepEqual(forwardedRequestHeaders(raw, '127.0.0.1:3090', true),
      ['Host', '127.0.0.1:3090', 'Origin', 'http://127.0.0.1:3090', 'Connection', 'keep-alive', 'Upgrade', 'websocket', 'Cookie', 'a=1', 'Cookie', 'b=2'])
  })
  it('filters response hop-by-hop fields and keeps repeated Set-Cookie', () => {
    assert.deepEqual(forwardedResponseHeaders(['Transfer-Encoding', 'chunked', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Keep-Alive', 'timeout=5']),
      ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'])
  })
})

describe('translateToken', () => {
  const launch = (): string => 'REAL'
  it('replaces a single matching fixed token', () => {
    assert.equal(translateToken('/?token=fixed-token-0123456789', 'fixed-token-0123456789', launch), '/?token=REAL')
    assert.equal(translateToken('/connect?interactions=answer&token=fixed-token-0123456789', 'fixed-token-0123456789', launch), '/connect?interactions=answer&token=REAL')
  })
  it('passes other targets through unchanged', () => {
    assert.equal(translateToken('/?token=wrong', 'fixed-token-0123456789', launch), '/?token=wrong')
    assert.equal(translateToken('/?token=a&token=b', 'a', launch), '/?token=a&token=b')
    assert.equal(translateToken('/api/x', 'fixed-token-0123456789', launch), '/api/x')
    assert.equal(translateToken('/?token=fixed-token-0123456789', undefined, launch), '/?token=fixed-token-0123456789')
  })
})

interface Reply { status: number; headers: IncomingHttpHeaders; rawHeaders: string[]; body: string }

function send(port: number, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res: IncomingMessage) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('startProxy', () => {
  let upstream: Server
  const upgradedUpstream = new Set<Duplex>()
  let upstreamPort: number | undefined
  let proxy: RunningProxy
  const host = (): string => `127.0.0.1:${String(proxy.port)}`

  before(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(() => { res.end('data: two\n\n') }, 20)
        return
      }
      if (req.url?.startsWith('/?token=')) {
        res.writeHead(303, [['location', './'], ['set-cookie', 'a=1'], ['set-cookie', `token=${new URL(req.url, 'http://x').searchParams.get('token') ?? ''}`]].flat())
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null }))
    })
    upstream.on('upgrade', (req, socket) => {
      upgradedUpstream.add(socket)
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Host: ${req.headers.host ?? ''}\r\n\r\n`)
      socket.on('data', (data: Buffer) => { socket.write(data) })
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    upstreamPort = (upstream.address() as AddressInfo).port
    proxy = await startProxy({
      host: '127.0.0.1', port: 0, token: () => 'fixed-token-0123456789', trustedHosts: () => [],
      upstreamPort: () => upstreamPort, launchToken: () => 'REAL',
    })
  })

  after(async () => {
    await proxy.close()
    upstream.closeAllConnections()
    for (const socket of upgradedUpstream) socket.destroy()
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
  })

  it('forwards with the loopback authority', async () => {
    const reply = await send(proxy.port, '/api/x', { host: host(), origin: `http://${host()}` })
    assert.equal(reply.status, 200)
    assert.deepEqual(JSON.parse(reply.body), { url: '/api/x', host: host(), origin: `http://${host()}` })
  })

  it('refuses an untrusted Host before forwarding', async () => {
    const reply = await send(proxy.port, '/api/x', { host: 'evil.example' })
    assert.equal(reply.status, 403)
    assert.match(reply.body, /request refused \(host\)/)
  })

  it('translates the fixed token and keeps every Set-Cookie', async () => {
    const reply = await send(proxy.port, '/?token=fixed-token-0123456789', { host: host() })
    assert.equal(reply.status, 303)
    assert.deepEqual(reply.headers['set-cookie'], ['a=1', 'token=REAL'])
  })

  it('streams event responses', async () => {
    const reply = await send(proxy.port, '/events', { host: host() })
    assert.equal(reply.body, 'data: one\n\ndata: two\n\n')
  })

  it('answers 503 while the Host is not listening', async () => {
    const saved = upstreamPort
    upstreamPort = undefined
    try {
      assert.equal((await send(proxy.port, '/', { host: host() })).status, 503)
    } finally {
      upstreamPort = saved
    }
  })

  it('tunnels upgrades and refuses untrusted ones', async () => {
    const exchange = (hostHeader: string): Promise<string> => new Promise((resolve, reject) => {
      const socket = connect(proxy.port, '127.0.0.1')
      let text = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(`GET /ws HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
      })
      socket.on('data', (chunk: string) => {
        text += chunk
        if (text.includes('\r\n\r\n') && text.startsWith('HTTP/1.1 101') && !text.includes('ping')) socket.write('ping')
        if (text.includes('ping') || text.startsWith('HTTP/1.1 403')) { socket.destroy(); resolve(text) }
      })
      socket.on('error', reject)
    })
    const accepted = await exchange(host())
    assert.match(accepted, /^HTTP\/1\.1 101/)
    assert.match(accepted, new RegExp(`X-Host: ${host().replace('.', '\\.')}`))
    assert.match(accepted, /ping$/)
    assert.match(await exchange('evil.example'), /^HTTP\/1\.1 403/)
  })
})
