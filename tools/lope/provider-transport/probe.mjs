// @ts-check
import { Agent } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'

export const PROXY = 'http://192.168.224.5:3128'

/** @typedef {'github' | 'zotero'} Provider */
/** @typedef {'allow' | 'deny-destination' | 'deny-tls' | 'outage'} Expectation */
/** @typedef {{name: string, provider: Provider, host: string}} ProviderCase */
/** @typedef {{name: string, provider: Provider, url: string, redirect?: boolean}} DeniedCase */
/** @typedef {(provider: Provider, url: URL, options: {signal: AbortSignal}) => {agent?: unknown}} ApplyTransport */
/** @typedef {{code: string, status: number, authorized: boolean, expectedHost: boolean, protocol: string}} Outcome */

/** @type {readonly ProviderCase[]} */
export const CASES = Object.freeze([
  { name: 'github-root', provider: 'github', host: 'github.com' },
  { name: 'github-api', provider: 'github', host: 'api.github.com' },
  { name: 'github-code', provider: 'github', host: 'codeload.github.com' },
  { name: 'zotero-root', provider: 'zotero', host: 'www.zotero.org' },
  { name: 'zotero-api', provider: 'zotero', host: 'api.zotero.org' },
])

/** @type {readonly DeniedCase[]} */
const DENIED = Object.freeze([
  { name: 'denied-host', provider: 'github', url: 'https://example.invalid/' },
  {
    name: 'foreign-provider-host',
    provider: 'zotero',
    url: 'https://api.github.com/',
  },
  { name: 'literal-ipv4', provider: 'github', url: 'https://192.0.2.1/' },
  { name: 'literal-ipv6', provider: 'zotero', url: 'https://[2001:db8::1]/' },
  { name: 'denied-port', provider: 'github', url: 'https://github.com:444/' },
  { name: 'denied-scheme', provider: 'zotero', url: 'http://www.zotero.org/' },
  {
    name: 'denied-redirect',
    provider: 'github',
    url: 'https://example.invalid/',
    redirect: true,
  },
])

const PROXY_UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
])

// Node 24 Socket.connect treats only its marked arrays as normalized. The
// actual proxy agent uses net.connect(), which supplies exactly this form.
const { _normalizeArgs: normalizeSocketArgs } =
  /** @type {{_normalizeArgs?: (args: unknown[]) => unknown[]}} */ (
    /** @type {unknown} */ (net)
  )
const markers = normalizeSocketArgs
  ? Object.getOwnPropertySymbols(normalizeSocketArgs([]))
  : []
const normalizedMarker = markers.length === 1 ? markers[0] : undefined

/** @param {unknown[]} args */
export function endpoint(args) {
  if (!normalizeSocketArgs || !normalizedMarker) return undefined
  const first = args[0]
  if (
    Array.isArray(first) &&
    (args.length !== 1 ||
      first.length !== 2 ||
      Object.getOwnPropertyDescriptor(first, normalizedMarker)?.value !== true)
  ) {
    return undefined
  }
  const normalized = Array.isArray(first) ? first : normalizeSocketArgs(args)
  const options = normalized[0]
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    'path' in options
  )
    return undefined
  // Node uses options.host || 'localhost'. It does not honor hostname here.
  const host = Object.getOwnPropertyDescriptor(options, 'host')?.value
  const port = Object.getOwnPropertyDescriptor(options, 'port')?.value
  if (
    typeof host !== 'string' ||
    !host ||
    (typeof port !== 'number' &&
      !(typeof port === 'string' && /^\d{1,5}$/.test(port)))
  ) {
    return undefined
  }
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)
    return undefined
  return { host, port: numericPort }
}

/**
 * Disposable process only. A disallowed dial is counted and blocked at this
 * boundary. An admitted dial uses the original operation and socket.
 * @param {string} name
 * @param {Expectation} expectation
 * @param {() => Outcome | Promise<Outcome>} probe
 */
