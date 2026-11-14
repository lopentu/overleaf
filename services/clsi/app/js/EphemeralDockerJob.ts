import { snapshotCompilerProfiles } from './CompileEnvironment.ts'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type Docker from 'dockerode'
import {
  createInputArchiveBundle,
  createManifestInputArchiveBundle,
  extractCompileOutputArchive,
  extractOutputArchive,
} from './BoundedProjectArchive.ts'
import { collectExecOutput } from './DockerExecOutput.ts'
import { checkJobOwnership, jobLabels, jobName } from './JobOwnership.ts'
import {
  compileEnvironment,
  snapshotExecutionRequest,
  validateRequest,
  validateStdoutRequest,
  type StdoutJobRequest,
  type StdoutJobResult,
  type CompileArtifactJobResult,
  type JobPolicy,
  type JobRequest,
  type JobResult,
} from './JobRequest.ts'
import {
  sandboxResourceLimits,
  sandboxTemporaryDirectories,
} from './SandboxResources.mjs'
export type {
  JobPolicy,
  JobRequest,
  JobResult,
  StdoutJobRequest,
  StdoutJobResult,
  CompileArtifactJobResult,
} from './JobRequest.ts'
type GenericMode = { mode: 'generic'; request: JobRequest }
type ArtifactMode = { mode: 'artifacts'; request: JobRequest }
type StdoutMode = { mode: 'stdout'; request: StdoutJobRequest }

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'statusCode' in error && error.statusCode === 404
  )
}
/**
 * Internal CLSI worker adapter. Never instantiate/expose a Docker client in web.
 * API promises are settled before final cleanup, retaining late successful creates.
 * Cancellation is not a hard API deadline: a hung daemon can delay return. A
 * disconnected create reply also cannot prove that the daemon finished creating;
 * ambiguous errors still need external label-based reconciliation.
 */
export class EphemeralDockerJob {
  private readonly docker: Docker
  private readonly policy: JobPolicy

