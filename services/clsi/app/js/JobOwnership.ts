import net from 'node:net'
import type Docker from 'dockerode'
import { assertNewPrivateUnixSocketPath } from './PrivateUnixSocketPath.ts'

export const JOB_OWNER_LABEL = 'org.lope.overleaf.compiler-job'
export const JOB_MANAGER_LABEL = 'org.lope.overleaf.managed-by'
export const JOB_MANAGER = 'ephemeral-docker-job-v1'
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export function jobName(identity: string): string {
  if (!UUID.test(identity)) throw new Error('Invalid compiler job identity')
  return `lope-clsi-job-${identity}`
}
export function jobLabels(identity: string): Record<string, string> {
  jobName(identity)
  return { [JOB_OWNER_LABEL]: identity, [JOB_MANAGER_LABEL]: JOB_MANAGER }
}
export function checkJobOwnership(
  labels: Readonly<Record<string, string>> | undefined,
  identity: string
): void {
  jobName(identity)
  if (
    labels?.[JOB_OWNER_LABEL] !== identity ||
    labels[JOB_MANAGER_LABEL] !== JOB_MANAGER
  )
    throw new Error('Docker resource ownership mismatch; preserved')
}
/** Dedicated worker singleton guard. Never unlink an existing endpoint.
 * All managers for this daemon must use the same protected socket path.
 * SIGKILL may leave a stale socket: recovery intentionally requires an operator.
 */
export class CompilerLease {
  private held = true
  private owner: object | undefined
  private readonly server: net.Server
  private constructor(server: net.Server) {
    this.server = server
    server.on('close', () => {
      this.held = false
    })
    server.on('error', () => {
      this.held = false
      server.close()
    })
  }
  static async acquire(socketPath: string): Promise<CompilerLease> {
    await assertNewPrivateUnixSocketPath(socketPath)
    const server = net.createServer(socket => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        reject(error)
      }
      server.once('error', fail)
      server.listen(socketPath, () => {
        server.removeListener('error', fail)
        resolve()
      })
    })
    server.unref()
    return new CompilerLease(server)
  }
  assertHeld(): void {
    if (!this.held || !this.server.listening)
      throw new Error('Compiler exclusive lease is not held')
  }
  claim(owner: object): void {
    this.assertHeld()
    if (this.owner !== undefined && this.owner !== owner)
      throw new Error(
        'Compiler lease already claimed by another admission manager'
      )
    this.owner = owner
  }
  async close(): Promise<void> {
    if (!this.held) return
    this.held = false
    await new Promise<void>((resolve, reject) =>
      this.server.close(error => (error ? reject(error) : resolve()))
    )
  }
}
function missing(error: unknown): boolean {
  return (
    error instanceof Error && 'statusCode' in error && error.statusCode === 404
  )
}
function candidate(
  labels: Readonly<Record<string, string>> | undefined
): string | undefined {
  if (labels?.[JOB_MANAGER_LABEL] !== JOB_MANAGER) return undefined
  const identity = labels[JOB_OWNER_LABEL]
  if (identity === undefined) throw new Error('Missing compiler job identity')
  jobName(identity)
  return identity
}
/** Uses only the dedicated compiler daemon. No label prefix or global prune. */
export class OwnedJobReconciler {
  private pending: Promise<void> | undefined
  private readonly docker: Docker
  private readonly lease: CompilerLease
  constructor(docker: Docker, lease: CompilerLease) {
    this.docker = docker
    this.lease = lease
  }
  assertHeld(): void {
    this.lease.assertHeld()
  }
  claimAdmission(owner: object): void {
    this.lease.claim(owner)
  }
  sweep(
    active: ReadonlySet<string>,
    known: ReadonlySet<string> = new Set()
  ): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.perform(active, known).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async removeContainer(
    container: Docker.Container,
    identity: string,
    active: ReadonlySet<string>
  ): Promise<void> {
    const inspected = await container.inspect()
    checkJobOwnership(inspected.Config.Labels, identity)
    if (inspected.Name !== `/${jobName(identity)}`)
      throw new Error('Compiler container name drift; preserved')
    this.assertHeld()
    if (!active.has(identity)) await container.remove({ force: true, v: true })
  }
  private async removeVolume(
    volume: Docker.Volume,
    identity: string,
    active: ReadonlySet<string>
  ): Promise<void> {
    const inspected = await volume.inspect()
    checkJobOwnership(inspected.Labels, identity)
    if (inspected.Name !== jobName(identity))
      throw new Error('Compiler volume name drift; preserved')
    this.assertHeld()
    if (!active.has(identity)) await volume.remove()
  }
  private async perform(
    active: ReadonlySet<string>,
    known: ReadonlySet<string>
  ): Promise<void> {
    this.assertHeld()
    const failures: unknown[] = []
    const filters = { label: [`${JOB_MANAGER_LABEL}=${JOB_MANAGER}`] }
    const containers = await this.docker.listContainers({ all: true, filters })
    for (const listed of containers) {
      try {
        const identity = candidate(listed.Labels)
        if (identity === undefined || active.has(identity)) continue
        if (!listed.Names.includes(`/${jobName(identity)}`))
          throw new Error('Compiler container name mismatch; preserved')
        await this.removeContainer(
          this.docker.getContainer(listed.Id),
          identity,
          active
        )
      } catch (error) {
        if (!missing(error)) failures.push(error)
      }
    }
    // Failed active jobs remain known even if ownership drift hides them from
    // filtered listings. Only exact generated names are inspected; never prune.
    for (const identity of known) {
      if (active.has(identity)) continue
      try {
        await this.removeContainer(
          this.docker.getContainer(jobName(identity)),
          identity,
          active
        )
      } catch (error) {
        if (!missing(error)) failures.push(error)
      }
    }
    this.assertHeld()
    const volumes = await this.docker.listVolumes({ filters })
    for (const listed of volumes.Volumes ?? []) {
      try {
        const identity = candidate(listed.Labels)
        if (identity === undefined || active.has(identity)) continue
        if (listed.Name !== jobName(identity))
          throw new Error('Compiler volume name mismatch; preserved')
        await this.removeVolume(
          this.docker.getVolume(listed.Name),
          identity,
          active
        )
      } catch (error) {
        if (!missing(error)) failures.push(error)
      }
    }
    for (const identity of known) {
      if (active.has(identity)) continue
      try {
        await this.removeVolume(
          this.docker.getVolume(jobName(identity)),
          identity,
          active
        )
      } catch (error) {
        if (!missing(error)) failures.push(error)
      }
    }
    this.assertHeld()
    if (failures.length)
      throw new AggregateError(
        failures,
        'Compiler reconciliation failed; resources preserved where cleanup failed'
      )
  }
  async close(): Promise<void> {
    if (this.pending) await this.pending
    await this.lease.close()
  }
}
