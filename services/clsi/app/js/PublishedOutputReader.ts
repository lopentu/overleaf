import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { removeOwnedCompileJob } from './CompileInputSnapshot.ts'
import {
  PreparedSyncTexInput,
  type SyncTexQuery,
} from './PreparedSyncTexInput.ts'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import type { Request, Response } from 'express'
import { zz } from '@overleaf/validation-tools'
import {
  assertActiveWorkflowScope,
  validatePrivateCompileDirectory,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import { BUILD_REGEX } from './CompileBuildId.ts'
import { canonicalProjectArchivePath } from './BoundedProjectArchive.ts'
import { queueDirOperation } from './OutputCacheManager.js'
import { isOutputZipFile } from './OutputArchiveFiles.ts'
const MAX_FILE = 16 * 1024 * 1024,
  MAX_TOTAL = 64 * 1024 * 1024,
  MAX_ENTRIES = 4096,
  MAX_ZIP = 100 * 1024 * 1024
export class OutputReadError extends Error {
  readonly code: 'INVALID_OUTPUT' | 'OUTPUT_NOT_FOUND' | 'OUTPUT_IO_FAILED'
  constructor(code: OutputReadError['code']) {
    super(code)
    this.code = code
  }
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
}
function fileStat(stat: Stats, owner: number): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== owner ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > MAX_FILE
  )
    throw new OutputReadError('INVALID_OUTPUT')
}
function outputHeaders(response: Response): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-download-options', 'noopen')
  response.setHeader('x-frame-options', 'SAMEORIGIN')
  response.setHeader('x-xss-protection', '1; mode=block')
}
function outputContentType(name: string): string {
  const extension = path.extname(name)
  if (extension === '.pdf') return 'application/pdf'
  if (['.log', '.blg', '.aux', '.stdout', '.stderr'].includes(extension))
    return 'text/plain'
  return 'application/octet-stream'
}
interface FileDescription {
  name: string
  stat: Stats
}
interface Reader {
  readonly directory: string
  open(description: FileDescription): Promise<fs.FileHandle>
  close(): Promise<void>
  read(file: fs.FileHandle, buffer: Buffer, position: number): Promise<number>
  workspace(stagingRoot: string): Promise<string>
}
async function* bytes(
  file: fs.FileHandle,
  size: number,
  signal: AbortSignal,
  read: Reader['read'],
  start = 0,
  length = size
): AsyncGenerator<Buffer> {
  let consumed = 0
  while (consumed < length) {
    signal.throwIfAborted()
    const buffer = Buffer.allocUnsafe(Math.min(65536, length - consumed))
    const bytesRead = await read(file, buffer, start + consumed)
    if (bytesRead <= 0 || bytesRead > buffer.length)
      throw new OutputReadError('OUTPUT_IO_FAILED')
    consumed += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}
/** No daemon/client/extra queue. One existing flow cleanup joins producer/read/close,
 * retains failed closure for manager cleanup retry, and holds the existing output queue. */
export async function openPublishedOutputReader(
  manager: CompilerAdmission,
  configuredRoot: string
) {
  const root = configuredRoot,
    owner = process.geteuid?.()
  if (owner === undefined) throw new OutputReadError('INVALID_OUTPUT')
  validatePrivateCompileDirectory(root)
  const readerUid: number = owner
  const rootIdentity = await fs.lstat(root)
  async function directory(name: string): Promise<Stats> {
    validatePrivateCompileDirectory(name)
    return await fs.lstat(name)
  }
  async function withBuild<T>(
    scope: WorkflowScope,
    buildId: string,
    work: (reader: Reader) => Promise<T>
  ): Promise<T> {
    assertActiveWorkflowScope(scope, manager, true)
    if (scope.metadata.kind !== 'output-read' || !BUILD_REGEX.test(buildId))
      throw new OutputReadError('INVALID_OUTPUT')
    const projectId = zz
      .objectId()
      .or(zz.submissionId())
      .parse(scope.metadata.projectId)
    const userId = scope.metadata.userId
    if (userId !== undefined) zz.objectId().parse(userId)
    const logical = path.join(
      root,
      projectId + (userId === undefined ? '' : '-' + userId)
    )
    const build = path.join(logical, 'generated-files', buildId)
    let handle: fs.FileHandle | undefined,
      pendingRead: Promise<unknown> | undefined
    let closing = false
    const done = Promise.withResolvers<void>()
    let workspace:
      | {
          parent: string
          parentIdentity: Stats
          directory: string | undefined
          identity: Stats | undefined
        }
      | undefined
    const close = async () => {
      if (handle === undefined) return
      closing = true
      await pendingRead?.catch(() => {})
      try {
        await handle.close()
        handle = undefined
      } catch {
        throw new OutputReadError('OUTPUT_IO_FAILED')
      }
    }
    const cleanup = async () => {
      await done.promise
      const errors: Error[] = []
      try {
        await close()
      } catch {
        errors.push(new OutputReadError('OUTPUT_IO_FAILED'))
      }
      try {
        if (workspace !== undefined) {
          if (workspace.directory === undefined)
            throw new OutputReadError('OUTPUT_IO_FAILED')
          await removeOwnedCompileJob(
            workspace.parent,
            workspace.parentIdentity,
            workspace.directory,
            workspace.identity,
            readerUid
          )
        }
      } catch {
        errors.push(new OutputReadError('OUTPUT_IO_FAILED'))
      }
      if (errors.length)
        throw new AggregateError(errors, 'Owned output reader cleanup failed')
    }
    scope.claimWorkspaceCleanup(cleanup)
    try {
      return await queueDirOperation(logical, async () => {
        if (!same(await directory(root), rootIdentity))
          throw new OutputReadError('INVALID_OUTPUT')
        for (const current of [
          logical,
          path.join(logical, 'generated-files'),
          build,
        ])
          await directory(current)
        try {
          return await work({
            directory: build,
            close,
            async workspace(stagingRoot) {
              if (workspace !== undefined)
                throw new OutputReadError('INVALID_OUTPUT')
              validatePrivateCompileDirectory(stagingRoot)
              workspace = {
                parent: stagingRoot,
                parentIdentity: await fs.lstat(stagingRoot),
                directory: undefined,
                identity: undefined,
              }
              workspace.directory = await fs.mkdtemp(
                path.join(stagingRoot, 'reader-')
              )
              workspace.identity = await fs.lstat(workspace.directory)
              await fs.chmod(workspace.directory, 0o700)
              scope.ownWorkspace(workspace.directory, cleanup)
              const jobs = path.join(workspace.directory, 'jobs')
              await fs.mkdir(jobs, { mode: 0o700 })
              return jobs
            },
            async read(file, buffer, position) {
              if (closing || handle !== file || pendingRead !== undefined)
                throw new OutputReadError('OUTPUT_IO_FAILED')
              const pending = file.read(buffer, 0, buffer.length, position)
              pendingRead = pending
              try {
                return (await pending).bytesRead
              } finally {
                if (pendingRead === pending) pendingRead = undefined
              }
            },
            async open(description) {
              if (handle !== undefined)
                throw new OutputReadError('OUTPUT_IO_FAILED')
              canonicalProjectArchivePath(description.name, false)
              const target = path.join(build, description.name)
              if ((await fs.realpath(target)) !== target)
                throw new OutputReadError('INVALID_OUTPUT')
              handle = await fs.open(
                target,
                constants.O_RDONLY | constants.O_NOFOLLOW
              )
              closing = false
              const opened = await handle.stat()
              fileStat(opened, readerUid)
              if (
                !same(opened, description.stat) ||
                opened.size !== description.stat.size ||
                opened.mtimeMs !== description.stat.mtimeMs
              )
                throw new OutputReadError('OUTPUT_IO_FAILED')
              return handle
            },
          })
        } finally {
          await close()
        }
      })
    } catch (error) {
      if (error instanceof OutputReadError) throw error
      if (
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR'].includes(String(error.code))
      )
        throw new OutputReadError('OUTPUT_NOT_FOUND')
      throw new OutputReadError('OUTPUT_IO_FAILED')
    } finally {
      done.resolve()
    }
  }
  return Object.freeze({
    async file(
      scope: WorkflowScope,
      buildId: string,
      name: string,
      request: Request,
      response: Response
    ): Promise<void> {
      canonicalProjectArchivePath(name, false)
      await withBuild(scope, buildId, async reader => {
        const stat = await fs.lstat(path.join(reader.directory, name))
        fileStat(stat, readerUid)
        const handle = await reader.open({ name, stat })
        const ranges = request.range(stat.size, { combine: true })
        if (
          ranges !== undefined &&
          (typeof ranges === 'number' ||
            ranges.type !== 'bytes' ||
            ranges.length !== 1)
        ) {
          response
            .status(416)
            .setHeader('content-range', 'bytes */' + stat.size)
          response.end()
          return
        }
        const selected = typeof ranges === 'object' ? ranges[0] : undefined
        const start = selected?.start ?? 0,
          length = selected === undefined ? stat.size : selected.end - start + 1
        response.status(selected === undefined ? 200 : 206)
        response.setHeader('accept-ranges', 'bytes')
        response.setHeader('content-length', length)
        outputHeaders(response)
        response.type(outputContentType(name))
        if (selected)
          response.setHeader(
            'content-range',
            `bytes ${start}-${selected.end}/${stat.size}`
          )
        if (request.method === 'HEAD') response.end()
        else
          await pipeline(
            Readable.from(
              bytes(handle, stat.size, scope.signal, reader.read, start, length)
            ),
            response,
            { signal: scope.signal }
          )
      })
    },
    async withSnapshot<T>(
      scope: WorkflowScope,
      buildId: string,
      stagingRoot: string,
      query: SyncTexQuery,
      use: (prepared: PreparedSyncTexInput) => Promise<T>
    ): Promise<T> {
      return await withBuild(scope, buildId, async reader => {
        const pending = [reader.directory]
        let entries = 1,
          bytes = 0
        while (pending.length) {
          const current = pending.pop()
          if (current === undefined) throw new OutputReadError('INVALID_OUTPUT')
          for await (const entry of await fs.opendir(current)) {
            scope.signal.throwIfAborted()
            if (++entries > MAX_ENTRIES)
              throw new OutputReadError('INVALID_OUTPUT')
            const name = path.join(current, entry.name),
              stat = await fs.lstat(name)
            if (
              stat.uid !== readerUid ||
              (stat.mode & 0o022) !== 0 ||
              stat.isSymbolicLink()
            )
              throw new OutputReadError('INVALID_OUTPUT')
            if (stat.isDirectory()) pending.push(name)
            else {
              fileStat(stat, readerUid)
              bytes += stat.size
              if (bytes > MAX_TOTAL) throw new OutputReadError('INVALID_OUTPUT')
            }
          }
        }
        for (const name of ['output.pdf', 'output.synctex.gz'])
          fileStat(await fs.lstat(path.join(reader.directory, name)), readerUid)
        const jobs = await reader.workspace(stagingRoot)
        return await PreparedSyncTexInput.withInput(
          scope,
          manager,
          {
            sourceRoot: root,
            sourceDirectory: reader.directory,
            stagingRoot: jobs,
          },
          buildId,
          query,
          use
        )
      })
    },
    async zip(
      scope: WorkflowScope,
      buildId: string,
      response: Response
    ): Promise<void> {
      await withBuild(scope, buildId, async reader => {
        const files: FileDescription[] = [],
          pending = ['']
        let entries = 1,
          total = 0
        while (pending.length) {
          scope.signal.throwIfAborted()
          const relative = pending.pop()
          if (relative === undefined)
            throw new OutputReadError('INVALID_OUTPUT')
          for await (const entry of await fs.opendir(
            path.join(reader.directory, relative)
          )) {
            if (++entries > MAX_ENTRIES)
              throw new OutputReadError('INVALID_OUTPUT')
            const name = relative ? relative + '/' + entry.name : entry.name
            canonicalProjectArchivePath(name, false)
            const stat = await fs.lstat(path.join(reader.directory, name))
            if (
              stat.uid !== readerUid ||
              (stat.mode & 0o022) !== 0 ||
              stat.isSymbolicLink()
            )
              throw new OutputReadError('INVALID_OUTPUT')
            if (stat.isDirectory()) pending.push(name)
            else {
              fileStat(stat, readerUid)
              total += stat.size
              if (total > MAX_TOTAL) throw new OutputReadError('INVALID_OUTPUT')
              if (isOutputZipFile(name)) files.push({ name, stat })
            }
          }
        }
        files.sort((a, b) => a.name.localeCompare(b.name))
        const archive = archiver('zip', { zlib: { level: 6 } })
        let current: Readable | undefined,
          wire = 0
        archive.on('warning', () =>
          archive.destroy(new OutputReadError('OUTPUT_IO_FAILED'))
        )
        const counter = new Transform({
          transform(chunk: unknown, _encoding, callback) {
            if (!Buffer.isBuffer(chunk) || chunk.length > MAX_ZIP - wire) {
              callback(new OutputReadError('INVALID_OUTPUT'))
              return
            }
            wire += chunk.length
            callback(null, chunk)
          },
        })
        response.attachment('output.zip')
        outputHeaders(response)
        const transfer = pipeline(archive, counter, response, {
          signal: scope.signal,
        })
        const producer = (async () => {
          for (const description of files) {
            scope.signal.throwIfAborted()
            const handle = await reader.open(description)
            current = Readable.from(
              bytes(handle, description.stat.size, scope.signal, reader.read)
            )
            archive.append(current, { name: description.name })
            await finished(current, { cleanup: true })
            current = undefined
            await reader.close()
          }
          await archive.finalize()
        })()
        try {
          await Promise.all([transfer, producer])
        } catch {
          archive.abort()
          archive.destroy()
          current?.destroy()
          await Promise.allSettled([transfer, producer])
          throw new OutputReadError('OUTPUT_IO_FAILED')
        }
      })
    },
  })
}