  constructor(docker: Docker, policy: JobPolicy) {
    this.docker = docker
    const {
      trustedStagingRoot,
      allowedImages,
      allowedExecutables,
      compilerProfiles,
    } = policy
    this.policy = Object.freeze({
      trustedStagingRoot,
      allowedImages: Object.freeze([...allowedImages]),
      allowedExecutables: Object.freeze([...allowedExecutables]),
      compilerProfiles: snapshotCompilerProfiles(compilerProfiles),
    })
  }
  async run(
    request: JobRequest,
    identity: string = randomUUID()
  ): Promise<JobResult> {
    return this.execute({ mode: 'generic', request }, identity)
  }
  runArtifacts(
    request: JobRequest,
    identity: string = randomUUID()
  ): Promise<CompileArtifactJobResult> {
    return this.execute({ mode: 'artifacts', request }, identity)
  }
  runStdout(
    request: StdoutJobRequest,
    identity: string = randomUUID()
  ): Promise<StdoutJobResult> {
    return this.execute({ mode: 'stdout', request }, identity)
  }
  private execute(input: GenericMode, identity: string): Promise<JobResult>
  private execute(
    input: ArtifactMode,
    identity: string
  ): Promise<CompileArtifactJobResult>
  private execute(input: StdoutMode, identity: string): Promise<StdoutJobResult>
  private async execute(
    input: GenericMode | ArtifactMode | StdoutMode,
    identity: string
  ): Promise<JobResult | CompileArtifactJobResult | StdoutJobResult> {
    if (input.mode === 'stdout') {
      if ('outputDirectory' in input.request)
        throw new Error('stdout request must not have outputDirectory')
      input = {
        mode: 'stdout',
        request: snapshotExecutionRequest(input.request),
      }
    } else {
      const outputDirectory = input.request.outputDirectory
      const checked = Object.freeze({
        ...snapshotExecutionRequest(input.request),
        outputDirectory,
      })
      input =
        input.mode === 'artifacts'
          ? { mode: 'artifacts', request: checked }
          : { mode: 'generic', request: checked }
    }
    const request = input.request
    const environment = Object.freeze(compileEnvironment(request, this.policy))
    const name = jobName(identity)
    if (input.mode === 'stdout')
      await validateStdoutRequest(input.request, this.policy)
    else await validateRequest(input.request, this.policy)
    const labels = jobLabels(identity)
    const controller = new AbortController()
    const cancel = (): void => {
      controller.abort(request.signal?.reason)
    }
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()
    const timer = setTimeout(() => {
      controller.abort(new Error('Compile deadline exceeded'))
    }, request.timeoutMs)
    const signal = controller.signal
    let volumeAttempted = false
    let containerAttempted = false
    let container = this.docker.getContainer(name)
    const volume = this.docker.getVolume(name)
    let paused = false
    let result:
      | JobResult
      | CompileArtifactJobResult
      | StdoutJobResult
      | undefined
    let failure: unknown
    let failed = false
    const cleanupErrors: unknown[] = []
    try {
      signal.throwIfAborted()
      volumeAttempted = true
      await this.docker.createVolume({
        Name: name,
        Driver: 'local',
        Labels: labels,
        DriverOpts: {
          type: 'tmpfs',
          device: 'tmpfs',
          o: 'size=256m,uid=33,gid=33,mode=0700,nodev,nosuid,noexec',
        },
      })
      signal.throwIfAborted()
      checkJobOwnership((await volume.inspect()).Labels, identity)
      signal.throwIfAborted()
      const options: Docker.ContainerCreateOptions = {
        name,
        Image: request.image,
        User: '33:33',
        WorkingDir: '/compile',
        // Image ENTRYPOINT is intentionally overridden; no job-provided shell.
        Entrypoint: ['/bin/sleep'],
        Cmd: ['infinity'],
        Env: [...environment],
        NetworkDisabled: true,
        Tty: false,
        OpenStdin: false,
        Labels: labels,
        HostConfig: {
          ...sandboxResourceLimits(),
          ReadonlyRootfs: true,
          LogConfig: { Type: 'none', Config: {} },
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          Tmpfs: sandboxTemporaryDirectories(),
          AutoRemove: false,
          Mounts: [
            {
              Type: 'volume',
              Source: name,
              Target: '/compile',
              ReadOnly: false,
              VolumeOptions: {
                NoCopy: true,
                Labels: labels,
                DriverConfig: { Name: 'local', Options: {} },
              },
            },
          ],
        },
      }
      containerAttempted = true
      container = await this.docker.createContainer(options)
      signal.throwIfAborted()
      checkJobOwnership((await container.inspect()).Config.Labels, identity)
      signal.throwIfAborted()
      await container.start()
      signal.throwIfAborted()
      const { stream: archive, completion: producerDone } =
        input.mode === 'artifacts'
          ? createManifestInputArchiveBundle(request.inputDirectory, { signal })
          : createInputArchiveBundle(request.inputDirectory, { signal })
      const archiveDone = finished(archive, { cleanup: true })
      void archiveDone.catch(() => {})
      let transferFailure: { error: unknown } | undefined
      try {
        await container.putArchive(archive, {
          path: '/compile',
          noOverwriteDirNonDir: true,
        })
        await archiveDone
        signal.throwIfAborted()
      } catch (error) {
        transferFailure = { error }
      }
      archive.destroy()
      // Source reads can outlive stream close. Keep admission/resource ownership
      // until the producer and its file owners settle, even after cancellation.
      const [, producer] = await Promise.allSettled([archiveDone, producerDone])
      if (producer.status === 'rejected') {
        if (
          transferFailure !== undefined &&
          transferFailure.error !== producer.reason
        )
          throw new AggregateError(
            [transferFailure.error, producer.reason],
            'Docker input upload and archive producer failed',
            { cause: transferFailure.error }
          )
        throw producer.reason
      }
      if (transferFailure !== undefined) throw transferFailure.error
      const exec = await container.exec({
        Cmd: [...request.argv],
        User: '33:33',
        WorkingDir: request.cwd,
        Env: [...environment],
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
        Privileged: false,
      })
      signal.throwIfAborted()
      // start returns the stream before it ends; collect installs cancellation.
      const stream = await exec.start({
        hijack: false,
        stdin: false,
        Detach: false,
        Tty: false,
      })
      const output = await collectExecOutput(this.docker, stream, signal)
      signal.throwIfAborted()
      const execution = await exec.inspect()
      signal.throwIfAborted()
      if (
        execution.Running ||
        !Number.isSafeInteger(execution.ExitCode) ||
        execution.ExitCode === null
      )
        throw new Error('Compiler exec has no terminal exit status')
      if (input.mode === 'stdout') {
        result = { exitCode: execution.ExitCode, ...output }
      } else {
        await container.pause()
        paused = true
        signal.throwIfAborted()
        const outputStream = await container.getArchive({ path: '/compile' })
        if (!(outputStream instanceof Readable))
          throw new Error('Docker archive response is not a Readable')
        if (input.mode === 'artifacts') {
          if (producer.value === undefined)
            throw new Error('Missing upload manifest')
          const summary = await extractCompileOutputArchive(
            outputStream,
            input.request.outputDirectory,
            producer.value,
            output,
            { signal }
          )
          result = {
            exitCode: execution.ExitCode,
            ...output,
            output: summary,
            outputDirectory: input.request.outputDirectory,
          }
        } else {
          const summary = await extractOutputArchive(
            outputStream,
            input.request.outputDirectory,
            { signal, requiredPrefix: 'compile' }
          )
          result = {
            exitCode: execution.ExitCode,
            ...output,
            output: summary,
            outputDirectory: input.request.outputDirectory,
          }
        }
        signal.throwIfAborted()
      }
    } catch (error) {
      failed = true
      failure = error
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', cancel)
      if (containerAttempted) {
        try {
          checkJobOwnership((await container.inspect()).Config.Labels, identity)
          if (paused) {
            try {
              await container.unpause()
            } catch (error) {
              if (!isMissing(error)) cleanupErrors.push(error)
            }
          }
          await container.remove({ force: true, v: true })
        } catch (error) {
          if (!isMissing(error)) cleanupErrors.push(error)
        }
      }
      // Always attempt the independently owned volume, even if container cleanup
      // throws. Busy/error responses are explicit incomplete-cleanup failures.
      if (volumeAttempted) {
        try {
          checkJobOwnership((await volume.inspect()).Labels, identity)
          await volume.remove()
        } catch (error) {
          if (!isMissing(error)) cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        failed ? [failure, ...cleanupErrors] : cleanupErrors,
        `Job ${identity} cleanup incomplete: container/volume ${name}`
      )
    if (failed) throw failure
    if (result === undefined) throw new Error('Job completed without result')
    return result
  }
}
