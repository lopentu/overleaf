import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import {
  createInputArchiveBundle,
  extractOutputArchive,
  INPUT_LIMITS,
  type ArchiveSummary,
} from './BoundedProjectArchive.ts'

export interface CompileInputSnapshotRequest {
  sourceRoot: string
  sourceDirectory: string
  stagingRoot: string
  signal?: AbortSignal
}
export interface CompileInputSnapshot {
  readonly inputDirectory: string
  readonly outputDirectory: string
  readonly input: Readonly<ArchiveSummary>
}
interface Identity {
  readonly dev: number
  readonly ino: number
  readonly uid: number
}
function policy(message: string): Error {
  return new Error(`Unsafe compile snapshot: ${message}`)
}
function identity(stat: Stats): Identity {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino))
    throw policy('unsupported filesystem identity')
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
}
function sameIdentity(stat: Stats, expected: Identity): boolean {
  return (
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.uid === expected.uid
  )
}
function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}
function canonicalPath(directory: string): void {
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    directory === path.parse(directory).root
  )
    throw policy('noncanonical directory path')
}
async function protectedDirectory(
  directory: string,
  owner: number,
  privateRoot: boolean
): Promise<Stats> {
  canonicalPath(directory)
  const stat = await fs.lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== owner ||
    (stat.mode & 0o022) !== 0 ||
    (privateRoot && (stat.mode & 0o777) !== 0o700) ||
    (await fs.realpath(directory)) !== directory
  )
    throw policy(
      privateRoot
        ? 'staging root is not private and owned'
        : 'source directory is not protected and owned'
    )
  return stat
}
async function checkSource(
  request: CompileInputSnapshotRequest,
  owner: number
): Promise<void> {
  await protectedDirectory(request.sourceRoot, owner, false)
  canonicalPath(request.sourceDirectory)
  if (!inside(request.sourceRoot, request.sourceDirectory))
    throw policy('source is outside its configured root')
  let directory = request.sourceRoot
  for (const component of path
    .relative(request.sourceRoot, request.sourceDirectory)
    .split(path.sep)) {
    directory = path.join(directory, component)
    await protectedDirectory(directory, owner, false)
  }
  let entries = 0
  async function visit(current: string): Promise<void> {
    request.signal?.throwIfAborted()
    for await (const entry of await fs.opendir(current)) {
      request.signal?.throwIfAborted()
      if (++entries > INPUT_LIMITS.maxEntries)
        throw policy('input entry limit exceeded')
      const child = path.join(current, entry.name)
      const stat = await fs.lstat(child)
      if (stat.uid !== owner) throw policy('source owner mismatch')
      if ((stat.mode & 0o022) !== 0)
        throw policy('source entry is not protected against writes')
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      )
        throw policy('source is a link or special file')
      if (stat.isDirectory()) await visit(child)
    }
  }
  await visit(request.sourceDirectory)
}
async function sealInput(directory: string): Promise<void> {
  for await (const entry of await fs.opendir(directory)) {
    const child = path.join(directory, entry.name)
    const stat = await fs.lstat(child)
    if (stat.isDirectory() && !stat.isSymbolicLink()) await sealInput(child)
    else if (stat.isFile() && stat.nlink === 1) await fs.chmod(child, 0o400)
    else throw policy('snapshot changed before sealing')
  }
  await fs.chmod(directory, 0o500)
}
async function permitRemoval(directory: string): Promise<void> {
  await fs.chmod(directory, 0o700)
  for await (const entry of await fs.opendir(directory)) {
    const child = path.join(directory, entry.name)
    const stat = await fs.lstat(child)
    // Never follow output symlinks; recursive rm unlinks them inside the owned job.
    if (stat.isDirectory() && !stat.isSymbolicLink()) await permitRemoval(child)
  }
}
export async function removeOwnedCompileJob(
  stagingRoot: string,
  root: Identity,
  jobDirectory: string,
  owned: Identity | undefined,
  owner: number
): Promise<void> {
  if (!sameIdentity(await protectedDirectory(stagingRoot, owner, true), root))
    throw policy('staging root identity changed; job retained')
  let stat: Stats
  try {
    stat = await fs.lstat(jobDirectory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  if (owned === undefined)
    throw policy('created job ownership could not be established; retained')
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameIdentity(stat, owned)
  )
    throw policy('owned job identity changed; replacement retained')
  await permitRemoval(jobDirectory)
  await fs.rm(jobDirectory, { recursive: true, force: false })
}

/**
 * Call only for an admitted active job, with source and configured roots/parents
 * quiescent and exclusively controlled until this callback settles. Roots are
 * trusted worker configuration. This helper acquires no CLSI/cross-process lock.
 * The callback must not mutate input or rename roots, and must finish all staging
 * users before returning. Input is read-only by modes, not immutable to its owner.
 * Returned staging paths expire on callback completion. Host quotas/admission,
 * restart cleanup and publication into compile/output caches are not implemented.
 */
export async function withCompileInputSnapshot<T>(
  request: CompileInputSnapshotRequest,
  use: (snapshot: CompileInputSnapshot) => Promise<T>
): Promise<T> {
  request.signal?.throwIfAborted()
  const owner = process.geteuid?.()
  if (owner === undefined) throw policy('POSIX process ownership is required')
  canonicalPath(request.stagingRoot)
  if (
    request.sourceRoot === request.stagingRoot ||
    inside(request.sourceRoot, request.stagingRoot) ||
    inside(request.stagingRoot, request.sourceRoot)
  )
    throw policy('source and staging boundaries overlap')
  const root = identity(
    await protectedDirectory(request.stagingRoot, owner, true)
  )
  await checkSource(request, owner)
  request.signal?.throwIfAborted()
  const jobDirectory = await fs.mkdtemp(path.join(request.stagingRoot, 'job-'))
  let owned: Identity | undefined
  let completed: { value: T } | undefined
  let workFailure: { error: unknown } | undefined
  let cleanupFailure: { error: unknown } | undefined
  try {
    const stat = await fs.lstat(jobDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner)
      throw policy('new job directory is not owned')
    owned = identity(stat)
    await fs.chmod(jobDirectory, 0o700)
    request.signal?.throwIfAborted()
    const inputDirectory = path.join(jobDirectory, 'input')
    const outputDirectory = path.join(jobDirectory, 'output')
    const options =
      request.signal === undefined ? {} : { signal: request.signal }
    const { stream: archive, completion: producerDone } =
      createInputArchiveBundle(request.sourceDirectory, options)
    const archiveDone = finished(archive, { cleanup: true })
    void archiveDone.catch(() => {})
    let summary: ArchiveSummary | undefined
    let transferFailure: { error: unknown } | undefined
    try {
      summary = await extractOutputArchive(archive, inputDirectory, {
        ...options,
        limits: INPUT_LIMITS,
      })
      await archiveDone
    } catch (error) {
      transferFailure = { error }
    }
    archive.destroy()
    // A destroyed stream may settle while its producer still owns source I/O.
    // Retain this job/source scope until both lifetimes actually settle.
    const [, producer] = await Promise.allSettled([archiveDone, producerDone])
    if (producer.status === 'rejected') {
      if (
        transferFailure !== undefined &&
        transferFailure.error !== producer.reason
      )
        throw new AggregateError(
          [transferFailure.error, producer.reason],
          'Compile snapshot transfer and input producer failed',
          { cause: transferFailure.error }
        )
      throw producer.reason
    }
    if (transferFailure !== undefined) throw transferFailure.error
    if (summary === undefined) throw policy('input transfer has no summary')
    request.signal?.throwIfAborted()
    await sealInput(inputDirectory)
    request.signal?.throwIfAborted()
    completed = {
      value: await use(
        Object.freeze({
          inputDirectory,
          outputDirectory,
          input: Object.freeze(summary),
        })
      ),
    }
    request.signal?.throwIfAborted()
  } catch (error) {
    workFailure = { error }
  } finally {
    try {
      await removeOwnedCompileJob(
        request.stagingRoot,
        root,
        jobDirectory,
        owned,
        owner
      )
    } catch (error) {
      cleanupFailure = { error }
    }
  }
  if (cleanupFailure !== undefined) {
    if (workFailure !== undefined)
      throw new AggregateError(
        [workFailure.error, cleanupFailure.error],
        'Compile snapshot work and owned-job cleanup failed',
        { cause: workFailure.error }
      )
    throw cleanupFailure.error
  }
  if (workFailure !== undefined) throw workFailure.error
  if (completed === undefined)
    throw policy('snapshot consumer completed without a result')
  return completed.value
}
