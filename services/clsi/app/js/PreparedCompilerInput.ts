import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertActiveWorkflowScope,
  validatePrivateCompileDirectory,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import {
  INPUT_LIMITS,
  canonicalProjectArchivePath,
} from './BoundedProjectArchive.ts'
import {
  withCompileInputSnapshot,
  type CompileInputSnapshotRequest,
} from './CompileInputSnapshot.ts'
import { readFileChunks } from './ArchiveFileIo.ts'

export interface PreparedCompileOptions {
  readonly mainFile: string
  readonly compiler: string
  readonly flags: readonly string[]
  readonly draft: boolean
  readonly stopOnFirstError: boolean
  readonly timeoutMs: number
  readonly imageName?: string | undefined
  readonly buildId?: string | undefined
  readonly check?: string | undefined
  readonly enableCheckpoint: boolean
}
const DRAFT_PREFIX =
  '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}'
function refused(): Error {
  return new Error('Invalid bounded compiler preparation')
}
async function boundedMainFile(
  directory: string,
  name: string,
  signal: AbortSignal,
  files: PreparationFileOwner
): Promise<{ content: string; stat: Stats }> {
  const destination = path.join(directory, name)
  if ((await fs.realpath(destination)) !== destination) throw refused()
  const file = await files.open(
    destination,
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.uid !== process.geteuid?.() ||
      stat.nlink !== 1 ||
      stat.size > INPUT_LIMITS.maxFileBytes
    )
      throw refused()
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of readFileChunks(file, signal)) {
      size += chunk.length
      if (size > stat.size) throw refused()
      chunks.push(chunk)
    }
    const after = await file.stat()
    if (
      size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size
    )
      throw refused()
    return { content: Buffer.concat(chunks).toString('utf8'), stat }
  } finally {
    await files.close()
  }
}
async function inputNamespace(
  directory: string,
  signal: AbortSignal
): Promise<{ entries: number; bytes: number }> {
  let entries = 1,
    bytes = 0
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    if (current === undefined) throw refused()
    for await (const entry of await fs.opendir(current)) {
      signal.throwIfAborted()
      if (++entries > INPUT_LIMITS.maxEntries) throw refused()
      const child = path.join(current, entry.name),
        stat = await fs.lstat(child)
      if (
        stat.uid !== process.geteuid?.() ||
        (stat.mode & 0o022) !== 0 ||
        stat.isSymbolicLink()
      )
        throw refused()
      if (stat.isDirectory()) pending.push(child)
      else if (!stat.isFile() || stat.nlink !== 1) throw refused()
      else {
        bytes += stat.size
        if (
          stat.size > INPUT_LIMITS.maxFileBytes ||
          bytes > INPUT_LIMITS.maxTotalBytes
        )
          throw refused()
      }
    }
  }
  return { entries, bytes }
}
/** At most one concrete preparation descriptor. Failed close remains reachable by
 * the existing factory transaction cleanup; retry never depends on a removed path. */
