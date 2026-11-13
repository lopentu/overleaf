import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import OutputCacheManager, { queueDirOperation } from './OutputCacheManager.js'
import { canonicalProjectArchivePath } from './BoundedProjectArchive.ts'
import { readFileChunks, createFileWriter } from './ArchiveFileIo.ts'
import {
  validatePrivateCompileDirectory,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import {
  sourceOperationDirectory,
  sourceArtifactRevision,
  ownSourceFilesystemTransaction,
} from './FreshCompileInput.ts'
import { SourceInputError } from './SourceInputError.ts'
import { BuildIdConflictError } from './BuildIdConflictError.ts'
import { registerOutputDirectory } from './OutputDirectoryRetention.ts'
import { BUILD_REGEX } from './CompileBuildId.ts'

export interface PublicationProfile {
  readonly optimiseInDocker: boolean
  readonly archiveLogs: boolean
  readonly strace: boolean
  readonly pdfCaching: boolean
  readonly clsiCache: boolean
}
export interface PublicationConfiguration {
  readonly outputRoot: string
  readonly profile: PublicationProfile
}
export interface PublicationRequest {
  readonly outputDirectory: string
  readonly buildId?: string
}
export interface PublishedOutputFile {
  readonly path: string
  readonly type?: string
  readonly build: string
  readonly size?: number
}
export interface PublishedBuild {
  readonly buildId: string
  readonly outputFiles: readonly PublishedOutputFile[]
}
export interface CompileOutputPublisher {
  publish(
    scope: WorkflowScope,
    request: PublicationRequest
  ): Promise<PublishedBuild>
}
export class PublicationError extends Error {
  readonly code:
    | 'INVALID_PUBLICATION'
    | 'PUBLICATION_UNSUPPORTED'
    | 'PUBLICATION_IO_FAILED'
    | 'PUBLICATION_CANCELLED'
  constructor(code: PublicationError['code']) {
    super(`Compile publication: ${code}`)
    this.code = code
  }
}
interface OwnedDirectory {
  readonly path: string
  identity: Stats | undefined
}
interface FileDescription {
  readonly path: string
  readonly size: number
}
const MAX_FILE = 16 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024
const MAX_ENTRIES = 4096
function same(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
  )
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function safe(error: unknown, signal: AbortSignal): Error {
  if (
    error instanceof BuildIdConflictError ||
    error instanceof PublicationError ||
    error instanceof SourceInputError
  )
    return error
  return new PublicationError(
    signal.aborted ? 'PUBLICATION_CANCELLED' : 'PUBLICATION_IO_FAILED'
  )
}
function combined(errors: readonly Error[]): Error {
  const first = errors[0]
  return errors.length === 1 && first
    ? first
    : new AggregateError(errors, 'Compile publication and owned cleanup failed')
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
function publicationBuildId(): Promise<string> {
  return new Promise((resolve, reject) => {
    OutputCacheManager.generateBuildId((error: unknown, value: unknown) => {
      if (
        error != null ||
        typeof value !== 'string' ||
        !BUILD_REGEX.test(value)
      )
        reject(new PublicationError('PUBLICATION_IO_FAILED'))
      else resolve(value)
    })
  })
}
async function directoryIdentity(
  directory: string,
  owner: number
): Promise<Stats> {
  const stat = await fs.lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== owner ||
    (stat.mode & 0o022) !== 0 ||
    (await fs.realpath(directory)) !== directory
  )
    throw new PublicationError('INVALID_PUBLICATION')
  return stat
}
/** Private unselected publisher. Reader permissions and all optional worker/
 * cache/log profiles remain runtime gates; this unit never invokes host qpdf. */
export async function openCompileOutputPublisher(
  admission: CompilerAdmission,
  configuration: PublicationConfiguration
): Promise<CompileOutputPublisher> {
  let root: string, profile: Readonly<PublicationProfile>
  try {
    root = configuration.outputRoot
    const configured = configuration.profile
    profile = Object.freeze({
      optimiseInDocker: configured.optimiseInDocker,
      archiveLogs: configured.archiveLogs,
      strace: configured.strace,
      pdfCaching: configured.pdfCaching,
      clsiCache: configured.clsiCache,
    })
  } catch {
    throw new PublicationError('INVALID_PUBLICATION')
  }
  if (Object.values(profile).some(value => typeof value !== 'boolean'))
    throw new PublicationError('INVALID_PUBLICATION')
  if (
    !profile.optimiseInDocker ||
    profile.archiveLogs ||
    profile.strace ||
    profile.pdfCaching ||
    profile.clsiCache
  )
    throw new PublicationError('PUBLICATION_UNSUPPORTED')
  let owner: number, rootIdentity: Stats
  try {
    validatePrivateCompileDirectory(root)
    const uid = process.geteuid?.()
    if (uid === undefined) throw new PublicationError('INVALID_PUBLICATION')
    owner = uid
    rootIdentity = await directoryIdentity(root, owner)
  } catch {
    throw new PublicationError('INVALID_PUBLICATION')
  }
  async function checkRoot(): Promise<void> {
    if (!same(await directoryIdentity(root, owner), rootIdentity))
      throw new PublicationError('PUBLICATION_IO_FAILED')
  }
  return Object.freeze({
    async publish(
      scope: WorkflowScope,
      request: PublicationRequest
    ): Promise<PublishedBuild> {
      const operation = sourceOperationDirectory(scope, admission)
      let outputDirectory: string, explicitId: string | undefined
      try {
        outputDirectory = request.outputDirectory
        explicitId = request.buildId
      } catch {
        throw new PublicationError('INVALID_PUBLICATION')
      }
      if (
        scope.metadata.kind !== 'compile' ||
        typeof outputDirectory !== 'string' ||
        path.resolve(outputDirectory) !== outputDirectory ||
        !inside(operation, outputDirectory) ||
        (explicitId !== undefined &&
          (typeof explicitId !== 'string' || !BUILD_REGEX.test(explicitId)))
      )
        throw new PublicationError('INVALID_PUBLICATION')
      const artifactRevision = sourceArtifactRevision(
        scope,
        admission,
        outputDirectory
      )
      function checkArtifact(): void {
        sourceArtifactRevision(
          scope,
          admission,
          outputDirectory,
          artifactRevision
        )
      }
      const logical =
        scope.metadata.userId === undefined
          ? scope.metadata.projectId
          : `${scope.metadata.projectId}-${scope.metadata.userId}`
      const logicalRoot = path.join(root, logical),
        generatedRoot = path.join(logicalRoot, OutputCacheManager.CACHE_SUBDIR)
      const candidate: OwnedDirectory = {
        path: path.join(operation, `publication-${randomUUID()}`),
        identity: undefined,
      }
      let operationIdentity: Stats | undefined,
        allocationAttempted = false
      let target: OwnedDirectory | undefined,
        targetParent: Stats | undefined,
        renameAttempted = false,
        committed = false,
        complete = false
      const parents: OwnedDirectory[] = []
      const ioDone = Promise.withResolvers<void>()
      let cleanupAttempt: Promise<void> | undefined
      let release: (() => void) | undefined
      async function removeExact(value: OwnedDirectory): Promise<void> {
        let stat: Stats
        try {
          stat = await fs.lstat(value.path)
        } catch (error) {
          if (missing(error)) return
          throw error
        }
        if (
          !value.identity ||
          !same(stat, value.identity) ||
          !stat.isDirectory() ||
          stat.isSymbolicLink()
        )
          throw new PublicationError('PUBLICATION_IO_FAILED')
        await fs.rm(value.path, { recursive: true, force: false })
      }
      const cleanup = (): Promise<void> => {
        if (complete) return Promise.resolve()
        if (cleanupAttempt) return cleanupAttempt
        cleanupAttempt = (async () => {
          await ioDone.promise
          const failures: Error[] = []
          // Final-target recovery uses only its persistent namespace. The outer
          // factory may already have removed the private operation after failure.
          try {
            await queueDirOperation(logicalRoot, async () => {
              await checkRoot()
              if (renameAttempted && !committed && target) {
                let current: Stats | undefined
                try {
                  current = await fs.lstat(target.path)
                } catch (error) {
                  if (!missing(error)) throw error
                }
                if (current) {
                  if (
                    !targetParent ||
                    !same(
                      await directoryIdentity(generatedRoot, owner),
                      targetParent
                    )
                  )
                    throw new PublicationError('PUBLICATION_IO_FAILED')
                  await removeExact(target)
                }
                renameAttempted = false
              }
              if (!committed)
                for (const parent of [...parents].reverse()) {
                  let current: Stats | undefined
                  try {
                    current = await fs.lstat(parent.path)
                  } catch (error) {
                    if (!missing(error)) throw error
                  }
                  if (!current) continue
                  if (
                    !parent.identity ||
                    !same(current, parent.identity) ||
                    !current.isDirectory()
                  )
                    throw new PublicationError('PUBLICATION_IO_FAILED')
                  await fs.rmdir(parent.path)
                }
            })
          } catch (error) {
            failures.push(safe(error, scope.signal))
          }
          try {
            if (allocationAttempted) {
              let currentOperation: Stats | undefined
              try {
                currentOperation = await fs.lstat(operation)
              } catch (error) {
                if (!missing(error)) throw error
              }
              if (
                currentOperation &&
                (!operationIdentity ||
                  !same(currentOperation, operationIdentity))
              )
                throw new PublicationError('PUBLICATION_IO_FAILED')
              if (currentOperation) await removeExact(candidate)
            }
          } catch (error) {
            failures.push(safe(error, scope.signal))
          }
          if (failures.length) throw combined(failures)
          release?.()
          complete = true
        })().finally(() => {
          cleanupAttempt = undefined
        })
        return cleanupAttempt
      }
      release = ownSourceFilesystemTransaction(scope, cleanup)
      let result: PublishedBuild | undefined, failure: Error | undefined
      try {
        await checkRoot()
        operationIdentity = await directoryIdentity(operation, owner)
        const original = await directoryIdentity(outputDirectory, owner)
        if (
          operationIdentity.dev !== rootIdentity.dev ||
          original.dev !== rootIdentity.dev
        )
          throw new PublicationError('INVALID_PUBLICATION')
        checkArtifact()
        allocationAttempted = true
        await fs.mkdir(candidate.path, { mode: 0o700 })
        candidate.identity = await directoryIdentity(candidate.path, owner)
        const descriptions: FileDescription[] = []
        let entries = 1,
          total = 0
        async function walk(): Promise<void> {
          // At most MAX_ENTRIES pending names and one open directory handle,
          // independent of valid archive path depth.
          const pending = ['']
          while (pending.length) {
            const relative = pending.pop()
            if (relative === undefined)
              throw new PublicationError('PUBLICATION_IO_FAILED')
            const handle = await fs.opendir(
              path.join(outputDirectory, relative)
            )
            for await (const entry of handle) {
              const name = entry.name
              checkArtifact()
              const child = relative ? `${relative}/${name}` : name
              canonicalProjectArchivePath(child, false)
              if (++entries > MAX_ENTRIES)
                throw new PublicationError('INVALID_PUBLICATION')
              const from = path.join(outputDirectory, child),
                stat = await fs.lstat(from)
              if (stat.uid !== owner || stat.isSymbolicLink())
                throw new PublicationError('INVALID_PUBLICATION')
              if (stat.isDirectory()) {
                pending.push(child)
                continue
              }
              if (
                !stat.isFile() ||
                stat.nlink !== 1 ||
                stat.size > MAX_FILE ||
                stat.size > MAX_TOTAL - total
              )
                throw new PublicationError('INVALID_PUBLICATION')
              total += stat.size
              if (
                OutputCacheManager._fileIsHidden(child) ||
                /^strace/.test(name)
              )
                continue
              const to = path.join(candidate.path, child)
              await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
              checkArtifact()
              const input = await fs.open(
                from,
                constants.O_RDONLY | constants.O_NOFOLLOW
              )
              let output: fs.FileHandle | undefined,
                workError: Error | undefined
              const errors: Error[] = []
              try {
                const opened = await input.stat()
                if (
                  !same(opened, stat) ||
                  !opened.isFile() ||
                  opened.nlink !== 1 ||
                  opened.size !== stat.size
                )
                  throw new PublicationError('PUBLICATION_IO_FAILED')
                output = await fs.open(
                  to,
                  constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600
                )
                let received = 0
                const counter = new Transform({
                  transform(chunk: unknown, _encoding, callback) {
                    if (
                      !Buffer.isBuffer(chunk) ||
                      chunk.length > stat.size - received
                    ) {
                      callback(new PublicationError('PUBLICATION_IO_FAILED'))
                      return
                    }
                    received += chunk.length
                    callback(null, chunk)
                  },
                })
                await pipeline(
                  Readable.from(readFileChunks(input, scope.signal)),
                  counter,
                  createFileWriter(output),
                  { signal: scope.signal }
                )
                const ended = await input.stat()
                if (
                  received !== stat.size ||
                  !same(ended, opened) ||
                  ended.size !== opened.size ||
                  ended.mtimeMs !== opened.mtimeMs ||
                  ended.ctimeMs !== opened.ctimeMs
                )
                  throw new PublicationError('PUBLICATION_IO_FAILED')
              } catch (error) {
                workError = safe(error, scope.signal)
              }
              if (workError) errors.push(workError)
              try {
                await output?.close()
              } catch (error) {
                errors.push(safe(error, scope.signal))
              }
              try {
                await input.close()
              } catch (error) {
                errors.push(safe(error, scope.signal))
              }
              if (errors.length) throw combined(errors)
              descriptions.push(Object.freeze({ path: child, size: stat.size }))
            }
          }
        }
        await walk()
        if (!same(await directoryIdentity(outputDirectory, owner), original))
          throw new PublicationError('PUBLICATION_IO_FAILED')
        result = await queueDirOperation(logicalRoot, async () => {
          await checkRoot()
          for (const parent of [logicalRoot, generatedRoot]) {
            const created: OwnedDirectory = {
              path: parent,
              identity: undefined,
            }
            parents.push(created)
            try {
              await fs.mkdir(parent, { mode: 0o700 })
              created.identity = await directoryIdentity(parent, owner)
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  'code' in error &&
                  error.code === 'EEXIST'
                )
              )
                throw error
              parents.splice(parents.indexOf(created), 1)
              await directoryIdentity(parent, owner)
            }
          }
          targetParent = await directoryIdentity(generatedRoot, owner)
          let buildId: string | undefined
          for (
            let attempt = 0;
            attempt < (explicitId === undefined ? 3 : 1);
            attempt++
          ) {
            const proposed = explicitId ?? (await publicationBuildId())
            if (typeof proposed !== 'string' || !BUILD_REGEX.test(proposed))
              throw new PublicationError('INVALID_PUBLICATION')
            let occupied = false
            try {
              await fs.lstat(path.join(generatedRoot, proposed))
              occupied = true
            } catch (error) {
              if (!missing(error)) throw error
            }
            if (occupied) {
              if (explicitId !== undefined) throw new BuildIdConflictError()
              continue
            }
            buildId = proposed
            break
          }
          if (buildId === undefined) throw new BuildIdConflictError()
          checkArtifact()
          target = {
            path: path.join(generatedRoot, buildId),
            identity: candidate.identity,
          }
          renameAttempted = true
          await fs.rename(candidate.path, target.path)
          if (
            !target.identity ||
            !same(await directoryIdentity(target.path, owner), target.identity)
          )
            throw new PublicationError('PUBLICATION_IO_FAILED')
          checkArtifact()
          const chosenId = buildId
          const outputFiles = Object.freeze(
            descriptions.map(file =>
              Object.freeze({
                path: file.path,
                ...(path.extname(file.path)
                  ? { type: path.extname(file.path).slice(1) }
                  : {}),
                build: chosenId,
                ...(file.path === 'output.pdf' ? { size: file.size } : {}),
              })
            )
          )
          const published = Object.freeze({ buildId, outputFiles })
          checkArtifact()
          committed = true
          registerOutputDirectory(logicalRoot)
          // This is the existing non-queuing primitive under its existing queue.
          // As in legacy publication, expiry failure cannot revoke a committed
          // build; the same registered bulk scheduler retains the retry duty.
          try {
            await new Promise<void>((resolve, reject) => {
              OutputCacheManager.expireOutputFiles(
                logicalRoot,
                {
                  keep: buildId,
                  limit: scope.metadata.userId === undefined ? null : 1,
                },
                (error: unknown) => (error == null ? resolve() : reject(error))
              )
            })
          } catch {
            /* Existing best-effort expiry remains registered. */
          }
          return published
        })
      } catch (error) {
        failure = safe(error, scope.signal)
      }
      ioDone.resolve()
      let cleanupFailure: Error | undefined
      try {
        await cleanup()
      } catch (error) {
        cleanupFailure = safe(error, scope.signal)
      }
      if (failure || cleanupFailure)
        throw combined([
          ...(failure ? [failure] : []),
          ...(cleanupFailure ? [cleanupFailure] : []),
        ])
      if (!result) throw new PublicationError('PUBLICATION_IO_FAILED')
      return result
    },
  })
}
