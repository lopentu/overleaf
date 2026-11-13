import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { zz } from '@overleaf/validation-tools'
import Errors from './Errors.js'
import { createFileWriter, readFileChunks } from './ArchiveFileIo.ts'
import { validatePrivateCompileDirectory } from './CompilerAdmission.ts'
import type {
  CompilerAdmission,
  WorkflowMetadata,
  WorkflowScope,
} from './CompilerAdmission.ts'
import {
  MAX_SOURCE_PLAN_BYTES,
  copyMaterializedPlanBytes,
  parseFullSourcePlan,
  sourceScope,
  type FullSourcePlan,
} from './CompileSourcePlan.ts'
import { ownSourceFilesystemTransaction } from './FreshCompileInput.ts'
import {
  SourceInputError,
  SourceInputAggregateError,
  checkSourceSignal,
} from './SourceInputError.ts'
const MAX_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 128
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const openCaches = new WeakSet<CompilerAdmission>()
interface LogicalScope {
  readonly projectId: string
  readonly userId?: string
}
interface Entry {
  readonly key: string
  readonly scope: LogicalScope
  readonly file: string
  readonly stat: Stats
  readonly bytes: number
  readonly accessed: number
}
interface Transaction {
  readonly key: string
  readonly scope: LogicalScope
  readonly file: string
  readonly temporary: string
  readonly backup: string
  readonly bytes: number
  readonly previous: Entry | undefined
  owned: Stats | undefined
  backedUp: boolean
  renamed: boolean
  committed: boolean
  retiredCharged: boolean
  complete: boolean
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
}
function scopeKey(scope: LogicalScope): string {
  try {
    zz.objectId().or(zz.submissionId()).parse(scope.projectId)
    if (scope.userId !== undefined) zz.objectId().parse(scope.userId)
  } catch {
    throw new SourceInputError('SOURCE_CACHE_UNSAFE')
  }
  return `${scope.projectId}.${scope.userId ?? '-'}.json`
}
function scopeFromKey(key: string): LogicalScope {
  const parts = key.split('.')
  if (parts.length !== 3 || parts[2] !== 'json')
    throw new SourceInputError('SOURCE_CACHE_UNSAFE')
  const scope = {
    projectId: parts[0],
    ...(parts[1] === '-' ? {} : { userId: parts[1] }),
  }
  if (scopeKey(scope) !== key) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
  return Object.freeze(scope)
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function cacheFile(stat: Stats, owner: number): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.uid === owner &&
    (stat.mode & 0o7777) === 0o600 &&
    stat.size <= MAX_SOURCE_PLAN_BYTES
  )
}
function expired(accessed: number, now: number): boolean {
  return accessed > now + 1000 || now - accessed >= MAX_AGE_MS
}
/** One derivative plan cache per held manager. Metadata/payload are bounded;
 * filesystem allocation, process heap and crash recovery remain runtime gates. */
