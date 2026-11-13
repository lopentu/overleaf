import { constants, type Stats } from 'node:fs'
import { createHash, type Hash } from 'node:crypto'
import {
  CompileArchiveCollection,
  type InputArchiveManifest,
  type InputArchiveFile,
  type CompileArchiveSummary,
  type CompileDiagnostics,
} from './CompileArchiveCollection.ts'
export type {
  InputArchiveManifest,
  CompileArchiveSummary,
} from './CompileArchiveCollection.ts'
const trustedManifests = new WeakSet<InputArchiveManifest>()
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import tar, { type Headers, type Pack } from 'tar-stream'
import { createFileWriter, readFileChunks } from './ArchiveFileIo.ts'

export interface ArchiveLimits {
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
}
export interface ArchiveOptions {
  limits?: Partial<ArchiveLimits>
  signal?: AbortSignal
}
export interface ExtractOptions extends ArchiveOptions {
  /** Docker getArchive('/compile') emits an explicit compile/ directory first. */
  requiredPrefix?: string
}
export interface ArchiveSummary {
  /** Includes directory entries, implicit parents, and a required archive root. */
  entries: number
  files: number
  bytes: number
}

const MiB = 1024 * 1024
export const INPUT_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxEntries: 4096,
  maxFileBytes: 50 * MiB,
  maxTotalBytes: 100 * MiB,
})
const OUTPUT_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxEntries: 4096,
  maxFileBytes: 16 * MiB,
  maxTotalBytes: 64 * MiB,
})
const MAX_PATH_BYTES = 4096
const METADATA_WINDOW_BYTES = 64 * 1024
const WIRE_CHUNK_BYTES = 16 * 1024

function policy(message: string): Error {
  return new Error(`Unsafe project archive: ${message}`)
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function limitsFor(
  defaults: Readonly<ArchiveLimits>,
  options: ArchiveOptions
): ArchiveLimits {
  const limits = { ...defaults, ...options.limits }
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw policy('invalid limits')
  }
  return limits
}
function containsControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}
function canonicalName(name: string, directory: boolean): string {
  if (Buffer.byteLength(name) > MAX_PATH_BYTES) throw policy('path too long')
  // TAR directory names conventionally have one trailing slash; files do not.
  const normalized = directory && name.endsWith('/') ? name.slice(0, -1) : name
  if (
    normalized.length === 0 ||
    normalized.includes('\\') ||
    /^[a-zA-Z]:/.test(normalized) ||
    containsControlCharacter(normalized) ||
    normalized
      .split('/')
      .some(part => part === '' || part === '.' || part === '..')
  )
    throw policy('noncanonical path')
  return normalized
}
function checkedSize(size: number | undefined, limits: ArchiveLimits): number {
  if (
    size === undefined ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > limits.maxFileBytes
  ) {
    throw policy('invalid file length or file limit exceeded')
  }
  return size
}
function countEntry(summary: ArchiveSummary, limits: ArchiveLimits): void {
  if (++summary.entries > limits.maxEntries)
    throw policy('entry limit exceeded')
}
function reserveFile(
  summary: ArchiveSummary,
  size: number,
  limits: ArchiveLimits
): void {
  if (size > limits.maxTotalBytes - summary.bytes)
    throw policy('total byte limit exceeded')
  summary.bytes += size
  summary.files++
}
function byteCounter(expected: number, digest?: Hash): Transform {
  let received = 0
  return new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) {
        callback(policy('nonbinary file stream'))
        return
      }
      received += chunk.length
      if (received > expected) {
        callback(policy('file length mismatch'))
        return
      }
      digest?.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      callback(
        received === expected ? undefined : policy('file length mismatch')
      )
    },
  })
}
async function appendDirectory(pack: Pack, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const entry = pack.entry(
      {
        name,
        type: 'directory',
        size: 0,
        mode: 0o755,
        uid: 33,
        gid: 33,
        mtime: new Date(0),
      },
      error => {
        if (error) reject(error)
        else resolve()
      }
    )
    entry.on('error', () => {}) // The callback reports the same sink error.
  })
}

