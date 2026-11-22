// @ts-check
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'
import { pathToFileURL } from 'node:url'

const DIRECTORY = '/overleaf/services/web'
const SCOPE = 'credential-free-provider-CONNECT-TLS-only'
const LIMIT = 8192
const PROVIDERS = [
  'github-root',
  'github-api',
  'github-code',
  'zotero-root',
  'zotero-api',
]
const DENIED = [
  'denied-host',
  'foreign-provider-host',
  'literal-ipv4',
  'literal-ipv6',
  'denied-port',
  'denied-scheme',
  'denied-redirect',
]
const CODES = new Set([
  'ok',
  'destination-not-refused',
  'destination-refused',
  'request-failed',
  'unexpected-connected',
  'tls-validation-failed',
  'status-invalid',
  'tls-identity-refused',
  'proxy-unavailable',
  'deadline',
  'direct-attempt-refused',
  'unknown-dial-refused',
  'sockets-not-closed',
  'proxy-count-invalid',
])
const RECEIPT_FIELDS = [
  'schema',
  'scope',
  'mode',
  'passed',
  'provider_feature_qualified',
  'production_changed',
  'cases',
]
const CASE_FIELDS = [
  'case',
  'expectation',
  'passed',
  'code',
  'http_status',
  'tls_authorized',
  'tls_expected_host',
  'tls_protocol',
  'proxy_connection_attempts',
  'direct_connection_attempts',
  'unknown_connection_attempts',
  'sockets_closed',
  'duration_ms',
]

const WORKER = `
  import {writeSync} from 'node:fs';
  const phase = process.argv[1];
  try {
    if (process.argv.length !== 2 || (phase !== 'connected' && phase !== 'outage')) {
      throw new Error('probe phase refused');
    }
    const {default: settings} = await import('@overleaf/settings');
    const {withProviderHttpsAgent} = await import('./app/src/Features/Integrations/ProviderHttpsAgent.mjs');
    const {PROXY, probeProviders} = await import('./probe.mjs');
    settings.providerHttpsProxy = PROXY;
    const receipt = await probeProviders(withProviderHttpsAgent, phase);
    writeSync(3, JSON.stringify(receipt) + '\\n');
    process.exitCode = receipt.passed ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
`

/** @typedef {'connected' | 'outage'} Phase */
/** @typedef {{argv: string[], execArgv: string[], execPath: string, cwd: string, env: NodeJS.ProcessEnv}} Invocation */
/** @typedef {Awaited<ReturnType<typeof import('./probe.mjs').probeProviders>>} ProbeReceipt */
/** @typedef {Pick<import('node:child_process').SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'output' | 'error'>} WorkerResult */
/** @typedef {(path: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithBufferEncoding) => WorkerResult} RunWorker */
/** @typedef {{passed: false, code: 'probe-launch-refused' | 'probe-worker-receipt-refused'}} Refusal */

/** @param {unknown} value @param {string[]} names @returns {value is Record<string, unknown>} */
function hasFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === names.length &&
    names.every(name => Object.hasOwn(value, name))
  )
}

/** @param {unknown} value @param {number} bound */
function count(value, bound) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= bound
  )
}

