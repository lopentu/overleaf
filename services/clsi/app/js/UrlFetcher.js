// @ts-check
import { resolveSourceDownloadUrls } from './SourceDownloadUrls.ts'
import { pipeBoundedSourceUrlToFileWithRetry } from './BoundedSourceDownload.ts'
import fs from 'node:fs'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { fetchStream, RequestFailedError } from '@overleaf/fetch-utils'
import { pipeline } from 'node:stream/promises'
import Metrics from '@overleaf/metrics'

/** @param {string} url
 * @param {string | undefined} fallbackURL
 * @param {string} filePath
 * @returns {Promise<void>} */
async function pipeUrlToFileWithRetry(url, fallbackURL, filePath) {
  let remainingAttempts = 3
  let lastErr
  while (remainingAttempts-- > 0) {
    const timer = new Metrics.Timer('url_fetcher', 1, {
      path: lastErr ? ' retry' : 'fetch',
    })
    try {
      await pipeUrlToFile(url, fallbackURL, filePath)
      timer.done({ status: 'success' })
      return
    } catch (err) {
      timer.done({ status: 'error' })
      logger.warn(
        { err, url, filePath, remainingAttempts },
        'error downloading url'
      )
      lastErr = err
    }
  }
  throw lastErr
}

/** @param {string} url
 * @param {string | undefined} fallbackURL
 * @param {string} filePath
 * @returns {Promise<void>} */
async function pipeUrlToFile(url, fallbackURL, filePath) {
  const resolved = resolveSourceDownloadUrls(
    url,
    fallbackURL,
    Settings.filestoreDomainOveride,
    Settings.apis.clsiPerf.host
  )
  url = resolved.primary
  fallbackURL = resolved.fallback

  let stream
  try {
    stream = await fetchStream(url, {
      signal: AbortSignal.timeout(60 * 1000),
    })
  } catch (err) {
    if (
      fallbackURL &&
      err instanceof RequestFailedError &&
      err.response.status === 404
    ) {
      stream = await fetchStream(fallbackURL, {
        signal: AbortSignal.timeout(60 * 1000),
      })
      url = fallbackURL
    } else {
      throw err
    }
  }

  const source = inferSource(url)
  if (source !== 'clsi-perf') {
    Metrics.inc('url_source', 1, { path: source })
  }

  const atomicWrite = filePath + '~'
  try {
    const output = fs.createWriteStream(atomicWrite)
    await pipeline(stream, output)
    await fs.promises.rename(atomicWrite, filePath)
    if (source !== 'clsi-perf') {
      Metrics.count('UrlFetcher.downloaded_bytes', output.bytesWritten, 1, {
        path: source,
      })
    }
  } catch (err) {
    try {
      await fs.promises.unlink(atomicWrite)
    } catch (e) {
      // Removal is best effort after the primary operation has already failed.
    }
    throw err
  }
}

const BUCKET_REGEX = /\/bucket\/([^/]+)\/key\//

/** @param {string} url
 * @returns {string} */
function inferSource(url) {
  if (url.includes(Settings.apis.clsiPerf.host)) {
    return 'clsi-perf'
  } else if (url.includes('/project/') && url.includes('/file/')) {
    return 'user-files'
  } else if (url.includes('/key/')) {
    const match = url.match(BUCKET_REGEX)
    if (match) return match[1]
  }
  return 'unknown'
}

export default {
  promises: {
    pipeUrlToFileWithRetry,
    pipeBoundedSourceUrlToFileWithRetry,
  },
}
