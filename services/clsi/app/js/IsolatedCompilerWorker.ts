import { lstat, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import Docker from 'dockerode'
import express from 'express'
import { startClsiListeners, type ClsiListeners } from './ClsiListener.ts'
import {
  CompilerAdmission,
  validatePrivateCompileDirectory,
} from './CompilerAdmission.ts'
import {
  snapshotCompilerProfiles,
  type TrustedCompilerProfile,
} from './CompileEnvironment.ts'
import { openCompilerWorkflow } from './CompilerWorkflow.ts'
import { createCompilerWorkflowRouter } from './CompilerWorkflowHttp.ts'
import { EphemeralDockerJob } from './EphemeralDockerJob.ts'
import { CompilerLease, OwnedJobReconciler } from './JobOwnership.ts'
import { assertNewPrivateUnixSocketPath } from './PrivateUnixSocketPath.ts'

const DAEMON_ROLE_KEY = 'org.lope.overleaf.compiler-worker'
const DAEMON_ROLE = `${DAEMON_ROLE_KEY}=dedicated`

export interface IsolatedCompilerWorkerConfiguration {
  /** Bind-mount this whole private directory once and share it across all worker
   * instances for the daemon. Never bind-mount the Docker socket alone. */
  readonly runtimeRoot: string
  readonly stateRoot: string
  readonly dockerSocket: string
  readonly daemonId: string
  readonly profile: TrustedCompilerProfile
  readonly downloadHost: string
  readonly outputUrlPrefix: string
}

async function checkDockerSocket(socketPath: string): Promise<void> {
  const uid = process.geteuid?.()
  if (
    uid === undefined ||
    !path.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > 100 ||
    (await realpath(socketPath)) !== socketPath
  )
    throw new Error('ISOLATED_DOCKER_SOCKET_UNSAFE')
  const socket = await lstat(socketPath)
  if (
    !socket.isSocket() ||
    (socket.uid !== 0 && socket.uid !== uid) ||
    (socket.mode & 0o007) !== 0
  )
    throw new Error('ISOLATED_DOCKER_SOCKET_UNSAFE')
  for (let parent = path.dirname(socketPath); ; parent = path.dirname(parent)) {
    const directory = await lstat(parent)
    const rootSticky = directory.uid === 0 && (directory.mode & 0o1000) !== 0
    if (
      !directory.isDirectory() ||
      (directory.uid !== 0 && directory.uid !== uid) ||
      ((directory.mode & 0o022) !== 0 && !rootSticky)
    )
      throw new Error('ISOLATED_DOCKER_SOCKET_UNSAFE')
    if (parent === path.dirname(parent)) break
  }
}

/** The provisioner owns the dedicated daemon and its private socket directory.
 * The daemon and both worker sockets share that directory so every instance
 * sees the same lease. Verify daemon identity before reconciliation. */
export async function startIsolatedCompilerWorker({
  runtimeRoot,
  stateRoot,
  dockerSocket,
  daemonId,
  profile,
  downloadHost,
  outputUrlPrefix,
}: IsolatedCompilerWorkerConfiguration): Promise<{ close(): Promise<void> }> {
  const profiles = snapshotCompilerProfiles([profile])
  const [compiler] = profiles
  const outputOrigin = new URL(downloadHost)
  if (
    compiler === undefined ||
    !/^sha256:[0-9a-f]{64}$/.test(compiler.image) ||
    !/^[a-zA-Z0-9:._-]{1,128}$/.test(daemonId) ||
    !['http:', 'https:'].includes(outputOrigin.protocol) ||
    outputOrigin.origin !== downloadHost
  )
    throw new Error('ISOLATED_WORKER_CONFIGURATION_INVALID')

  const stagingRoot = path.join(stateRoot, 'operations')
  const sourceCacheRoot = path.join(stateRoot, 'plans')
  const outputRoot = path.join(stateRoot, 'published')
  for (const directory of [
    runtimeRoot,
    stateRoot,
    stagingRoot,
    sourceCacheRoot,
    outputRoot,
  ])
    validatePrivateCompileDirectory(directory)
  if (
    runtimeRoot === stateRoot ||
    runtimeRoot.startsWith(stateRoot + path.sep) ||
    stateRoot.startsWith(runtimeRoot + path.sep) ||
    (await lstat(stagingRoot)).dev !== (await lstat(outputRoot)).dev
  )
    throw new Error('ISOLATED_WORKER_CONFIGURATION_INVALID')

  if (dockerSocket !== path.join(runtimeRoot, 'docker.sock'))
    throw new Error('ISOLATED_DOCKER_SOCKET_UNSAFE')
  const unixSocket = path.join(runtimeRoot, 'clsi.sock')
  const leaseSocket = path.join(runtimeRoot, 'manager.sock')
  await assertNewPrivateUnixSocketPath(unixSocket)
  await checkDockerSocket(dockerSocket)
  const docker = new Docker({
    socketPath: dockerSocket,
    version: 'v1.47',
    timeout: 30000,
  })
  const daemon: {
    ID?: string
    Labels?: string[]
    SecurityOptions?: string[]
    CgroupDriver?: string
    CgroupVersion?: string
  } = await docker.info()
  const roleLabels = daemon.Labels?.filter(label =>
    label.startsWith(`${DAEMON_ROLE_KEY}=`)
  )
  if (
    daemon.ID !== daemonId ||
    roleLabels?.length !== 1 ||
    roleLabels[0] !== DAEMON_ROLE ||
    !daemon.SecurityOptions?.includes('name=apparmor') ||
    !daemon.SecurityOptions.includes('name=seccomp,profile=builtin') ||
    daemon.CgroupDriver !== 'systemd' ||
    daemon.CgroupVersion !== '2'
  )
    throw new Error('ISOLATED_DAEMON_UNQUALIFIED')
  if ((await docker.getImage(compiler.image).inspect()).Id !== compiler.image)
    throw new Error('ISOLATED_COMPILER_IMAGE_UNQUALIFIED')

  const adapter = new EphemeralDockerJob(docker, {
    trustedStagingRoot: stagingRoot,
    allowedImages: [compiler.image],
    allowedExecutables: Object.values(compiler.tools),
    compilerProfiles: profiles,
  })
  const lease = await CompilerLease.acquire(leaseSocket)
  let manager: CompilerAdmission | undefined
  let listeners: ClsiListeners | undefined
  let managerStarted = false
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    closing ??= (async () => {
      const failures: unknown[] = []
      try {
        await listeners?.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        // Keep the lease on failed shutdown after admission starts. A failed
        // initial sweep never admitted work, so its runtime can retry startup.
        if (manager && managerStarted) await manager.close()
        else await lease.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Isolated worker cleanup failed')
    })().catch((error: unknown) => {
      closing = undefined
      throw error
    })
    return closing
  }

  try {
    manager = new CompilerAdmission(
      adapter,
      new OwnedJobReconciler(docker, lease)
    )
    const workflow = await openCompilerWorkflow(manager, {
      stagingRoot,
      sourceCacheRoot,
      outputRoot,
      defaultImage: compiler.image,
      profiles,
      publication: {
        optimiseInDocker: true,
        archiveLogs: false,
        strace: false,
        pdfCaching: false,
        clsiCache: false,
      },
    })
    const app = express()
    app.disable('x-powered-by')
    app.use(
      createCompilerWorkflowRouter(manager, workflow, {
        downloadHost,
        outputUrlPrefix,
      })
    )
    await manager.start()
    managerStarted = true
    listeners = await startClsiListeners({
      app,
      unixSocket,
      loadHttpApp: () => {},
      loadTcpServer: createServer(),
      host: '127.0.0.1',
      port: 0,
      loadTcpPort: 0,
      loadHttpPort: 0,
    })
    return Object.freeze({ close })
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Isolated worker startup and cleanup failed',
        { cause: cleanupError }
      )
    }
    throw error
  }
}
