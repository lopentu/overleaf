// @ts-check
import Settings from '@overleaf/settings'
import { HttpsProxyAgent } from 'https-proxy-agent'

/** @typedef {'github' | 'zotero'} Provider */
/** @typedef {NonNullable<Parameters<typeof import('@overleaf/fetch-utils').fetchJson>[1]>} RequestOptions */

const GITHUB_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
])
const ZOTERO_HOSTS = new Set(['www.zotero.org', 'api.zotero.org'])

/** @param {unknown} value */
function proxyOrigin(value) {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(value) ||
    /[\s\\@]/.test(value)
  ) {
    throw new Error('Invalid provider HTTPS proxy configuration')
  }
  let proxy
  try {
    proxy = new URL(value)
  } catch {
    throw new Error('Invalid provider HTTPS proxy configuration')
  }
  if (
    !['http:', 'https:'].includes(proxy.protocol) ||
    proxy.username ||
    proxy.password ||
    proxy.pathname !== '/' ||
    proxy.search ||
    proxy.hash ||
    proxy.port === '0'
  ) {
    throw new Error('Invalid provider HTTPS proxy configuration')
  }
  return proxy
}

/** @param {Provider} provider @param {string | {href: string}} value */
function requireDestination(provider, value) {
  let target
  try {
    // node-fetch v2 supplies a legacy parsed URL; both URL forms expose href.
    target = new URL(typeof value === 'string' ? value : value.href)
  } catch {
    throw new Error('Provider HTTPS destination refused')
  }
  const hosts =
    provider === 'github'
      ? GITHUB_HOSTS
      : provider === 'zotero'
        ? ZOTERO_HOSTS
        : undefined
  if (
    !hosts ||
    target.protocol !== 'https:' ||
    (target.port !== '' && target.port !== '443') ||
    target.username ||
    target.password ||
    !hosts.has(target.hostname)
  ) {
    throw new Error('Provider HTTPS destination refused')
  }
}

/**
 * Configure only the explicit provider request; internal/global fetch stays unchanged.
 * A per-request constructor signal also closes a pending async CONNECT socket,
 * which is not yet tracked by Agent.destroy(). Redirects share that deadline.
 * @param {Provider} provider
 * @param {string | URL} url
 * @param {RequestOptions} options
 * @returns {RequestOptions}
 */
export function withProviderHttpsAgent(provider, url, options) {
  const configured = Settings.providerHttpsProxy
  if (configured === undefined || configured === null || configured === '') {
    return options
  }
  const proxy = proxyOrigin(configured)
  requireDestination(provider, url)
  if (!(options.signal instanceof AbortSignal)) {
    throw new Error('Provider HTTPS request requires an AbortSignal')
  }
  const agent = new HttpsProxyAgent(proxy, { signal: options.signal })
  return {
    ...options,
    agent: redirectUrl => {
      requireDestination(provider, redirectUrl)
      return agent
    },
  }
}