const construction = Symbol('compiler-input')
export class PreparationFileOwner {
  #file: fs.FileHandle | undefined
  get hasOpenFile(): boolean {
    return this.#file !== undefined
  }
  async open(
    name: string,
    flags: number,
    mode = 0o600
  ): Promise<fs.FileHandle> {
    if (this.#file !== undefined) throw refused()
    this.#file = await fs.open(name, flags, mode)
    return this.#file
  }
  async close(): Promise<void> {
    const file = this.#file
    if (file === undefined) return
    try {
      await file.close()
    } catch {
      throw refused()
    }
    this.#file = undefined
  }
}

/** Privately constructed only after real bounded content preparation and sealed
 * snapshot completion. No registry, eligibility boolean, or runtime qualification. */
export class PreparedCompilerInput {
  readonly scope: WorkflowScope
  readonly manager: CompilerAdmission
  readonly inputDirectory: string
  readonly outputDirectory: string
  readonly options: PreparedCompileOptions
  #live = true
  private constructor(
    authority: typeof construction,
    scope: WorkflowScope,
    manager: CompilerAdmission,
    inputDirectory: string,
    outputDirectory: string,
    options: PreparedCompileOptions
  ) {
    if (authority !== construction)
      throw new Error('Invalid preparation construction')
    this.scope = scope
    this.manager = manager
    this.inputDirectory = inputDirectory
    this.outputDirectory = outputDirectory
    this.options = options
    Object.freeze(this)
  }
  static require(
    prepared: unknown,
    inputDirectory: string,
    projectId: string
  ): PreparedCompileOptions {
    if (!(prepared instanceof PreparedCompilerInput) || !prepared.#live)
      throw refused()
    assertActiveWorkflowScope(prepared.scope, prepared.manager)
    if (
      prepared.inputDirectory !== inputDirectory ||
      prepared.scope.metadata.kind !== 'compile' ||
      prepared.scope.metadata.projectId !== projectId
    )
      throw refused()
    prepared.scope.signal.throwIfAborted()
    return prepared.options
  }
  static async withInput<T>(
    scope: WorkflowScope,
    manager: CompilerAdmission,
    source: CompileInputSnapshotRequest,
    kind: 'full' | 'history-full',
    configured: PreparedCompileOptions,
    files: PreparationFileOwner,
    use: (prepared: PreparedCompilerInput) => Promise<T>
  ): Promise<T> {
    assertActiveWorkflowScope(scope, manager, true)
    if (scope.metadata.kind !== 'compile') throw refused()
    const {
      mainFile,
      compiler,
      draft,
      stopOnFirstError,
      timeoutMs,
      imageName,
      buildId,
      check,
      enableCheckpoint,
    } = configured
    const options = Object.freeze({
      mainFile,
      compiler,
      draft,
      stopOnFirstError,
      timeoutMs,
      imageName,
      buildId,
      check,
      enableCheckpoint,
      flags: Object.freeze([...configured.flags]),
    })
    const { sourceRoot, sourceDirectory, stagingRoot } = source
    validatePrivateCompileDirectory(sourceRoot)
    validatePrivateCompileDirectory(sourceDirectory)
    if (
      !sourceDirectory.startsWith(sourceRoot + path.sep) ||
      !mainFile.endsWith('.tex')
    )
      throw refused()
    canonicalProjectArchivePath(mainFile, false)
    scope.signal.throwIfAborted()
    const namespace = await inputNamespace(sourceDirectory, scope.signal)
    const main = await boundedMainFile(
      sourceDirectory,
      mainFile,
      scope.signal,
      files
    )
    const content = (draft ? DRAFT_PREFIX : '') + main.content,
      bytes = Buffer.byteLength(content)
    if (bytes > INPUT_LIMITS.maxFileBytes) throw refused()
    let hasOutput = false
    try {
      hasOutput = (
        await fs.lstat(path.join(sourceDirectory, 'output.tex'))
      ).isFile()
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error
    }
    const scan =
      kind === 'history-full'
        ? content
        : Buffer.from(content).subarray(0, 65536).toString('utf8')
    const copyOutput =
      !hasOutput &&
      (scan.includes('\\tikzexternalize') || scan.includes('{pstool}'))
    if (
      (copyOutput && namespace.entries >= INPUT_LIMITS.maxEntries) ||
      namespace.bytes +
        Math.max(0, bytes - main.stat.size) +
        (copyOutput ? bytes : 0) >
        INPUT_LIMITS.maxTotalBytes
    )
      throw refused()
    if (copyOutput) {
      const file = await files.open(
        path.join(sourceDirectory, 'output.tex'),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      )
      try {
        await file.writeFile(content, {
          encoding: 'utf8',
          signal: scope.signal,
        })
      } finally {
        await files.close()
      }
    }
    if (draft) {
      const file = await files.open(
        path.join(sourceDirectory, mainFile),
        constants.O_WRONLY | constants.O_NOFOLLOW
      )
      try {
        const current = await file.stat()
        if (
          current.dev !== main.stat.dev ||
          current.ino !== main.stat.ino ||
          current.nlink !== 1 ||
          current.size !== main.stat.size ||
          current.mtimeMs !== main.stat.mtimeMs
        )
          throw refused()
        scope.signal.throwIfAborted()
        await file.writeFile(content, {
          encoding: 'utf8',
          signal: scope.signal,
        })
        await file.truncate(bytes)
      } finally {
        await files.close()
      }
    }
    return await withCompileInputSnapshot(
      { sourceRoot, sourceDirectory, stagingRoot, signal: scope.signal },
      async snapshot => {
        assertActiveWorkflowScope(scope, manager, true)
        const prepared = new PreparedCompilerInput(
          construction,
          scope,
          manager,
          snapshot.inputDirectory,
          path.join(stagingRoot, 'artifacts-' + randomUUID()),
          options
        )
        try {
          return await use(prepared)
        } finally {
          prepared.#live = false
        }
      }
    )
  }
}
export function requirePreparedCompilerInput(
  prepared: unknown,
  inputDirectory: string,
  projectId: string
): PreparedCompileOptions {
  return PreparedCompilerInput.require(prepared, inputDirectory, projectId)
}
