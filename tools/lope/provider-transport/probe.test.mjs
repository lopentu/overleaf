// @ts-check
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import { test } from 'node:test'
import tls from 'node:tls'
import vm from 'node:vm'

import { PROXY, endpoint, probeProviders } from './probe.mjs'

const agentSource = await readFile(
  new URL(
    '../../../services/web/app/src/Features/Integrations/ProviderHttpsAgent.mjs',
    import.meta.url
  ),
  'utf8'
)
const settingsModule = new vm.SyntheticModule(['default'], function () {
  this.setExport('default', { providerHttpsProxy: PROXY })
})
const dependency = new vm.SyntheticModule(['HttpsProxyAgent'], function () {
  this.setExport('HttpsProxyAgent', https.Agent)
})
const agent = new vm.SourceTextModule(agentSource)
await agent.link(specifier => {
  if (specifier === '@overleaf/settings') return settingsModule
  if (specifier === 'https-proxy-agent') return dependency
  throw new Error('unexpected fixture dependency')
})
await agent.evaluate()
const { withProviderHttpsAgent } =
  /** @type {{withProviderHttpsAgent: Parameters<typeof probeProviders>[0]}} */ (
    agent.namespace
  )

class SocketDouble extends net.Socket {
  destroy() {
    this.emit('close')
    return this
  }
}

class RequestDouble extends EventEmitter {
  /** @param {() => void} end */
  constructor(end) {
    super()
    this.end = end
  }

  destroy() {}
}

/** @typedef {{direct?: boolean, doubleDial?: boolean, stalled?: boolean, tlsHost?: string, tlsBeforeFailure?: boolean, mismatchAlreadyAuthorized?: boolean, failure?: string}} FixtureOptions */
/** @typedef {{checkServerIdentity?: (host: string, certificate: {subjectaltname: string}) => Error | undefined}} TlsFixtureOptions */
/** @typedef {{socket: tls.TLSSocket, statusCode: number, destroy: () => void}} ResponseDouble */
/** @typedef {{request: (url: URL, options: TlsFixtureOptions, respond: (response: ResponseDouble) => void) => RequestDouble}} HttpsFixture */

/** @param {import('node:test').TestContext} t @param {FixtureOptions} options */
function transport(t, options = {}) {
  const endpoint = new URL(PROXY)
  const realConnect = net.Socket.prototype.connect
  let forwarded = 0
  let requests = 0
  const rawConnect = t.mock.method(
    net.Socket.prototype,
    'connect',
    /** @this {net.Socket} */
    function () {
      forwarded++
      return this
    }
  )
  const httpsFixture = /** @type {HttpsFixture} */ (
    /** @type {unknown} */ (https)
  )
  /** @type {HttpsFixture['request']} */
  const requestDouble = (url, init, onResponse) => {
    requests++
    const request = new RequestDouble(() => {
      try {
        new SocketDouble().connect({
          host: endpoint.hostname,
          port: Number(endpoint.port),
        })
        if (options.direct) {
          new SocketDouble().connect({
            host: 'direct.invalid',
            port: 443,
          })
        }
        if (options.doubleDial) {
          new SocketDouble().connect({
            host: endpoint.hostname,
            port: Number(endpoint.port),
          })
        }
      } catch (error) {
        request.emit('error', error)
        return
      }
      if (options.stalled) return
      const tlsSocket = /** @type {tls.TLSSocket} */ (
        Object.create(tls.TLSSocket.prototype, {
          authorized: { value: true },
          servername: {
            value: options.tlsHost ?? url.hostname,
            configurable: true,
          },
          getProtocol: { value: () => 'TLSv1.3' },
        })
      )
      if (options.tlsBeforeFailure) request.emit('socket', tlsSocket)
      if (options.failure) {
        request.emit(
          'error',
          Object.assign(new Error('private diagnostic'), {
            code: options.failure,
          })
        )
        return
      }
      const tlsError = init.checkServerIdentity?.(url.hostname, {
        subjectaltname: `DNS:${url.hostname}`,
      })
      if (tlsError) {
        if (options.mismatchAlreadyAuthorized) {
          Object.defineProperty(tlsSocket, 'servername', {
            value: 'different.invalid',
          })
          request.emit('socket', tlsSocket)
        }
        request.emit('error', tlsError)
        return
      }
      onResponse({
        socket: tlsSocket,
        statusCode: 404,
        destroy() {},
      })
    })
    return request
  }
  t.mock.method(httpsFixture, 'request', requestDouble)
  return {
    snapshot: () => ({ forwarded, requests }),
    originalRestored: () =>
      net.Socket.prototype.connect === rawConnect && rawConnect !== realConnect,
  }
}

test('connected matrix checks five real-agent selections and pre-dial denials without exposing request data', async t => {
  const fixture = transport(t)
  const result = await probeProviders(withProviderHttpsAgent, 'connected')
  assert.equal(result.passed, true)
  assert.equal(result.mode, 'connected')
  const allowed = result.cases.filter(row => row.expectation === 'allow')
  const refused = result.cases.filter(
    row => row.expectation === 'deny-destination'
  )
  assert.equal(allowed.length, 5)
  assert.deepEqual(
    refused.map(row => row.case),
    [
      'denied-host',
      'foreign-provider-host',
      'literal-ipv4',
      'literal-ipv6',
      'denied-port',
      'denied-scheme',
      'denied-redirect',
    ]
  )
  const [mismatch] = result.cases.filter(row => row.expectation === 'deny-tls')
  assert.equal(mismatch?.code, 'tls-identity-refused')
  assert.equal(mismatch?.proxy_connection_attempts, 1)
  assert.equal(mismatch?.tls_authorized, false)
  assert.ok(
    allowed.every(
      row =>
        row.http_status === 404 &&
        row.tls_authorized &&
        row.proxy_connection_attempts === 1
    )
  )
  assert.ok(
    refused.every(
      row =>
        row.proxy_connection_attempts === 0 &&
        row.direct_connection_attempts === 0
    )
  )
  assert.deepEqual(fixture.snapshot(), { forwarded: 6, requests: 6 })
  assert.ok(fixture.originalRestored())
  assert.ok(result.cases.every(row => row.sockets_closed))
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|private diagnostic/)
})