export class CompileSourcePlanCache {
  readonly #admission: CompilerAdmission
  readonly #root: string
  readonly #rootIdentity: Stats
  readonly #owner: number
  readonly #entries = new Map<string, Entry>()
  readonly #pending = new Map<string, Transaction>()
  readonly #busy = new WeakSet<WorkflowScope>()
  #bytes = 0
  #reserved = 0
  #retired = 0
  private constructor(
    admission: CompilerAdmission,
    root: string,
    identity: Stats,
    owner: number
  ) {
    this.#admission = admission
    this.#root = root
    this.#rootIdentity = identity
    this.#owner = owner
  }
  static async open(
    admission: CompilerAdmission,
    root: string
  ): Promise<CompileSourcePlanCache> {
    if (openCaches.has(admission))
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    openCaches.add(admission)
    let cache: CompileSourcePlanCache
    try {
      validatePrivateCompileDirectory(root)
      const stat = await fs.lstat(root),
        owner = process.geteuid?.()
      if (owner === undefined) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      cache = new CompileSourcePlanCache(admission, root, stat, owner)
      for await (const entry of await fs.opendir(root)) {
        if (cache.#entries.size >= MAX_ENTRIES)
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        const logical = scopeFromKey(entry.name),
          file = path.join(root, entry.name),
          current = await fs.lstat(file)
        if (
          !cacheFile(current, owner) ||
          current.size > MAX_BYTES - cache.#bytes
        )
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        cache.#entries.set(
          entry.name,
          Object.freeze({
            key: entry.name,
            scope: logical,
            file,
            stat: current,
            bytes: current.size,
            accessed: current.mtimeMs,
          })
        )
        cache.#bytes += current.size
      }
    } catch {
      openCaches.delete(admission)
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    }
    return cache
  }
  async #checkRoot(): Promise<void> {
    try {
      validatePrivateCompileDirectory(this.#root)
      if (!same(await fs.lstat(this.#root), this.#rootIdentity))
        throw new Error('changed root')
    } catch {
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    }
  }
  #begin(scope: WorkflowScope): Readonly<WorkflowMetadata> {
    const logical = sourceScope(scope, this.#admission)
    if (this.#busy.has(scope))
      throw new SourceInputError('INVALID_SOURCE_REQUEST')
    this.#busy.add(scope)
    return logical
  }
  async #exact(
    file: string,
    expected: Stats,
    links: readonly number[] = [1]
  ): Promise<Stats> {
    const stat = await fs.lstat(file)
    if (
      !stat.isFile() ||
      stat.uid !== this.#owner ||
      (stat.mode & 0o7777) !== 0o600 ||
      !links.includes(stat.nlink) ||
      !same(stat, expected)
    )
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    return stat
  }
  async #unlink(
    file: string,
    expected: Stats,
    links: readonly number[] = [1]
  ): Promise<void> {
    try {
      await this.#exact(file, expected, links)
      await fs.unlink(file)
    } catch (error) {
      if (!isMissing(error)) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    }
  }
  async #remove(entry: Entry): Promise<void> {
    await this.#checkRoot()
    if (this.#pending.has(entry.key))
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    if (this.#entries.get(entry.key) !== entry) return
    await this.#unlink(entry.file, entry.stat)
    this.#entries.delete(entry.key)
    this.#bytes -= entry.bytes
  }
  async #evict(entry: Entry, onlyExpired: boolean): Promise<boolean> {
    let removed = false
    await this.#admission.tryExpire(
      { projectId: entry.scope.projectId },
      async () => {
        const current = this.#entries.get(entry.key)
        if (current !== entry || this.#pending.has(entry.key)) return
        await this.#checkRoot()
        let stat: Stats
        try {
          stat = await this.#exact(entry.file, entry.stat)
        } catch (error) {
          if (isMissing(error)) {
            await this.#remove(entry)
            removed = true
            return
          }
          throw error
        }
        if (onlyExpired && !expired(stat.mtimeMs, Date.now())) return
        await this.#remove(entry)
        removed = true
      }
    )
    return removed
  }
  async expire(): Promise<void> {
    await this.#checkRoot()
    const entries = [...this.#entries.values()].sort(
      (a, b) => a.accessed - b.accessed
    )
    for (const entry of entries) await this.#evict(entry, true)
  }
  async #reserve(scope: LogicalScope, size: number): Promise<Transaction> {
    const key = scopeKey(scope)
    const candidates = [...this.#entries.values()].sort(
      (a, b) => a.accessed - b.accessed
    )
    for (let attempt = 0; attempt <= candidates.length; attempt++) {
      if (this.#pending.has(key) || this.#pending.size >= 2)
        throw new SourceInputError('SOURCE_CACHE_CAPACITY')
      const previous = this.#entries.get(key)
      const pendingNew = [...this.#pending.values()].filter(
        tx => !tx.committed && tx.previous === undefined
      ).length
      if (
        size <= MAX_BYTES - this.#bytes - this.#reserved - this.#retired &&
        (previous !== undefined ||
          this.#entries.size + pendingNew < MAX_ENTRIES)
      ) {
        const id = randomUUID()
        const transaction: Transaction = {
          key,
          scope,
          file: path.join(this.#root, key),
          temporary: path.join(this.#root, `.${key}.${id}.tmp`),
          backup: path.join(this.#root, `.${key}.${id}.old`),
          bytes: size,
          previous,
          owned: undefined,
          backedUp: false,
          renamed: false,
          committed: false,
          retiredCharged: false,
          complete: false,
        }
        this.#reserved += size
        this.#pending.set(key, transaction)
        return transaction
      }
      const candidate = candidates[attempt]
      if (candidate) await this.#evict(candidate, false)
    }
    throw new SourceInputError('SOURCE_CACHE_CAPACITY')
  }
  async #cleanup(tx: Transaction): Promise<void> {
    if (tx.complete) return
    await this.#checkRoot()
    if (this.#pending.get(tx.key) !== tx)
      throw new SourceInputError('SOURCE_CACHE_UNSAFE')
    const failures: unknown[] = []
    if (tx.renamed && !tx.committed) {
      try {
        if (!tx.owned) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        await this.#exact(tx.file, tx.owned)
        if (tx.previous) {
          if (!tx.backedUp) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
          await this.#exact(tx.backup, tx.previous.stat)
          await fs.rename(tx.backup, tx.file)
          tx.backedUp = false
        } else await this.#unlink(tx.file, tx.owned)
        tx.renamed = false
      } catch {
        failures.push(new SourceInputError('SOURCE_CACHE_UNSAFE', 'restore'))
      }
    }
    if (tx.backedUp && (!tx.renamed || tx.committed)) {
      try {
        if (!tx.previous) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        await this.#unlink(tx.backup, tx.previous.stat, [1, 2])
        tx.backedUp = false
        if (tx.retiredCharged) {
          this.#retired -= tx.previous.bytes
          tx.retiredCharged = false
        }
      } catch {
        failures.push(
          new SourceInputError('SOURCE_CACHE_UNSAFE', 'backup-cleanup')
        )
      }
    }
    if (tx.owned) {
      try {
        await this.#unlink(tx.temporary, tx.owned)
      } catch {
        failures.push(
          new SourceInputError('SOURCE_CACHE_UNSAFE', 'temporary-cleanup')
        )
      }
    } else {
      // An open may have created bytes before identity capture failed. Preserve
      // unidentified entries and the owning slot until deliberate repair.
      try {
        await fs.lstat(tx.temporary)
        failures.push(
          new SourceInputError('SOURCE_CACHE_UNSAFE', 'temporary-identity')
        )
      } catch (error) {
        if (!isMissing(error))
          failures.push(
            new SourceInputError('SOURCE_CACHE_UNSAFE', 'temporary-identity')
          )
      }
    }
    if (failures.length)
      throw new SourceInputAggregateError(failures, 'cache-transaction-cleanup')
    if (!tx.committed) this.#reserved -= tx.bytes
    this.#pending.delete(tx.key)
    tx.complete = true
  }
  async install(scope: WorkflowScope, plan: FullSourcePlan): Promise<void> {
    const logical = this.#begin(scope)
    let transaction: Transaction | undefined,
      release: (() => void) | undefined,
      failure: unknown
    let failed = false
    const ioDone = Promise.withResolvers<void>()
    let cleanupAttempt: Promise<void> | undefined
    const cleanup = (): Promise<void> => {
      if (cleanupAttempt) return cleanupAttempt
      cleanupAttempt = (async () => {
        try {
          // Also protects the concrete factory callback if work returns early.
          await ioDone.promise
          if (transaction) await this.#cleanup(transaction)
          release?.()
        } finally {
          cleanupAttempt = undefined
        }
      })()
      return cleanupAttempt
    }
    try {
      const raw = copyMaterializedPlanBytes(scope, plan)
      release = ownSourceFilesystemTransaction(scope, cleanup)
      await this.#checkRoot()
      transaction = await this.#reserve(logical, raw.length)
      const tx = transaction
      checkSourceSignal(scope.signal)
      const file = await fs.open(
        tx.temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      )
      let writeFailure: SourceInputError | undefined,
        closeFailure: SourceInputError | undefined
      try {
        tx.owned = await file.stat()
        if (!cacheFile(tx.owned, this.#owner))
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        await file.chmod(0o600)
        await pipeline(Readable.from([raw]), createFileWriter(file), {
          signal: scope.signal,
        })
      } catch {
        writeFailure = new SourceInputError(
          scope.signal.aborted ? 'SOURCE_CANCELLED' : 'SOURCE_IO_FAILED',
          'cache-write'
        )
      }
      try {
        await file.close()
      } catch {
        closeFailure = new SourceInputError('SOURCE_IO_FAILED', 'cache-close')
      }
      if (writeFailure && closeFailure)
        throw new SourceInputAggregateError(
          [writeFailure, closeFailure],
          'cache-write-and-close'
        )
      if (writeFailure) throw writeFailure
      if (closeFailure) throw closeFailure
      checkSourceSignal(scope.signal)
      await this.#checkRoot()
      if (tx.previous) {
        await this.#exact(tx.file, tx.previous.stat)
        await fs.link(tx.file, tx.backup)
        tx.backedUp = true
        await this.#exact(tx.backup, tx.previous.stat, [2])
        await this.#exact(tx.file, tx.previous.stat, [2])
      } else {
        try {
          await fs.lstat(tx.file)
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      sourceScope(scope)
      await fs.rename(tx.temporary, tx.file)
      tx.renamed = true
      if (!tx.owned) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      const stat = await this.#exact(tx.file, tx.owned)
      sourceScope(scope)
      if (stat.size !== tx.bytes)
        throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      const current = Object.freeze({
        key: tx.key,
        scope: Object.freeze({
          projectId: logical.projectId,
          ...(logical.userId === undefined ? {} : { userId: logical.userId }),
        }),
        file: tx.file,
        stat,
        bytes: tx.bytes,
        accessed: stat.mtimeMs,
      })
      this.#entries.set(tx.key, current)
      this.#bytes += tx.bytes - (tx.previous?.bytes ?? 0)
      this.#reserved -= tx.bytes
      if (tx.previous) {
        this.#retired += tx.previous.bytes
        tx.retiredCharged = true
      }
      tx.committed = true
    } catch (error) {
      failed = true
      failure =
        error instanceof SourceInputError ||
        error instanceof SourceInputAggregateError
          ? error
          : new SourceInputError('SOURCE_IO_FAILED', 'cache-install')
    }
    ioDone.resolve()
    let cleanupFailure: unknown,
      cleanupFailed = false
    try {
      await cleanup()
    } catch (error) {
      cleanupFailure = error
      cleanupFailed = true
    }
    this.#busy.delete(scope)
    if (cleanupFailed)
      throw new SourceInputAggregateError(
        failed ? [failure, cleanupFailure] : [cleanupFailure],
        'cache-install-and-cleanup'
      )
    if (failed) throw failure
  }
  async load(scope: WorkflowScope): Promise<FullSourcePlan> {
    const logical = this.#begin(scope)
    try {
      await this.#checkRoot()
      const key = scopeKey(logical),
        entry = this.#entries.get(key)
      if (!entry) throw Errors.NotFoundError('source plan missing')
      if (this.#pending.has(key))
        throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      let file: fs.FileHandle
      try {
        file = await fs.open(
          entry.file,
          constants.O_RDONLY | constants.O_NOFOLLOW
        )
      } catch (error) {
        if (isMissing(error)) {
          this.#entries.delete(key)
          this.#bytes -= entry.bytes
          throw Errors.NotFoundError('source plan missing')
        }
        throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      }
      let failure: unknown,
        failed = false,
        closeFailure: SourceInputError | undefined
      let raw: Buffer | undefined,
        accessed = entry.accessed,
        phase = 'cache-stat'
      try {
        const stat = await file.stat()
        if (
          !cacheFile(stat, this.#owner) ||
          !same(stat, entry.stat) ||
          stat.size !== entry.bytes
        )
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        if (expired(stat.mtimeMs, Date.now()))
          throw Errors.NotFoundError('source plan expired')
        phase = 'cache-read'
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of readFileChunks(file, scope.signal)) {
          if (chunk.length > stat.size - size)
            throw new SourceInputError('SOURCE_CACHE_UNSAFE')
          size += chunk.length
          chunks.push(chunk)
        }
        if (size !== stat.size)
          throw new SourceInputError('SOURCE_CACHE_UNSAFE')
        checkSourceSignal(scope.signal)
        phase = 'cache-buffer'
        raw = Buffer.concat(chunks, size)
        phase = 'cache-touch'
        accessed = Date.now()
        // Yarn's real PnP FileHandle.utimes is unimplemented. Protect the same
        // owned path before using the supported path API; ancestry is trusted.
        await this.#checkRoot()
        await this.#exact(entry.file, entry.stat)
        await fs.utimes(entry.file, accessed / 1000, accessed / 1000)
        await this.#exact(entry.file, entry.stat)
      } catch (error) {
        failed = true
        failure =
          error instanceof SourceInputError ||
          (error instanceof Error && error.name === 'NotFoundError')
            ? error
            : new SourceInputError(
                scope.signal.aborted ? 'SOURCE_CANCELLED' : 'SOURCE_IO_FAILED',
                phase
              )
      }
      try {
        await file.close()
      } catch {
        closeFailure = new SourceInputError(
          'SOURCE_IO_FAILED',
          'cache-read-close'
        )
      }
      if (closeFailure)
        throw new SourceInputAggregateError(
          failed ? [failure, closeFailure] : [closeFailure],
          'cache-read-and-close'
        )
      if (failed) throw failure
      checkSourceSignal(scope.signal)
      if (!raw) throw new SourceInputError('SOURCE_CACHE_UNSAFE')
      this.#entries.set(key, Object.freeze({ ...entry, accessed }))
      return await parseFullSourcePlan(scope, raw)
    } finally {
      this.#busy.delete(scope)
    }
  }
  /** External cancel/join/reset owner. Never await from matching active work or
   * another same-filter reset callback; later bridge must compose ONE owner. */
  resetAndClear(filter: LogicalScope): Promise<void> {
    try {
      if (!filter || typeof filter !== 'object' || 'kind' in filter)
        throw new SourceInputError('INVALID_SOURCE_REQUEST')
      const projectId = filter.projectId,
        userId = filter.userId
      const copy = Object.freeze({
        projectId,
        ...(userId === undefined ? {} : { userId }),
      })
      scopeKey(copy)
      return this.#admission.reset(copy, async () => {
        await this.#checkRoot()
        for (const entry of [...this.#entries.values()])
          if (
            entry.scope.projectId === copy.projectId &&
            (copy.userId === undefined || entry.scope.userId === copy.userId)
          )
            await this.#remove(entry)
      })
    } catch {
      return Promise.reject(new SourceInputError('INVALID_SOURCE_REQUEST'))
    }
  }
}
