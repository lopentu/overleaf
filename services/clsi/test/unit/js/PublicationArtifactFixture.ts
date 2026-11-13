import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CompilerAdmission,
  WorkflowScope,
} from '../../../app/js/CompilerAdmission.ts'
import type {
  CompileArtifactJobResult,
  JobRequest,
} from '../../../app/js/JobRequest.ts'
import { withSourceFixture } from './SourceInputFixture.ts'

/** Concrete synthetic filesystem port, never a Docker/compiler claim. Only a
 * genuine manager runArtifacts call can complete its checked destination. */
export async function executeFilesystemArtifacts(
  request: JobRequest
): Promise<CompileArtifactJobResult> {
  await fs.rename(`${request.outputDirectory}.pending`, request.outputDirectory)
  const summary = { entries: 1, files: 0, bytes: 0 }
  const pending = [request.outputDirectory]
  while (pending.length) {
    const directory = pending.pop()
    if (directory === undefined) throw new Error('Missing fixture directory')
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name),
        stat = await fs.lstat(file)
      summary.entries++
      if (stat.isDirectory()) pending.push(file)
      else if (stat.isFile()) {
        summary.files++
        summary.bytes += stat.size
      }
    }
  }
  return {
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    outputDirectory: request.outputDirectory,
    output: {
      original: { entries: 1, files: 0, bytes: 0 },
      generated: summary,
      retained: summary,
      namespaceEntries: summary.entries,
    },
  }
}
export async function completePublicationArtifacts(
  scope: WorkflowScope,
  inputDirectory: string,
  directory: string
): Promise<CompileArtifactJobResult> {
  await fs.rename(directory, `${directory}.pending`)
  return await scope.runArtifacts({
    image: `sha256:${'a'.repeat(64)}`,
    argv: ['/usr/bin/pdflatex'],
    cwd: '/compile',
    inputDirectory,
    outputDirectory: directory,
    timeoutMs: 1000,
  })
}
export async function withPublicationFixture(
  use: Parameters<typeof withSourceFixture>[0],
  executor?: ConstructorParameters<typeof CompilerAdmission>[0]
): Promise<void> {
  return await withSourceFixture(
    use,
    executor ?? {
      async run() {
        throw new Error(
          'Publication fixture only executes artifact filesystem jobs'
        )
      },
      runArtifacts: executeFilesystemArtifacts,
    }
  )
}