async function inspect(name, expectation, probe) {
  const started = performance.now()
  const original = net.Socket.prototype.connect
  const proxy = new URL(PROXY)
  /** @type {Set<net.Socket>} */
  const sockets = new Set()
  let proxyAttempts = 0
  let directAttempts = 0
  let unknownAttempts = 0
  net.Socket.prototype.connect = /** @type {typeof original} */ (
    /** @this {net.Socket} @param {...unknown} args */
    function (...args) {
      const target = endpoint(args)
      if (!target) {
        unknownAttempts++
        throw new Error('Probe connection form refused')
      }
      if (
        target.host !== proxy.hostname ||
        target.port !== Number(proxy.port)
      ) {
        directAttempts++
        throw new Error('Probe direct connection refused')
      }
      proxyAttempts++
      sockets.add(this)
      this.once('close', () => sockets.delete(this))
      return Reflect.apply(original, this, args)
    }
  )

  let outcome
  try {
    outcome = await probe()
  } finally {
    try {
      for (const socket of sockets) socket.destroy()
      const closeDeadline = performance.now() + 500
      while (sockets.size && performance.now() < closeDeadline) await delay(5)
    } finally {
      net.Socket.prototype.connect = original
    }
  }

  const closed = sockets.size === 0
  const expectedCode = {
    allow: 'ok',
    'deny-destination': 'destination-refused',
    'deny-tls': 'tls-identity-refused',
    outage: 'proxy-unavailable',
  }[expectation]
  const expectedProxyAttempts = expectation === 'deny-destination' ? 0 : 1
  const boundaryCode =
    directAttempts > 0
      ? 'direct-attempt-refused'
      : unknownAttempts > 0
        ? 'unknown-dial-refused'
        : !closed
          ? 'sockets-not-closed'
          : proxyAttempts !== expectedProxyAttempts
            ? 'proxy-count-invalid'
            : ''
  const code = boundaryCode || outcome.code
  return {
    case: name,
    expectation,
    passed: boundaryCode === '' && outcome.code === expectedCode,
    code,
    http_status: outcome.status,
    tls_authorized: outcome.authorized,
    tls_expected_host: outcome.expectedHost,
    tls_protocol: outcome.protocol,
    proxy_connection_attempts: proxyAttempts,
    direct_connection_attempts: directAttempts,
    unknown_connection_attempts: unknownAttempts,
    sockets_closed: closed,
    duration_ms: Math.ceil(performance.now() - started),
  }
}

/** @param {unknown} value */
function requireAgent(value) {
  if (!(value instanceof Agent))
    throw new Error('Probe proxy agent unavailable')
  return value
}

/** @param {ApplyTransport} apply @param {DeniedCase} item @returns {Outcome} */
function destinationDenial(apply, item) {
  const controller = new AbortController()
  const destination = new URL(item.url)
  let code = 'destination-not-refused'
  /** @type {Agent | undefined} */
  let agent
  try {
    if (item.redirect) {
      const origin = new URL('https://github.com/')
      const options = apply(item.provider, origin, {
        signal: controller.signal,
      })
      if (typeof options.agent !== 'function')
        throw new Error('Probe redirect guard unavailable')
      agent = requireAgent(options.agent(origin))
      options.agent(destination)
    } else {
      apply(item.provider, destination, { signal: controller.signal })
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Provider HTTPS destination refused'
    ) {
      code = 'destination-refused'
    } else {
      code = 'request-failed'
    }
  } finally {
    controller.abort()
    agent?.destroy()
  }
  return {
    code,
    status: 0,
    authorized: false,
    expectedHost: false,
    protocol: '',
  }
}

