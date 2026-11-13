import * as fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ArchiveSummary,
  CompileArchiveSummary,
} from './BoundedProjectArchive.ts'

/** Preserve the legacy CLSI ten-minute request maximum across all job modes. */
export const MAX_COMPILE_TIMEOUT_MS = 600_000

export interface JobPolicy {
  trustedStagingRoot: string
  allowedImages: readonly string[]
  allowedExecutables: readonly string[]
}
export interface ExecutionRequest {
  image: string
  argv: readonly string[]
  cwd: string
  inputDirectory: string
  timeoutMs: number
  environment?: Readonly<Record<string, string>>
  signal?: AbortSignal
}
export interface JobRequest extends ExecutionRequest {
  outputDirectory: string
}
export interface StdoutJobRequest extends ExecutionRequest {
  outputDirectory?: never
}
export interface StdoutJobResult {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
}
export interface CompileArtifactJobResult extends StdoutJobResult {
  output: CompileArchiveSummary
  outputDirectory: string
}
export interface JobResult extends StdoutJobResult {
  output: ArchiveSummary
  outputDirectory: string
}
const PINNED_IMAGE = /^(?:sha256:|[a-zA-Z0-9./:_-]+@sha256:)[a-f0-9]{64}$/
const ENVIRONMENT_KEYS = new Set([
  'SOURCE_DATE_EPOCH',
  'FORCE_SOURCE_DATE',
  'TZ',
])
function requireSafeString(value: string): void {
  if (value.length === 0) throw new Error('Invalid job string')
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) throw new Error('Invalid job string')
  }
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
/** Caller owns this private staging tree and must keep it immutable for the job. */
async function validateCommonRequest(
  request: ExecutionRequest,
  policy: JobPolicy
): Promise<void> {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_COMPILE_TIMEOUT_MS
  )
    throw new Error('Invalid compile deadline')
  if (
    !PINNED_IMAGE.test(request.image) ||
    !policy.allowedImages.includes(request.image)
  )
    throw new Error('Image is not an approved immutable pin')
  if (
    request.argv.length === 0 ||
    request.argv.length > 256 ||
    !policy.allowedExecutables.includes(request.argv[0] ?? '') ||
    !request.argv[0]?.startsWith('/')
  )
    throw new Error('Executable is not approved')
  for (const arg of request.argv) requireSafeString(arg)
  if (
    request.argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) >
    64 * 1024
  )
    throw new Error('Arguments exceed limit')
  if (
    request.cwd !== '/compile' &&
    (!request.cwd.startsWith('/compile/') ||
      request.cwd
        .split('/')
        .slice(2)
        .some(part => part === '' || part === '.' || part === '..'))
  )
    throw new Error('Invalid compile working directory')
  requireSafeString(request.cwd)
  if (request.cwd.includes('\\'))
    throw new Error('Invalid compile working directory')
  for (const [key, value] of Object.entries(request.environment ?? {})) {
    if (!ENVIRONMENT_KEYS.has(key) || Buffer.byteLength(value) > 1024)
      throw new Error('Unapproved compile environment')
    requireSafeString(value)
  }
  const root = path.resolve(policy.trustedStagingRoot)
  const input = path.resolve(request.inputDirectory)
  if (
    root !== (await fs.realpath(root)) ||
    input !== (await fs.realpath(input)) ||
    !inside(root, input)
  )
    throw new Error('Unsafe staging path')
  await trustedDirectories([root, input])
  if (((await fs.stat(root)).mode & 0o077) !== 0)
    throw new Error('Staging root is not private')
}
async function trustedDirectories(
  directories: readonly string[]
): Promise<void> {
  for (const directory of directories) {
    const stat = await fs.lstat(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error('Staging directory is not trusted')
  }
}
export async function validateStdoutRequest(
  request: StdoutJobRequest,
  policy: JobPolicy
): Promise<void> {
  if ('outputDirectory' in request)
    throw new Error('stdout request must not have outputDirectory')
  await validateCommonRequest(request, policy)
}
export async function validateRequest(
  request: JobRequest,
  policy: JobPolicy
): Promise<void> {
  await validateCommonRequest(request, policy)
  const root = path.resolve(policy.trustedStagingRoot),
    input = path.resolve(request.inputDirectory),
    output = path.resolve(request.outputDirectory)
  if (
    !inside(root, output) ||
    input === output ||
    inside(input, output) ||
    inside(output, input)
  )
    throw new Error('Unsafe staging path')
  await trustedDirectories([path.dirname(output)])
  try {
    await fs.lstat(output)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  throw new Error('Output directory already exists')
}
export function compileEnvironment(request: ExecutionRequest): string[] {
  return Object.entries({
    HOME: '/home/tex',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TEXMFVAR: '/tmp/texmf-var',
    TEXMFCONFIG: '/tmp/texmf-config',
    ...request.environment,
  }).map(([key, value]) => `${key}=${value}`)
}