/** @param {unknown} value @param {string} name @param {string} expectation */
function validCase(value, name, expectation) {
  if (
    !hasFields(value, CASE_FIELDS) ||
    value.case !== name ||
    value.expectation !== expectation ||
    typeof value.passed !== 'boolean' ||
    typeof value.code !== 'string' ||
    !CODES.has(value.code) ||
    typeof value.tls_authorized !== 'boolean' ||
    typeof value.tls_expected_host !== 'boolean' ||
    (value.tls_expected_host && !value.tls_authorized) ||
    (value.tls_protocol !== '' &&
      value.tls_protocol !== 'TLSv1.2' &&
      value.tls_protocol !== 'TLSv1.3') ||
    typeof value.sockets_closed !== 'boolean' ||
    !count(value.http_status, 599) ||
    !count(value.proxy_connection_attempts, 128) ||
    !count(value.direct_connection_attempts, 128) ||
    !count(value.unknown_connection_attempts, 128) ||
    !count(value.duration_ms, 65_000)
  )
    return false
  if (!value.passed) return true
  if (
    !value.sockets_closed ||
    value.direct_connection_attempts !== 0 ||
    value.unknown_connection_attempts !== 0
  )
    return false
  if (expectation === 'allow') {
    return (
      value.proxy_connection_attempts === 1 &&
      value.code === 'ok' &&
      value.tls_authorized &&
      value.tls_expected_host &&
      value.tls_protocol !== '' &&
      typeof value.http_status === 'number' &&
      value.http_status >= 100
    )
  }
  if (value.tls_authorized || value.http_status !== 0) return false
  if (expectation === 'deny-destination') {
    return (
      value.proxy_connection_attempts === 0 &&
      value.code === 'destination-refused'
    )
  }
  const code =
    expectation === 'deny-tls' ? 'tls-identity-refused' : 'proxy-unavailable'
  return value.proxy_connection_attempts === 1 && value.code === code
}

/** @param {unknown} bytes @param {Phase} phase @param {number | null} status */
function parseReceipt(bytes, phase, status) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMIT)
    return undefined
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!/^\{[^\r\n]*\}\n$/.test(text)) return undefined
  const value = /** @type {unknown} */ (JSON.parse(text))
  if (
    JSON.stringify(value) + '\n' !== text ||
    !hasFields(value, RECEIPT_FIELDS) ||
    value.schema !== 3 ||
    value.scope !== SCOPE ||
    value.mode !== phase ||
    typeof value.passed !== 'boolean' ||
    value.provider_feature_qualified !== false ||
    value.production_changed !== false ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0 ||
    status !== (value.passed ? 0 : 1)
  )
    return undefined
  const names =
    phase === 'connected'
      ? [...PROVIDERS, 'mismatched-tls-identity', ...DENIED]
      : PROVIDERS
  if (
    value.cases.length > names.length ||
    (value.passed && value.cases.length !== names.length)
  )
    return undefined
  for (const [index, row] of value.cases.entries()) {
    const expectation =
      phase === 'outage'
        ? 'outage'
        : index < PROVIDERS.length
          ? 'allow'
          : index === PROVIDERS.length
            ? 'deny-tls'
            : 'deny-destination'
    if (
      !validCase(row, names[index], expectation) ||
      row.passed !== (value.passed || index < value.cases.length - 1)
    )
      return undefined
  }
  return /** @type {ProbeReceipt} */ (value)
}

/** @param {Invocation} invocation @param {RunWorker} [spawn] @returns {ProbeReceipt | Refusal} */
export function launchProbe(invocation, spawn = spawnSync) {
  const { argv, execArgv, execPath, cwd, env } = invocation
  const phase = argv[2]
  if (
    argv.length !== 3 ||
    argv[1] !== DIRECTORY + '/entry.mjs' ||
    (phase !== 'connected' && phase !== 'outage') ||
    cwd !== DIRECTORY ||
    !isAbsolute(execPath) ||
    execArgv.length !== 0 ||
    Object.keys(env).length !== 0
  )
    return { passed: false, code: 'probe-launch-refused' }

  try {
    const child = spawn(
      execPath,
      [
        '--require',
        '/overleaf/.pnp.cjs',
        '--import',
        '/overleaf/.pnp.register.mjs',
        '--input-type=module',
        '--eval',
        WORKER,
        phase,
      ],
      {
        cwd,
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        maxBuffer: LIMIT,
        timeout: 65000,
        killSignal: 'SIGKILL',
      }
    )
    if (!child.error && !child.signal) {
      const result = parseReceipt(child.output[3], phase, child.status)
      if (result) return result
    }
  } catch {
    // Diagnostics can include private paths. The external error stays fixed.
  }
  return { passed: false, code: 'probe-worker-receipt-refused' }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const result = launchProbe({
    argv: process.argv,
    execArgv: process.execArgv,
    execPath: process.execPath,
    cwd: process.cwd(),
    env: process.env,
  })
  console.log(JSON.stringify(result))
  process.exitCode = result.passed ? 0 : 1
}