/** @param {ApplyTransport} apply @param {ProviderCase} item @param {'allow' | 'deny-tls' | 'outage'} expectation @returns {Promise<Outcome>} */
async function requestProvider(apply, item, expectation) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 8000)
  const deadlineError = new Error('Probe deadline expired')
  /** @type {Agent | undefined} */
  let agent
  /** @type {import('node:http').ClientRequest | undefined} */
  let request
  let status = 0
  let authorized = false
  let expectedHost = false
  let protocol = ''
  let provedMismatch = false

  /** @param {net.Socket} socket */
  function recordTls(socket) {
    if (!(socket instanceof tls.TLSSocket) || !socket.authorized) return
    authorized = true
    if (socket.servername === item.host) expectedHost = true
    const version = socket.getProtocol()
    protocol = version === 'TLSv1.2' || version === 'TLSv1.3' ? version : ''
  }

  /** @type {NonNullable<import('node:tls').ConnectionOptions['checkServerIdentity']>} */
  function checkMismatchedIdentity(host, certificate) {
    const actualError = tls.checkServerIdentity(host, certificate)
    if (actualError) return actualError
    const mismatch = tls.checkServerIdentity(
      'provider-canary.invalid',
      certificate
    )
    provedMismatch =
      !!mismatch &&
      'code' in mismatch &&
      mismatch.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    return mismatch
  }

  let code = 'request-failed'
  try {
    const url = new URL(`https://${item.host}/`)
    const options = apply(item.provider, url, { signal: controller.signal })
    if (typeof options.agent !== 'function')
      throw new Error('Probe proxy missing')
    agent = requireAgent(options.agent(url))
    await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(deadlineError), {
        once: true,
      })
      request = https.request(
        url,
        {
          method: 'HEAD',
          headers: {
            'User-Agent': 'LOPE-credential-free-transport-probe',
            Connection: 'close',
          },
          agent,
          signal: controller.signal,
          rejectUnauthorized: true,
          maxHeaderSize: 8192,
          ...(expectation === 'deny-tls'
            ? { checkServerIdentity: checkMismatchedIdentity }
            : {}),
        },
        response => {
          status = response.statusCode ?? 0
          recordTls(response.socket)
          response.destroy()
          resolve(undefined)
        }
      )
      request.once('socket', socket => {
        recordTls(socket)
        if (socket instanceof tls.TLSSocket && !authorized) {
          socket.once('secureConnect', () => recordTls(socket))
        }
      })
      request.once('error', reject)
      request.end()
    })
    if (expectation !== 'allow') code = 'unexpected-connected'
    else if (!authorized || !expectedHost || !protocol)
      code = 'tls-validation-failed'
    else if (!Number.isInteger(status) || status < 100 || status > 599)
      code = 'status-invalid'
    else code = 'ok'
  } catch (error) {
    const failure =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : ''
    const timedOut =
      error === deadlineError ||
      (controller.signal.aborted && failure === 'ABORT_ERR')
    if (expectation !== 'allow' && authorized) {
      code = 'unexpected-connected'
    } else if (
      expectation === 'deny-tls' &&
      provedMismatch &&
      failure === 'ERR_TLS_CERT_ALTNAME_INVALID'
    ) {
      code = 'tls-identity-refused'
    } else if (
      expectation === 'outage' &&
      (PROXY_UNAVAILABLE.has(failure) || timedOut)
    ) {
      code = 'proxy-unavailable'
    } else if (timedOut) {
      code = 'deadline'
    }
  } finally {
    clearTimeout(deadline)
    controller.abort()
    request?.destroy()
    agent?.destroy()
  }
  return { code, status, authorized, expectedHost, protocol }
}

/** @param {ApplyTransport} apply @param {unknown} mode */
export async function probeProviders(apply, mode) {
  if (mode !== 'connected' && mode !== 'outage')
    throw new Error('Invalid probe phase')
  const cases = []
  const expectedCases =
    mode === 'connected' ? CASES.length + DENIED.length + 1 : CASES.length
  const requestExpectation = mode === 'connected' ? 'allow' : 'outage'

  for (const item of CASES) {
    const result = await inspect(item.name, requestExpectation, () =>
      requestProvider(apply, item, requestExpectation)
    )
    cases.push(result)
    if (!result.passed) break
  }

  if (mode === 'connected' && cases.every(item => item.passed)) {
    const item = CASES[0]
    cases.push(
      await inspect('mismatched-tls-identity', 'deny-tls', () =>
        requestProvider(apply, item, 'deny-tls')
      )
    )
    for (const denied of DENIED) {
      if (!cases.every(item => item.passed)) break
      cases.push(
        await inspect(denied.name, 'deny-destination', () =>
          destinationDenial(apply, denied)
        )
      )
    }
  }

  return {
    schema: 3,
    scope: 'credential-free-provider-CONNECT-TLS-only',
    mode,
    passed:
      cases.length === expectedCases && cases.every(value => value.passed),
    provider_feature_qualified: false,
    production_changed: false,
    cases,
  }
}
