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
