import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createFileWriter } from './ArchiveFileIo.ts'
import type { ArchiveSummary } from './BoundedProjectArchive.ts'

export interface InputArchiveFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}
export interface InputArchiveManifest {
  readonly files: readonly InputArchiveFile[]
  readonly directories: readonly string[]
  readonly summary: Readonly<ArchiveSummary>
}
export interface CompileArchiveSummary {
  readonly original: Readonly<ArchiveSummary>
  /** Charged bytes include discarded/superseded generated payload. */
  readonly generated: Readonly<ArchiveSummary>
  readonly retained: Readonly<ArchiveSummary>
  readonly namespaceEntries: number
}
export interface CompileDiagnostics {
  readonly stdout?: Buffer
  readonly stderr?: Buffer
}
const MiB = 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_FILE = 16 * MiB
const MAX_TOTAL = 64 * MiB
function policy(message: string): Error {
  return new Error(`Unsafe project archive: ${message}`)
}
function parents(name: string): string[] {
  const parts = name.split('/')
  parts.pop()
  const result: string[] = []
  let prefix = ''
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part
    result.push(prefix)
  }
  return result
}
function empty(): ArchiveSummary {
  return { entries: 0, files: 0, bytes: 0 }
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
/** Closed compile collection policy. The shared TAR engine owns all parsing,
 * stream cancellation and entry sequencing; this object owns bounded ledgers and
 * one provisional file. Its parent is private, trusted and nonconcurrent. */
export class CompileArchiveCollection {
  readonly original = empty()
  readonly generated = empty()
  readonly retained = empty()
  readonly maxWireBytes: number
  private readonly files: ReadonlyMap<string, InputArchiveFile>
  private readonly originalDirectories: ReadonlySet<string>
  private readonly namespace = new Map<string, 'file' | 'directory'>([
    ['', 'directory'],
  ])
  private readonly originalNodes = new Set<string>()
  private readonly generatedNodes = new Set<string>([''])
  private readonly retainedNodes = new Set<string>([''])
  private readonly diagnostics = new Map<string, Buffer>()
  private provisional: { directory: string; identity: Stats } | undefined
  private readonly target: string
  private readonly identity: Stats
  private readonly signal: AbortSignal | undefined
  private constructor(
    target: string,
    identity: Stats,
    manifest: InputArchiveManifest,
    diagnostics: CompileDiagnostics,
    signal: AbortSignal | undefined
  ) {
    this.target = target
    this.identity = identity
    this.signal = signal
    this.files = new Map(manifest.files.map(file => [file.path, file]))
    this.originalDirectories = new Set(manifest.directories)
    let diagnosticBytes = 0
    for (const [name, data] of [
      ['output.stdout', diagnostics.stdout],
      ['output.stderr', diagnostics.stderr],
    ] as const) {
      if (data?.length) {
        if (data.length > MiB - diagnosticBytes)
          throw policy('diagnostic byte limit exceeded')
        diagnosticBytes += data.length
        this.diagnostics.set(name, Buffer.from(data))
      }
    }
    this.generated.entries = 1
    this.retained.entries = 1
    for (const [name, data] of this.diagnostics)
      this.charge(this.generated, this.generatedNodes, name, data.length)
    this.maxWireBytes =
      manifest.summary.bytes +
      MAX_TOTAL -
      diagnosticBytes +
      (manifest.summary.entries + MAX_ENTRIES) * (2 * 4096 + 1024) +
      1024
    if (!Number.isSafeInteger(this.maxWireBytes))
      throw policy('archive wire limit overflow')
  }
  static async create(
    target: string,
    identity: Stats,
    manifest: InputArchiveManifest,
    diagnostics: CompileDiagnostics,
    signal?: AbortSignal
  ): Promise<CompileArchiveCollection> {
    const parent = await fs.lstat(path.dirname(target))
    if (
      !parent.isDirectory() ||
      parent.uid !== process.geteuid?.() ||
      (parent.mode & 0o077) !== 0
    )
      throw policy('compile collection parent is not private')
    const root = await fs.lstat(target)
    if (!root.isDirectory() || !same(root, identity))
      throw policy('output root changed')
    return new CompileArchiveCollection(
      target,
      identity,
      manifest,
      diagnostics,
      signal
    )
  }
  private charge(
    summary: ArchiveSummary,
    nodes: Set<string>,
    name: string,
    size?: number,
    maxEntries = MAX_ENTRIES
  ): void {
    for (const node of [...parents(name), name]) {
      if (!nodes.has(node)) {
        if (nodes.size >= maxEntries) throw policy('entry limit exceeded')
        nodes.add(node)
        summary.entries++
      }
    }
    if (size !== undefined) {
      if (size > MAX_TOTAL - summary.bytes)
        throw policy('total byte limit exceeded')
      summary.bytes += size
      summary.files++
    }
  }
  private reserveNamespace(name: string, directory: boolean): void {
    for (const diagnostic of this.diagnostics.keys()) {
      if (
        (name === diagnostic && directory) ||
        name.startsWith(`${diagnostic}/`)
      )
        throw policy('diagnostic namespace collision')
    }
    for (const node of parents(name)) {
      if (this.namespace.get(node) === 'file')
        throw policy('file/parent collision')
      this.namespace.set(node, 'directory')
    }
    const existing = this.namespace.get(name)
    if (existing !== undefined && (existing !== 'directory' || !directory))
      throw policy('namespace collision')
    this.namespace.set(name, directory ? 'directory' : 'file')
    if (
      this.logicalEntries() >
      this.files.size + this.originalDirectories.size + MAX_ENTRIES
    )
      throw policy('combined entry limit exceeded')
  }
  private logicalEntries(): number {
    return (
      this.namespace.size +
      Array.from(this.diagnostics.keys()).filter(
        name => !this.namespace.has(name)
      ).length
    )
  }
  size(name: string, directory: boolean, size: number | undefined): number {
    if (size === undefined || !Number.isSafeInteger(size) || size < 0)
      throw policy('invalid file length')
    if (directory) {
      if (size !== 0) throw policy('directory has a body')
      return 0
    }
    const original = this.files.get(name)
    if (size > MAX_FILE && !(original?.size === size && size <= 50 * MiB))
      throw policy('generated file limit exceeded')
    return size
  }
  private async checkRoot(): Promise<void> {
    const stat = await fs.lstat(this.target)
    if (!stat.isDirectory() || !same(stat, this.identity))
      throw policy('output root changed')
  }
  private async ensureParents(name: string): Promise<void> {
    await this.checkRoot()
    for (const parent of parents(name)) await this.directory(parent)
  }
  private async directory(name: string): Promise<void> {
    const full = path.join(this.target, name)
    try {
      await fs.mkdir(full, { mode: 0o755 })
      await fs.chmod(full, 0o755)
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error
      const stat = await fs.lstat(full)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw policy('unsafe output parent')
    }
    this.charge(
      this.retained,
      this.retainedNodes,
      name,
      undefined,
      this.files.size + this.originalDirectories.size + MAX_ENTRIES
    )
  }
  private async write(
    body: Readable,
    size: number,
    destination: string | undefined
  ): Promise<string> {
    const digest = createHash('sha256')
    let received = 0
    const counter = new Transform({
      transform(chunk: unknown, _encoding, callback) {
        if (!Buffer.isBuffer(chunk)) {
          callback(policy('nonbinary file stream'))
          return
        }
        received += chunk.length
        if (received > size) {
          callback(policy('file length mismatch'))
          return
        }
        digest.update(chunk)
        callback(null, chunk)
      },
      flush(callback) {
        callback(received === size ? undefined : policy('file length mismatch'))
      },
    })
    const file =
      destination === undefined
        ? undefined
        : await fs.open(
            destination,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o644
          )
    let failure: { error: unknown } | undefined
    try {
      if (file) await file.chmod(0o644)
      await pipeline(
        body,
        counter,
        file
          ? createFileWriter(file)
          : new Writable({
              write(_chunk, _encoding, callback) {
                callback()
              },
            }),
        { signal: this.signal }
      )
    } catch (error) {
      failure = { error }
    }
    let closeFailure: { error: unknown } | undefined
    try {
      await file?.close()
    } catch (error) {
      closeFailure = { error }
    }
    if (closeFailure) {
      if (failure)
        throw new AggregateError(
          [failure.error, closeFailure.error],
          'Archive write and close failed',
          { cause: failure.error }
        )
      throw closeFailure.error
    }
    if (failure) throw failure.error
    return digest.digest('hex')
  }
  private retain(name: string, size: number): void {
    this.charge(
      this.retained,
      this.retainedNodes,
      name,
      size,
      this.files.size + this.originalDirectories.size + MAX_ENTRIES
    )
  }
  async consume(
    name: string,
    directory: boolean,
    size: number,
    body: Readable
  ): Promise<void> {
    this.reserveNamespace(name, directory)
    if (directory) {
      if (this.originalDirectories.has(name))
        this.charge(this.original, this.originalNodes, name)
      else this.charge(this.generated, this.generatedNodes, name)
      await this.ensureParents(name)
      await this.directory(name)
      await this.write(body, 0, undefined)
      return
    }
    const original = this.files.get(name),
      candidate = original?.size === size
    const obsolete = this.diagnostics.has(name)
    if (candidate) {
      let temporary: string | undefined
      if (size <= MAX_FILE && !obsolete) {
        if (this.provisional) throw policy('provisional file already active')
        const directory = await fs.mkdtemp(
          path.join(path.dirname(this.target), '.compile-provisional-')
        )
        this.provisional = { directory, identity: await fs.lstat(directory) }
        await fs.chmod(directory, 0o700)
        temporary = path.join(directory, 'candidate')
      }
      const digest = await this.write(body, size, temporary)
      if (digest === original.sha256) {
        this.charge(this.original, this.originalNodes, name)
        if (size > 100 * MiB - this.original.bytes)
          throw policy('original total byte limit exceeded')
        this.original.bytes += size
        this.original.files++
      } else {
        if (size > MAX_FILE) throw policy('generated file limit exceeded')
        this.charge(this.generated, this.generatedNodes, name, size)
        if (!obsolete) {
          if (!temporary) throw policy('missing provisional file')
          const candidate = await fs.lstat(temporary)
          if (!candidate.isFile() || candidate.nlink !== 1)
            throw policy('unsafe provisional file')
          await this.ensureParents(name)
          await fs.link(temporary, path.join(this.target, name))
          await fs.unlink(temporary)
          const committed = await fs.lstat(path.join(this.target, name))
          if (
            !committed.isFile() ||
            committed.nlink !== 1 ||
            !same(candidate, committed)
          )
            throw policy('unsafe committed file')
          this.retain(name, size)
        }
      }
      await this.cleanupProvisional()
      return
    }
    this.charge(this.generated, this.generatedNodes, name, size)
    if (!obsolete) await this.ensureParents(name)
    await this.write(
      body,
      size,
      obsolete ? undefined : path.join(this.target, name)
    )
    if (!obsolete) this.retain(name, size)
  }
  async finish(): Promise<CompileArchiveSummary> {
    await this.checkRoot()
    for (const [name, data] of this.diagnostics) {
      await this.ensureParents(name)
      await this.write(
        Readable.from([data]),
        data.length,
        path.join(this.target, name)
      )
      this.retain(name, data.length)
    }
    await this.checkRoot()
    return Object.freeze({
      original: Object.freeze({ ...this.original }),
      generated: Object.freeze({ ...this.generated }),
      retained: Object.freeze({ ...this.retained }),
      namespaceEntries: this.logicalEntries(),
    })
  }
  async cleanupProvisional(): Promise<void> {
    if (!this.provisional) return
    const { directory, identity } = this.provisional,
      stat = await fs.lstat(directory)
    if (!stat.isDirectory() || !same(stat, identity))
      throw policy('provisional ownership changed')
    await fs.rm(directory, { recursive: true, force: true })
    this.provisional = undefined
  }
  async removeOutput(): Promise<void> {
    await this.checkRoot()
    await fs.rm(this.target, { recursive: true, force: true })
  }
}
