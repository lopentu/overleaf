// @ts-check
import assert from 'node:assert/strict'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { fetchString } from '@overleaf/fetch-utils'

/** @type {string[]} */
let directLookups
beforeEach(() => {
  directLookups = []
  const original = dns.lookup
  // Numeric loopback resolution is local. Every other lookup is trapped before
  // DNS/network I/O, so even a regressed selector cannot contact a provider.
  vi.spyOn(dns, 'lookup').mockImplementation((...args) => {
    if (args[0] !== '127.0.0.1' && args[0] !== '::1') {
      directLookups.push(args[0])
      throw new Error('Direct DNS is forbidden in provider fixtures')
    }
    return Reflect.apply(original, dns, args)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** @param {unknown} proxy */
async function helper(proxy) {
  vi.doMock('@overleaf/settings', () => ({
    default: { providerHttpsProxy: proxy },
  }))
  return (
    await import('../../../../app/src/Features/Integrations/ProviderHttpsAgent.mjs')
  ).withProviderHttpsAgent
}

/** @param {http.Server | https.Server} server */
async function listen(server) {
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

/** @param {() => boolean} condition */
async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'expected owned fixture state did not settle')
}

async function fixture({
  secureProxy = false,
  stalledConnect = false,
  deniedConnect = false,
  json = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lope-provider-tls-'))
  const keyPath = path.join(directory, 'fixture.key')
  const certPath = path.join(directory, 'fixture.crt')
  // Ephemeral fixture key only; no static private key is stored in source.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Provider fixture',
      '-addext',
      'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:codeload.github.com,DNS:api.zotero.org,IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' }
  )
  fs.chmodSync(keyPath, 0o600)
  const certificate = fs.readFileSync(certPath)
  const tlsOptions = { key: fs.readFileSync(keyPath), cert: certificate }
  /** @type {{url: string | undefined, headers: http.IncomingHttpHeaders}[]} */
  const requests = []
  /** @type {Set<net.Socket>} */
  const sockets = new Set()
  /** @type {Set<net.Socket>} */
  const tunnels = new Set()
  /** @type {Set<net.Socket>} */
  const ended = new Set()
  /** @type {http.IncomingHttpHeaders[]} */
  const connects = []
  const target = https.createServer(tlsOptions, (request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'https://codeload.github.com/final' })
      response.end()
    } else if (request.url === '/forbidden-redirect') {
      response.writeHead(302, {
        Location: 'https://unapproved.invalid/private',
      })
      response.end()
    } else if (request.url === '/body-stall') {
      response.writeHead(200)
      response.write('incomplete')
    } else {
      response.end(
        json
          ? JSON.stringify({ login: 'synthetic-provider-user' })
          : 'proxied-response'
      )
    }
  })
  const targetPort = await listen(target)
  const proxy = secureProxy
    ? https.createServer(tlsOptions)
    : http.createServer()
  proxy.on('connect', (request, socket, head) => {
    assert.ok(socket instanceof net.Socket)
    tunnels.add(socket)
    socket.once('close', () => tunnels.delete(socket))
    connects.push(request.headers)
    if (stalledConnect) {
      // Upgraded HTTP sockets are half-open: observe the client's actual FIN
      // before completing the proxy side, rather than hiding a leaked client.
      socket.once('end', () => {
        ended.add(socket)
        socket.end()
      })
      socket.resume()
    } else if (deniedConnect) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 6\r\n\r\ndenied'
      )
    } else {
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      sockets.add(upstream)
      upstream.once('close', () => sockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    }
  })
  for (const server of [target, proxy]) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  }
  const proxyPort = await listen(proxy)
  return {
    origin: `${secureProxy ? 'https' : 'http'}://127.0.0.1:${proxyPort}`,
    certificate,
    requests,
    connects,
    tunnels,
    sockets,
    ended,
    async close() {
      for (const socket of sockets) socket.destroy()
      for (const socket of tunnels) socket.destroy()
      await Promise.all(
        [target, proxy].map(
          server =>
            new Promise((resolve, reject) => {
              server.close(error =>
                error ? reject(error) : resolve(undefined)
              )
            })
        )
      )
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Trust only this test's generated certificate. Production never changes CA or
 * rejectUnauthorized. The wrapper also prevents a broken agent selector from
 * accidentally opening a direct connection during a failing test.
 * @param {NonNullable<Parameters<typeof fetchString>[1]>} options
 * @param {Buffer} certificate
 * @param {boolean} [trust]
 * @returns {NonNullable<Parameters<typeof fetchString>[1]>}
 */
function fixtureTrust(options, certificate, trust = true) {
  const select = options.agent
  assert.ok(
    typeof select === 'function',
    'configured provider must use a proxy selector'
  )
  return {
    ...options,
    agent: url => {
      const agent = select(url)
      assert.ok(agent instanceof HttpsProxyAgent)
      if (trust) {
        agent.options.ca = certificate
        agent.connectOpts.ca = certificate
      }
      return agent
    },
  }
}

describe('provider-only HTTPS options', () => {
  it('returns the identical options and transport when unset', async () => {
    const apply = await helper(undefined)
    const agent = new https.Agent()
    const options = { headers: { Authorization: 'synthetic' }, agent }
    assert.equal(apply('github', 'http://legacy.invalid/', options), options)
    assert.equal(options.agent, agent)
  })

  it.each([
    'http://user:password@127.0.0.1:9',
    'http://127.0.0.1:9/path',
    'http://127.0.0.1:9?query',
    'http://127.0.0.1:9#hash',
    'file:///tmp/proxy',
    'not-an-origin',
  ])(
    'refuses malformed proxy configuration without echoing it',
    async proxy => {
      const apply = await helper(proxy)
      assert.throws(
        () =>
          apply('github', 'https://api.github.com/', {
            signal: AbortSignal.timeout(100),
          }),
        error =>
          error instanceof Error &&
          error.message === 'Invalid provider HTTPS proxy configuration'
      )
    }
  )

  it.each([
    'http://api.github.com/',
    'https://api.github.com:444/',
    'https://secret@api.github.com/',
    'https://api.github.com.evil.invalid/',
    'https://127.0.0.1/',
    'https://www.zotero.org/',
  ])('refuses an unapproved initial GitHub destination', async url => {
    const apply = await helper('http://127.0.0.1:9')
    assert.throws(
      () => apply('github', url, { signal: AbortSignal.timeout(100) }),
      error =>
        error instanceof Error &&
        error.message === 'Provider HTTPS destination refused'
    )
  })
})

describe('per-request proxy ownership', () => {
  it('requires existing cancellation rather than creating an unbounded CONNECT', async () => {
    const apply = await helper('http://127.0.0.1:9')
    assert.throws(
      () => apply('github', 'https://api.github.com/', {}),
      error =>
        error instanceof Error &&
        error.message === 'Provider HTTPS request requires an AbortSignal'
    )
  })

  it('shares a request deadline across redirects but never across requests', async () => {
    const apply = await helper('http://127.0.0.1:9')
    const first = apply('github', 'https://api.github.com/', {
      signal: new AbortController().signal,
    })
    const second = apply('github', 'https://api.github.com/', {
      signal: new AbortController().signal,
    })
    assert.ok(
      typeof first.agent === 'function' && typeof second.agent === 'function'
    )
    const firstAgent = first.agent(new URL('https://api.github.com/'))
    assert.equal(
      firstAgent,
      first.agent(new URL('https://codeload.github.com/'))
    )
    assert.notEqual(
      firstAgent,
      second.agent(new URL('https://api.github.com/'))
    )
  })
})

describe('real bounded CONNECT transport', () => {
  it.each([false, true])(
    'uses an actual %s secure proxy without exposing target credentials to CONNECT',
    async secureProxy => {
      const local = await fixture({ secureProxy })
      try {
        const apply = await helper(local.origin)
        const options = apply('github', 'https://api.github.com/', {
          headers: { Authorization: 'synthetic-origin-credential' },
          signal: AbortSignal.timeout(1000),
        })
        assert.equal(
          await fetchString(
            'https://api.github.com/',
            fixtureTrust(options, local.certificate)
          ),
          'proxied-response'
        )
        assert.equal(
          local.requests[0]?.headers.authorization,
          'synthetic-origin-credential'
        )
        assert.equal(local.connects.length, 1)
        assert.equal(local.connects[0]?.authorization, undefined)
        assert.equal(local.connects[0]?.['proxy-authorization'], undefined)
        assert.deepEqual(directLookups, [])
      } finally {
        await local.close()
      }
    }
  )

  it('validates allowed and refused redirects before a second connection', async () => {
    const local = await fixture()
    try {
      const apply = await helper(local.origin)
      const options = apply('github', 'https://api.github.com/redirect', {
        signal: AbortSignal.timeout(1000),
      })
      assert.equal(
        await fetchString(
          'https://api.github.com/redirect',
          fixtureTrust(options, local.certificate)
        ),
        'proxied-response'
      )
      assert.equal(local.connects.length, 2)
      const blocked = apply(
        'github',
        'https://api.github.com/forbidden-redirect',
        { signal: AbortSignal.timeout(1000) }
      )
      await assert.rejects(
        fetchString(
          'https://api.github.com/forbidden-redirect',
          fixtureTrust(blocked, local.certificate)
        )
      )
      assert.equal(local.connects.length, 3)
      assert.deepEqual(directLookups, [])
    } finally {
      await local.close()
    }
  })

  it.each([false, true])(
    'preserves certificate verification for target and secure proxy %s',
    async secureProxy => {
      const local = await fixture({ secureProxy })
      try {
        const apply = await helper(local.origin)
        const options = apply('github', 'https://api.github.com/', {
          signal: AbortSignal.timeout(1000),
        })
        await assert.rejects(
          fetchString(
            'https://api.github.com/',
            fixtureTrust(options, local.certificate, false)
          )
        )
        assert.equal(local.requests.length, 0)
        assert.equal(local.connects.length, secureProxy ? 0 : 1)
        assert.deepEqual(directLookups, [])
      } finally {
        await local.close()
      }
    }
  )

  it('verifies the allowed destination hostname even with a trusted fixture CA', async () => {
    const local = await fixture()
    try {
      const apply = await helper(local.origin)
      const options = apply('zotero', 'https://www.zotero.org/', {
        signal: AbortSignal.timeout(1000),
      })
      await assert.rejects(
        fetchString(
          'https://www.zotero.org/',
          fixtureTrust(options, local.certificate)
        )
      )
      assert.equal(local.requests.length, 0)
      assert.equal(local.connects.length, 1)
      assert.deepEqual(directLookups, [])
    } finally {
      await local.close()
    }
  })

  it('never falls back to a direct connection after a refused CONNECT', async () => {
    const local = await fixture({ deniedConnect: true })
    try {
      const apply = await helper(local.origin)
      const options = apply('github', 'https://api.github.com/', {
        signal: AbortSignal.timeout(1000),
      })
      await assert.rejects(
        fetchString(
          'https://api.github.com/',
          fixtureTrust(options, local.certificate)
        )
      )
      assert.equal(local.requests.length, 0)
      assert.equal(local.connects.length, 1)
      assert.deepEqual(directLookups, [])
    } finally {
      await local.close()
    }
  })

  it('reaps the actual pending CONNECT socket when the request is cancelled', async () => {
    const local = await fixture({ stalledConnect: true })
    try {
      const apply = await helper(local.origin)
      const controller = new AbortController()
      const options = apply('github', 'https://api.github.com/', {
        signal: controller.signal,
      })
      const request = fetchString(
        'https://api.github.com/',
        fixtureTrust(options, local.certificate)
      )
      request.catch(() => {})
      await until(() => local.connects.length === 1)
      controller.abort()
      await assert.rejects(request)
      await until(
        () =>
          local.ended.size === 1 &&
          local.tunnels.size === 0 &&
          local.sockets.size === 0
      )
      assert.deepEqual(directLookups, [])
    } finally {
      await local.close()
    }
  })

  it('cancels a stalled body after CONNECT and TLS completion', async () => {
    const local = await fixture()
    try {
      const apply = await helper(local.origin)
      const controller = new AbortController()
      const options = apply('github', 'https://api.github.com/body-stall', {
        signal: controller.signal,
      })
      const request = fetchString(
        'https://api.github.com/body-stall',
        fixtureTrust(options, local.certificate)
      )
      request.catch(() => {})
      await until(() => local.requests.length === 1)
      controller.abort()
      await assert.rejects(request)
      await until(() => local.tunnels.size === 0 && local.sockets.size === 0)
      assert.deepEqual(directLookups, [])
    } finally {
      await local.close()
    }
  })
})

describe('actual provider client wiring', () => {
  it.each(['github', 'zotero'])(
    'sends the configured %s client through the real tunnel',
    async provider => {
      const local = await fixture({ json: true })
      try {
        await helper(local.origin)
        /** @type {typeof import('@overleaf/fetch-utils')} */
        const actual = await vi.importActual('@overleaf/fetch-utils')
        /** @param {Parameters<typeof actual.fetchJson>[0]} url @param {NonNullable<Parameters<typeof actual.fetchJson>[1]>} options */
        function trustedJson(url, options) {
          return actual.fetchJson(url, fixtureTrust(options, local.certificate))
        }
        vi.doMock('@overleaf/fetch-utils', () => ({
          ...actual,
          fetchJson: trustedJson,
        }))
        if (provider === 'github') {
          const client = (
            await import('../../../../modules/github-sync/app/src/GitHubApiClient.mjs')
          ).default
          const result = await client.getUser('synthetic-provider-credential')
          assert.equal(result.login, 'synthetic-provider-user')
          assert.equal(
            local.requests[0]?.headers.authorization,
            'Bearer synthetic-provider-credential'
          )
        } else {
          vi.doMock(
            '../../../../modules/zotero/app/src/TokenManager.mjs',
            () => ({
              default: {
                getCredentials: async () => ({
                  apiKey: 'synthetic-provider-credential',
                  zoteroUserId: '123',
                }),
              },
            })
          )
          vi.doMock('../../../../app/src/models/User.mjs', () => ({ User: {} }))
          const client = (
            await import('../../../../modules/zotero/app/src/ZoteroApiClient.mjs')
          ).default
          assert.equal(await client.getConnectionStatus('synthetic-user'), true)
          assert.equal(
            local.requests[0]?.headers['zotero-api-key'],
            'synthetic-provider-credential'
          )
        }
        assert.equal(local.connects.length, 1)
        assert.equal(local.connects[0]?.authorization, undefined)
        assert.deepEqual(directLookups, [])
      } finally {
        vi.doUnmock('@overleaf/fetch-utils')
        vi.doUnmock('../../../../modules/zotero/app/src/TokenManager.mjs')
        vi.doUnmock('../../../../app/src/models/User.mjs')
        await local.close()
      }
    }
  )
})
