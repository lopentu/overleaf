/** The existing UrlFetcher/HistoryResourceWriter URL construction, shared with
 * the explicit fresh-source port. No new origin/authentication policy. */
export function resolveSourceDownloadUrls(
  url: string,
  fallbackURL: string | undefined,
  override: string | undefined,
  perfHost: string | undefined
): { primary: string; fallback: string | undefined } {
  function resolve(value: string): string {
    const parsed = new URL(value)
    return override && parsed.host !== perfHost
      ? `${override}${parsed.pathname}${parsed.search}`
      : value
  }
  return {
    primary: resolve(url),
    fallback: fallbackURL ? resolve(fallbackURL) : undefined,
  }
}
export interface HistoryBlobContext {
  readonly historyId: string | undefined
  readonly globalBlobs: readonly string[]
  readonly filestoreBlobPrefix: string | undefined
  readonly clsiPerfVariant: string | undefined
}
export function historySourceBlobUrl(
  base: string,
  perfHost: string,
  hash: string,
  context: HistoryBlobContext
): URL {
  const url = new URL(base)
  if (context.filestoreBlobPrefix)
    url.pathname = `${context.filestoreBlobPrefix}/${hash}`
  else if (context.clsiPerfVariant) {
    url.host = perfHost
    url.pathname = `/variant/${context.clsiPerfVariant}/hash/${hash}`
  } else if (context.globalBlobs.includes(hash))
    url.pathname = `/history/global/hash/${hash}`
  else url.pathname = `/history/project/${context.historyId}/hash/${hash}`
  return url
}

export interface IsolatedFilestoreBridge {
  readonly sourceOrigin: string
  /** The worker-local proxy owns authentication to the upstream filestore. */
  readonly proxyOrigin: string
}

export interface SourceDownloadPolicy {
  readonly sourceOrigin: string | undefined
  resolve(url: string): string
}

const rawBlobPath =
  /^\/history\/(?:global|project\/(?:[0-9a-f]{24}|[1-9][0-9]{0,9}))\/hash\/[0-9a-f]{40}$/

function httpOrigin(value: string): URL {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && value === url.origin)
      return url
  } catch {
    // Do not relay malformed configuration values.
  }
  throw new Error('ISOLATED_FILESTORE_BRIDGE_INVALID')
}

export function createIsolatedSourceDownloadPolicy(
  bridge?: IsolatedFilestoreBridge
): SourceDownloadPolicy {
  const direct = bridge && httpOrigin(bridge.sourceOrigin)
  const proxy = bridge && httpOrigin(bridge.proxyOrigin)
  if (proxy && !['127.0.0.1', '[::1]'].includes(proxy.hostname))
    throw new Error('ISOLATED_FILESTORE_BRIDGE_INVALID')
  const sourceOrigin = direct?.origin
  return Object.freeze({
    sourceOrigin,
    resolve(url: string) {
      if (
        sourceOrigin === undefined ||
        !proxy ||
        !url.startsWith(sourceOrigin + '/')
      )
        throw new Error('ISOLATED_FILESTORE_SOURCE_DENIED')
      // Match the raw spelling to refuse URL normalization, credentials and queries.
      const pathname = url.slice(sourceOrigin.length)
      if (rawBlobPath.exec(pathname)?.[0] !== pathname)
        throw new Error('ISOLATED_FILESTORE_SOURCE_DENIED')
      return new URL(pathname, proxy).href
    },
  })
}