/**
 * Stream a trusted private CLSI input directory to Docker putArchive('/compile').
 * The caller must prevent concurrent changes to the staging tree and its parents.
 * No host path, ownership, executable bit, link, or special file is preserved.
 * Compatibility stream API. Consumers that release source ownership on return
 * must use createInputArchiveBundle and join completion after destroying stream.
 */
export function createInputArchive(
  root: string,
  options: ArchiveOptions = {}
): Readable {
  return createInputArchiveBundle(root, options).stream
}

export interface InputArchiveBundle {
  readonly stream: Readable
  /** Settles after traversal, pending source I/O and owned file closure. Stream
   * close alone does not establish this boundary. Always observe/join this promise
   * before releasing source ownership, including after consumer failure/abort. */
  readonly completion: Promise<void>
}

export function createInputArchiveBundle(
  root: string,
  options: ArchiveOptions = {}
): InputArchiveBundle {
  return inputProducer(root, options, false, () => undefined)
}

export function createManifestInputArchiveBundle(
  root: string,
  options: Pick<ArchiveOptions, 'signal'> = {}
): {
  readonly stream: Readable
  readonly completion: Promise<InputArchiveManifest>
} {
  return inputProducer(
    root,
    options.signal === undefined ? {} : { signal: options.signal },
    true,
    (files, directories, summary) => {
      const manifest = Object.freeze({
        files: Object.freeze(files),
        directories: Object.freeze(directories),
        summary: Object.freeze(summary),
      })
      trustedManifests.add(manifest)
      return manifest
    }
  )
}
function inputProducer<T>(
  root: string,
  options: ArchiveOptions,
  record: boolean,
  finalize: (
    files: InputArchiveFile[],
    directories: string[],
    summary: ArchiveSummary
  ) => T
): { readonly stream: Readable; readonly completion: Promise<T> } {
  const pack = tar.pack()
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const close = (): void => {
    controller.abort()
    options.signal?.removeEventListener('abort', abort)
  }
  pack.once('close', close)
  const abortPack = (): void => {
    pack.destroy(new DOMException('Archive packing aborted', 'AbortError'))
  }
  controller.signal.addEventListener('abort', abortPack, { once: true })
  if (controller.signal.aborted) abortPack()

  async function produce(): Promise<T> {
    const limits = limitsFor(INPUT_LIMITS, options)
    const summary: ArchiveSummary = { entries: 0, files: 0, bytes: 0 }
    const files: InputArchiveFile[] = []
    const directories: string[] = []
    const rootStat = await fs.lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw policy('input root is not a directory')
    async function visit(relative: string): Promise<void> {
      controller.signal.throwIfAborted()
      const fullPath = path.join(root, relative)
      // opendir iterates incrementally; readdir would allocate an unbounded list.
      const directory = await fs.opendir(fullPath)
      for await (const child of directory) {
        controller.signal.throwIfAborted()
        const name = canonicalName(
          relative ? `${relative}/${child.name}` : child.name,
          false
        )
        countEntry(summary, limits)
        const childPath = path.join(root, name)
        const stat = await fs.lstat(childPath)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await appendDirectory(pack, name)
          if (record) directories.push(name)
          await visit(name)
          continue
        }
        if (!stat.isFile() || stat.nlink !== 1)
          throw policy('input is a link or special file')
        const file = await fs.open(
          childPath,
          constants.O_RDONLY | constants.O_NOFOLLOW
        )
        let fileFailure: { error: unknown } | undefined
        let accepted: InputArchiveFile | undefined
        try {
          const opened = await file.stat()
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.ino !== stat.ino ||
            opened.dev !== stat.dev
          ) {
            throw policy('input file changed')
          }
          const size = checkedSize(opened.size, limits)
          reserveFile(summary, size, limits)
          const digest = record ? createHash('sha256') : undefined
          const entry = pack.entry({
            name,
            type: 'file',
            size,
            mode: 0o644,
            uid: 33,
            gid: 33,
            mtime: new Date(0),
          })
          // The iterator borrows this FileHandle; only the finally block closes it.
          await pipeline(
            Readable.from(readFileChunks(file, controller.signal), {
              objectMode: false,
            }),
            byteCounter(size, digest),
            entry,
            {
              signal: controller.signal,
            }
          )
          if (digest)
            accepted = Object.freeze({
              path: name,
              size,
              sha256: digest.digest('hex'),
            })
        } catch (error) {
          fileFailure = { error }
        }
        let closeFailure: { error: unknown } | undefined
        try {
          await file.close()
        } catch (error) {
          closeFailure = { error }
        }
        if (closeFailure !== undefined) {
          if (fileFailure !== undefined)
            throw new AggregateError(
              [fileFailure.error, closeFailure.error],
              'Input archive read and source close failed',
              { cause: fileFailure.error }
            )
          throw closeFailure.error
        }
        if (fileFailure !== undefined) throw fileFailure.error
        if (accepted) files.push(accepted)
      }
    }
    await visit('')
    controller.signal.throwIfAborted()
    pack.finalize()
    return finalize(files, directories, summary)
  }
  // Start after the caller can attach a consumer. Observe rejection immediately
  // for legacy stream-only consumers; the original promise still rejects for
  // lifetime-aware callers, including failures after the stream has closed.
  const completion = Promise.resolve().then(produce)
  void completion.catch((error: unknown) => {
    pack.destroy(asError(error))
  })
  return Object.freeze({ stream: pack, completion })
}