test('only actual Node host and legitimate normalized or positional inputs count as proxy dials', () => {
  const expected = { host: '192.168.224.5', port: 3128 }
  const nativeNet =
    /** @type {{_normalizeArgs: (args: unknown[]) => unknown[]}} */ (
      /** @type {unknown} */ (net)
    )
  assert.deepEqual(endpoint([3128, expected.host]), expected)
  assert.deepEqual(endpoint([{ ...expected }]), expected)
  assert.deepEqual(
    endpoint([nativeNet._normalizeArgs([{ ...expected }])]),
    expected
  )
  assert.equal(
    endpoint([{ hostname: expected.host, port: expected.port }]),
    undefined
  )
  assert.equal(endpoint([[{ ...expected }, null]]), undefined)
  assert.equal(
    endpoint([{ ...expected, path: '/tmp/synthetic.sock' }]),
    undefined
  )
})

test('any authorized TLS invalidates outage and mismatch even with a different host', async t => {
  transport(t, {
    failure: 'ECONNRESET',
    tlsBeforeFailure: true,
    tlsHost: 'different.invalid',
  })
  let result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].tls_authorized, true)
  assert.equal(result.cases[0].tls_expected_host, false)
  t.mock.restoreAll()

  transport(t, { mismatchAlreadyAuthorized: true })
  result = await probeProviders(withProviderHttpsAgent, 'connected')
  const mismatch = result.cases.find(row => row.expectation === 'deny-tls')
  assert.equal(result.passed, false)
  assert.equal(mismatch?.code, 'unexpected-connected')
  assert.equal(mismatch?.tls_authorized, true)
  assert.equal(mismatch?.tls_expected_host, false)
})

test('outage refuses an authorized TLS tunnel that closes before HTTP headers', async t => {
  transport(t, { failure: 'ECONNRESET', tlsBeforeFailure: true })
  const result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'unexpected-connected')
  assert.equal(result.cases[0].tls_authorized, true)
})

test('the independent request deadline settles a hung callback and closes the admitted socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = transport(t, { stalled: true })
  const run = probeProviders(withProviderHttpsAgent, 'connected')
  t.mock.timers.tick(8000)
  const result = await run
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'deadline')
  assert.equal(result.cases[0].sockets_closed, true)
  assert.ok(fixture.originalRestored())
})

test('outage requires a single failed proxy dial, no successful TLS, and closed sockets for each provider host', async t => {
  const fixture = transport(t, { failure: 'ECONNREFUSED' })
  const result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, true)
  assert.equal(result.mode, 'outage')
  assert.equal(result.cases.length, 5)
  assert.ok(
    result.cases.every(
      row =>
        row.code === 'proxy-unavailable' &&
        row.http_status === 0 &&
        row.proxy_connection_attempts === 1 &&
        row.sockets_closed
    )
  )
  assert.deepEqual(fixture.snapshot(), { forwarded: 5, requests: 5 })
  assert.ok(fixture.originalRestored())
})

test('outage does not pass on a successful request or an unrelated request error', async t => {
  let fixture = transport(t)
  let result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'unexpected-connected')
  assert.ok(fixture.originalRestored())
  t.mock.restoreAll()

  fixture = transport(t, { failure: 'ERR_INVALID_ARG_TYPE' })
  result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'request-failed')
  assert.ok(fixture.originalRestored())
})

test('a direct attempt or duplicate proxy dial invalidates the receipt', async t => {
  let fixture = transport(t, { direct: true })
  let result = await probeProviders(withProviderHttpsAgent, 'outage')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'direct-attempt-refused')
  assert.equal(result.cases[0].direct_connection_attempts, 1)
  assert.equal(result.cases[0].proxy_connection_attempts, 1)
  assert.equal(result.cases[0].sockets_closed, true)
  assert.equal(fixture.snapshot().forwarded, 1)
  t.mock.restoreAll()

  fixture = transport(t, { doubleDial: true })
  result = await probeProviders(withProviderHttpsAgent, 'connected')
  assert.equal(result.passed, false)
  assert.equal(result.cases[0].code, 'proxy-count-invalid')
  assert.equal(result.cases[0].proxy_connection_attempts, 2)
  assert.ok(fixture.originalRestored())
})

test('missing application enforcement and an invalid phase both refuse', async t => {
  transport(t)
  const result = await probeProviders(
    (_provider, _url, opts) => ({ ...opts, agent: () => new https.Agent() }),
    'connected'
  )
  assert.equal(result.passed, false)
  assert.equal(
    result.cases.find(row => row.case === 'denied-host')?.code,
    'destination-not-refused'
  )
  await assert.rejects(probeProviders(withProviderHttpsAgent, 'other'), /phase/)
})
