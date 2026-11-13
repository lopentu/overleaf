import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { Readable, Transform, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { fetchStream, RequestFailedError } from '@overleaf/fetch-utils'
import Settings from '@overleaf/settings'
import { createFileWriter } from './ArchiveFileIo.ts'
import { INPUT_LIMITS } from './BoundedProjectArchive.ts'
import {
  SourceInputError,
  SourceInputAggregateError,
  checkSourceSignal,
} from './SourceInputError.ts'
import {
  resolveSourceDownloadUrls,
  historySourceBlobUrl,
  type HistoryBlobContext,
} from './SourceDownloadUrls.ts'
const MAX_DOWNLOAD_BYTES = 3 * INPUT_LIMITS.maxTotalBytes
/** Current retained payload plus one joined attempt; failed attempts refund only
 * disk occupancy after deletion, never the finite300MiB downloaded-body budget. */
export class SourceInputBudget {
  #retained = 0
  #downloaded = 0
  counter(
    download: boolean,
    retain: boolean,
    expected?: number
  ): { stream: Transform; size(): number } {
    let received = 0
    const account = (length: number) => {
      if (
        length > INPUT_LIMITS.maxFileBytes - received ||
        (retain &&
          length > INPUT_LIMITS.maxTotalBytes - this.#retained - received) ||
        (download && length > MAX_DOWNLOAD_BYTES - this.#downloaded)
      )
        throw new SourceInputError('INPUT_LIMIT')
      received += length
      if (download) this.#downloaded += length
    }
    return {
      size: () => received,
      stream: new Transform({
        transform(chunk: unknown, _encoding, callback) {
          if (!Buffer.isBuffer(chunk)) {
            callback(new SourceInputError('SOURCE_DOWNLOAD_FAILED'))
            return
          }
          try {
            account(chunk.length)
            callback(null, chunk)
          } catch (error) {
            callback(
              error instanceof Error
                ? error
                : new SourceInputError('INPUT_LIMIT')
            )
          }
        },
        flush(callback) {
          callback(
            expected === undefined || expected === received
              ? undefined
              : new SourceInputError('SOURCE_IO_FAILED', 'length')
          )
        },
      }),
    }
  }
  retain(size: number): void {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > INPUT_LIMITS.maxTotalBytes - this.#retained
    )
      throw new SourceInputError('INPUT_LIMIT')
    this.#retained += size
  }
}
interface Attempt {
  readonly bytes: number
  readonly owned: Stats | undefined
  readonly failure: SourceInputError | SourceInputAggregateError | undefined
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
}
async function writeAttempt(
  source: Readable,
  destination: string,
  budget: SourceInputBudget,
  signal: AbortSignal,
  download: boolean,
  expected?: number
): Promise<Attempt> {
  let transfer: Promise<void> | undefined
  const counter = budget.counter(download, true, expected)
  let file: fs.FileHandle | undefined,
    owned: Stats | undefined,
    failure: SourceInputError | undefined,
    closeFailure: SourceInputError | undefined
  let origin: 'source' | 'write' | undefined
  source.once('error', () => {
    origin ??= 'source'
  })
  try {
    checkSourceSignal(signal)
    file = await fs.open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    )
    owned = await file.stat()
    if (
      !owned.isFile() ||
      owned.nlink !== 1 ||
      owned.uid !== process.geteuid?.()
    )
      throw new SourceInputError('SOURCE_IO_FAILED', 'identity')
    await file.chmod(0o600)
    const writer = createFileWriter(file)
    writer.once('error', () => {
      origin ??= 'write'
    })
    transfer = pipeline(source, counter.stream, writer, { signal })
    await transfer
  } catch (error) {
    failure =
      error instanceof SourceInputError
        ? error
        : new SourceInputError(
            signal.aborted
              ? 'SOURCE_CANCELLED'
              : download && origin === 'source'
                ? 'SOURCE_DOWNLOAD_FAILED'
                : 'SOURCE_IO_FAILED',
            'transfer'
          )
  }
  source.destroy()
  if (transfer) await Promise.allSettled([transfer])
  else
    await finished(source, {
      readable: true,
      writable: false,
      cleanup: true,
    }).catch(() => {})
  try {
    await file?.close()
  } catch {
    closeFailure = new SourceInputError('SOURCE_IO_FAILED', 'close')
  }
  if (failure && closeFailure)
    return {
      bytes: counter.size(),
      owned,
      failure: new SourceInputAggregateError(
        [failure, closeFailure],
        'transfer-and-close'
      ),
    }
  return { bytes: counter.size(), owned, failure: closeFailure ?? failure }
}
async function removeAttempt(
  destination: string,
  owned: Stats | undefined
): Promise<void> {
  if (!owned) return
  try {
    const current = await fs.lstat(destination)
    if (!current.isFile() || current.nlink !== 1 || !same(current, owned))
      throw new SourceInputError('SOURCE_IO_FAILED', 'partial-identity')
    await fs.unlink(destination)
  } catch {
    throw new SourceInputError('SOURCE_IO_FAILED', 'partial-cleanup')
  }
}
export async function writeBoundedSourceContent(
  destination: string,
  content: string,
  budget: SourceInputBudget,
  signal: AbortSignal
): Promise<void> {
  const size = Buffer.byteLength(content)
  if (size > INPUT_LIMITS.maxFileBytes)
    throw new SourceInputError('INPUT_LIMIT')
  const result = await writeAttempt(
    Readable.from([Buffer.from(content)]),
    destination,
    budget,
    signal,
    false,
    size
  )
  if (result.failure) throw result.failure
  checkSourceSignal(signal)
  budget.retain(result.bytes)
}
function settingsString(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string')
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  return value
}
function sourceURLs(url: string, fallback: string | undefined) {
  try {
    const result = resolveSourceDownloadUrls(
      url,
      fallback,
      settingsString(Settings.filestoreDomainOveride),
      settingsString(Settings.apis?.clsiPerf?.host)
    )
    for (const candidate of [result.primary, result.fallback])
      if (
        candidate !== undefined &&
        !['http:', 'https:'].includes(new URL(candidate).protocol)
      )
        throw new Error('unsupported source protocol')
    return result
  } catch {
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
}
function responseStatus(error: unknown): number | undefined {
  if (!(error instanceof RequestFailedError)) return undefined
  return Number.isInteger(error.response.status)
    ? error.response.status
    : undefined
}
async function fetchSource(
  url: string,
  signal: AbortSignal
): Promise<Readable> {
  checkSourceSignal(signal)
  try {
    // node-fetch's size bounds its error-body text consumer; successful response
    // bodies use our incremental counter before any disk write/string assembly.
    const stream = await fetchStream(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      size: 64 * 1024,
    })
    if (!(stream instanceof Readable))
      throw new SourceInputError('SOURCE_DOWNLOAD_FAILED')
    return stream
  } catch (error) {
    if (signal.aborted) throw new SourceInputError('SOURCE_CANCELLED')
    const safe = new SourceInputError('SOURCE_DOWNLOAD_FAILED', 'fetch')
    const status = responseStatus(error)
    if (status !== undefined)
      Object.defineProperty(safe, 'status', { value: status, enumerable: true })
    throw safe
  }
}
function is404(error: unknown): boolean {
  return (
    error instanceof SourceInputError &&
    'status' in error &&
    error.status === 404
  )
}
export async function pipeBoundedSourceUrlToFileWithRetry(
  url: string,
  fallbackURL: string | undefined,
  destination: string,
  budget: SourceInputBudget,
  signal: AbortSignal
): Promise<void> {
  const urls = sourceURLs(url, fallbackURL)
  for (let attempt = 0; attempt < 3; attempt++) {
    checkSourceSignal(signal)
    let stream: Readable
    try {
      try {
        stream = await fetchSource(urls.primary, signal)
      } catch (error) {
        if (urls.fallback && is404(error))
          stream = await fetchSource(urls.fallback, signal)
        else throw error
      }
    } catch (error) {
      if (
        !(error instanceof SourceInputError) ||
        error.code !== 'SOURCE_DOWNLOAD_FAILED' ||
        attempt === 2
      )
        throw error
      continue
    }
    const result = await writeAttempt(stream, destination, budget, signal, true)
    if (!result.failure) {
      checkSourceSignal(signal)
      budget.retain(result.bytes)
      return
    }
    try {
      await removeAttempt(destination, result.owned)
    } catch (cleanup) {
      throw new SourceInputAggregateError(
        [result.failure, cleanup],
        'attempt-and-cleanup'
      )
    }
    if (
      !(result.failure instanceof SourceInputError) ||
      result.failure.code !== 'SOURCE_DOWNLOAD_FAILED' ||
      attempt === 2
    )
      throw result.failure
  }
  throw new SourceInputError('SOURCE_DOWNLOAD_FAILED')
}
export async function fetchBoundedSourceText(
  url: string,
  budget: SourceInputBudget,
  signal: AbortSignal
): Promise<string> {
  const urls = sourceURLs(url, undefined)
  for (let attempt = 0; attempt < 3; attempt++) {
    let stream: Readable | undefined, transfer: Promise<void> | undefined
    try {
      stream = await fetchSource(urls.primary, signal)
      const counter = budget.counter(true, false),
        chunks: Buffer[] = []
      transfer = pipeline(
        stream,
        counter.stream,
        new Writable({
          write(chunk: unknown, _encoding, callback) {
            if (!Buffer.isBuffer(chunk)) {
              callback(new SourceInputError('SOURCE_DOWNLOAD_FAILED'))
              return
            }
            chunks.push(chunk)
            callback()
          },
        }),
        { signal }
      )
      await transfer
      checkSourceSignal(signal)
      return Buffer.concat(chunks, counter.size()).toString('utf8')
    } catch (error) {
      if (signal.aborted) throw new SourceInputError('SOURCE_CANCELLED')
      if (
        error instanceof SourceInputError &&
        (error.code !== 'SOURCE_DOWNLOAD_FAILED' || is404(error))
      )
        throw error
      if (attempt === 2)
        throw error instanceof SourceInputError
          ? error
          : new SourceInputError('SOURCE_DOWNLOAD_FAILED')
    } finally {
      if (stream) {
        stream.destroy()
        if (transfer) await Promise.allSettled([transfer])
        else
          await finished(stream, {
            readable: true,
            writable: false,
            cleanup: true,
          }).catch(() => {})
      }
    }
  }
  throw new SourceInputError('SOURCE_DOWNLOAD_FAILED')
}
export function boundedHistorySourceURL(
  hash: string,
  context: HistoryBlobContext
): string {
  try {
    const base: unknown = Settings.apis?.filestore?.url,
      perf: unknown = Settings.apis?.clsiPerf?.host
    if (
      typeof base !== 'string' ||
      typeof perf !== 'string' ||
      (!context.filestoreBlobPrefix &&
        !context.clsiPerfVariant &&
        !context.globalBlobs.includes(hash) &&
        !context.historyId)
    )
      throw new Error('incomplete history source context')
    return historySourceBlobUrl(base, perf, hash, context).href
  } catch {
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
}