/**
 * Extract untrusted Docker output to a NEW directory (never an existing one).
 * Its existing parent must be private, trusted, and not concurrently mutable.
 * Parent components may not be symlinks. O_NOFOLLOW protects the final file;
 * POSIX path APIs cannot defeat hostile rename races in a shared parent tree.
 * On any error the source is destroyed and the newly created tree is removed.
 */
export async function extractOutputArchive(
  source: Readable,
  target: string,
  options: ExtractOptions = {}
): Promise<ArchiveSummary> {
  return extractArchive(source, target, options, undefined)
}
export function extractCompileOutputArchive(
  source: Readable,
  target: string,
  manifest: InputArchiveManifest,
  diagnostics: CompileDiagnostics = {},
  options: Pick<ArchiveOptions, 'signal'> = {}
): Promise<CompileArchiveSummary> {
  return extractArchive(
    source,
    target,
    { ...options, requiredPrefix: 'compile' },
    { manifest, diagnostics }
  )
}
interface CompileInput {
  manifest: InputArchiveManifest
  diagnostics: CompileDiagnostics
}
function extractArchive(
  source: Readable,
  target: string,
  options: ExtractOptions,
  compile: undefined
): Promise<ArchiveSummary>
function extractArchive(
  source: Readable,
  target: string,
  options: ExtractOptions,
  compile: CompileInput
): Promise<CompileArchiveSummary>
async function extractArchive(
  source: Readable,
  target: string,
  options: ExtractOptions,
  compile: CompileInput | undefined
): Promise<ArchiveSummary | CompileArchiveSummary> {
  const resolvedTarget = path.resolve(target)
  let created = false
  let createdIdentity: Stats | undefined
  let collection: CompileArchiveCollection | undefined
  const sourceDone = finished(source, {
    readable: true,
    writable: false,
    cleanup: true,
  })
  void sourceDone.catch(() => {})
  const extract = tar.extract()
  // Observe errors before filesystem setup or asynchronous entry handling.
  const extractionDone = finished(extract, { cleanup: true })
  void extractionDone.catch(() => {})
  let transfer: Promise<void> | undefined
  let activeEntry: Promise<void> = Promise.resolve()
  let activeBody: Readable | undefined
  const summary: ArchiveSummary = { entries: 0, files: 0, bytes: 0 }
  try {
    const limits = limitsFor(OUTPUT_LIMITS, options)
    if (compile && !trustedManifests.has(compile.manifest))
      throw policy('manifest is not from the input producer')
    options.signal?.throwIfAborted()
    const prefix =
      options.requiredPrefix === undefined
        ? undefined
        : canonicalName(options.requiredPrefix, false)
    if (prefix?.includes('/'))
      throw policy('required prefix must name a single directory')
    const parent = path.dirname(resolvedTarget)
    if ((await fs.realpath(parent)) !== parent)
      throw policy('target parent contains a symlink')
    await fs.mkdir(resolvedTarget, { mode: 0o700 })
    created = true
    if (compile) createdIdentity = await fs.lstat(resolvedTarget)
    await fs.chmod(resolvedTarget, 0o700)
    if (compile) {
      if (!createdIdentity) throw policy('missing output ownership')
      collection = await CompileArchiveCollection.create(
        resolvedTarget,
        createdIdentity,
        compile.manifest,
        compile.diagnostics,
        options.signal
      )
    }
    const seen = new Set<string>()
    const materialized = new Set<string>()
    let wireBytes = 0
    let wireAllowance = METADATA_WINDOW_BYTES
    // Includes file padding and extended path headers, with an independent
    // metadata window below to bound tar-stream's internal PAX body buffering.
    const maxWireBytes =
      collection?.maxWireBytes ??
      limits.maxTotalBytes +
        limits.maxEntries * (2 * MAX_PATH_BYTES + 1024) +
        1024
    if (!Number.isSafeInteger(maxWireBytes))
      throw policy('archive wire limit overflow')

    async function ensureParents(name: string): Promise<void> {
      const rootStat = await fs.lstat(resolvedTarget)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw policy('output root changed')
      const parts = name.split('/')
      parts.pop()
      let relative = ''
      for (const part of parts) {
        relative = relative ? `${relative}/${part}` : part
        const fullPath = path.join(resolvedTarget, relative)
        try {
          const stat = await fs.lstat(fullPath)
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw policy('unsafe output parent')
        } catch (error) {
          if (!isMissing(error)) throw error
          if (materialized.has(relative)) throw policy('output parent changed')
          countEntry(summary, limits)
          await fs.mkdir(fullPath, { mode: 0o755 })
          await fs.chmod(fullPath, 0o755)
          materialized.add(relative)
        }
      }
    }
    async function consume(
      header: Headers,
      body: Readable,
      bodyDone: Promise<void>
    ): Promise<void> {
      options.signal?.throwIfAborted()
      if (header.type !== 'file' && header.type !== 'directory')
        throw policy('link or special entry')
      if (header.linkname) throw policy('unexpected link target')
      const directory = header.type === 'directory'
      const archiveName = canonicalName(header.name, directory)
      const nameForSize =
        prefix === undefined
          ? archiveName
          : archiveName.slice(prefix.length + 1)
      const size = collection
        ? collection.size(nameForSize, directory, header.size)
        : checkedSize(header.size, limits)
      if (directory && size !== 0) throw policy('directory has a body')
      if (seen.has(archiveName)) throw policy('duplicate entry')
      seen.add(archiveName)
      // Reserve only one bounded file body; reset the metadata window for each
      // visible entry. Input is split into 16KiB chunks to bound parser read-ahead.
      wireAllowance =
        wireBytes + Math.ceil(size / 512) * 512 + METADATA_WINDOW_BYTES
      if (prefix !== undefined && archiveName === prefix) {
        if (!directory || seen.size !== 1) throw policy('invalid archive root')
        countEntry(summary, limits)
        if (body.destroyed) await bodyDone
        await pipeline(
          body,
          byteCounter(0),
          new Transform({
            transform(_chunk, _encoding, callback) {
              callback()
            },
          }),
          { signal: options.signal }
        )
        return
      }
      if (
        prefix !== undefined &&
        (!seen.has(prefix) || !archiveName.startsWith(`${prefix}/`))
      ) {
        throw policy('entry outside required archive root')
      }
      const name =
        prefix === undefined
          ? archiveName
          : archiveName.slice(prefix.length + 1)
      if (collection) {
        if (body.destroyed) await bodyDone
        await collection.consume(name, directory, size, body)
        return
      }
      await ensureParents(name)
      if (!materialized.has(name)) {
        countEntry(summary, limits)
        materialized.add(name)
      } else if (!directory)
        throw policy('file collides with existing directory')
      const destination = path.join(resolvedTarget, name)
      if (directory) {
        try {
          await fs.mkdir(destination, { mode: 0o755 })
          await fs.chmod(destination, 0o755)
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'EEXIST'
            )
          )
            throw error
          const stat = await fs.lstat(destination)
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw policy('unsafe directory collision')
        }
        if (body.destroyed) await bodyDone
        await pipeline(
          body,
          byteCounter(0),
          new Transform({
            transform(_chunk, _encoding, callback) {
              callback()
            },
          }),
          { signal: options.signal }
        )
        return
      }
      reserveFile(summary, size, limits)
      const file = await fs.open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o644
      )
      try {
        await file.chmod(0o644)
        if (body.destroyed) await bodyDone
        await pipeline(body, byteCounter(size), createFileWriter(file), {
          signal: options.signal,
        })
      } finally {
        await file.close()
      }
    }
    extract.on('entry', (header, body, next) => {
      activeBody = body
      const bodyDone = finished(body, { cleanup: true })
      void bodyDone.catch(() => {})
      activeEntry = consume(header, body, bodyDone)
      void activeEntry.then(
        () => {
          activeBody = undefined
          next()
        },
        (error: unknown) => {
          body.destroy(asError(error))
          next(error)
        }
      )
    })
    async function* boundedWire(
      chunks: AsyncIterable<unknown>
    ): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        if (!Buffer.isBuffer(chunk)) throw policy('nonbinary archive stream')
        for (
          let offset = 0;
          offset < chunk.length;
          offset += WIRE_CHUNK_BYTES
        ) {
          const part = chunk.subarray(offset, offset + WIRE_CHUNK_BYTES)
          wireBytes += part.length
          if (wireBytes > wireAllowance || wireBytes > maxWireBytes)
            throw policy('archive metadata or wire limit exceeded')
          yield part
        }
      }
    }
    if (source.destroyed) await sourceDone
    transfer = pipeline(source, boundedWire, extract, {
      signal: options.signal,
    })
    await transfer
    await activeEntry
    await extractionDone
    if (prefix !== undefined && !seen.has(prefix))
      throw policy('missing archive root')
    if (collection) return await collection.finish()
    return summary
  } catch (error) {
    // Both sides may have independent failures. Settle every operation before
    // removing partial output so an outstanding writer cannot recreate it.
    source.destroy()
    activeBody?.destroy(asError(error))
    extract.destroy(asError(error))
    const settled = await Promise.allSettled([
      transfer,
      sourceDone,
      extractionDone,
      activeEntry,
    ])
    const failures: unknown[] = [error]
    if (collection)
      for (const result of settled)
        if (result.status === 'rejected' && !failures.includes(result.reason))
          failures.push(result.reason)
    const cleanupErrors: unknown[] = []
    try {
      await collection?.cleanupProvisional()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (created) {
      try {
        if (collection) await collection.removeOutput()
        else {
          if (compile) {
            const current = await fs.lstat(resolvedTarget)
            if (
              !createdIdentity ||
              !current.isDirectory() ||
              current.dev !== createdIdentity.dev ||
              current.ino !== createdIdentity.ino
            )
              throw policy('output root ownership changed')
          }
          await fs.rm(resolvedTarget, { recursive: true, force: true })
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length || failures.length > 1)
      throw new AggregateError(
        [...failures, ...cleanupErrors],
        `${asError(error).message}; archive operation or cleanup failed`,
        { cause: error }
      )
    throw error
  }
}

// One canonical archive/input namespace policy shared with fresh materialization.
export { canonicalName as canonicalProjectArchivePath }
