import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MAX_COMPILE_TIMEOUT_MS } from './JobRequest.ts'
import type {
  JobRequest,
  JobResult,
  ExecutionRequest,
  StdoutJobRequest,
  StdoutJobResult,
  CompileArtifactJobResult,
} from './JobRequest.ts'
type GenericJob = { mode: 'generic'; request: JobRequest }
type ArtifactJob = { mode: 'artifacts'; request: JobRequest }
type StdoutJob = { mode: 'stdout'; request: StdoutJobRequest }
import type { OwnedJobReconciler } from './JobOwnership.ts'

type AdmissionCode =
  | 'INVALID_REQUEST'
  | 'NOT_READY'
  | 'CLOSED'
  | 'OVERLOADED'
  | 'CANCELLED'
  | 'QUEUE_DEADLINE'
  | 'RECONCILIATION_FAILED'
  | 'PROJECT_BUSY'
export class AdmissionError extends Error {
  readonly code: AdmissionCode
  constructor(code: AdmissionCode) {
    super(`Compiler admission: ${code}`)
    this.code = code
  }
}
interface JobExecutor {
  run(request: JobRequest, identity?: string): Promise<JobResult>
  runArtifacts?(
    request: JobRequest,
    identity?: string
  ): Promise<CompileArtifactJobResult>
  runStdout?(
    request: StdoutJobRequest,
    identity?: string
  ): Promise<StdoutJobResult>
}
interface Options {
  activeLimit?: number
  queueLimit?: number
  sweepIntervalMs?: number
}
/** output-read means immutable published-build data under its existing output queue, never a mutable compile-directory fallback. */
export interface WorkflowMetadata {
  readonly projectId: string
  readonly userId?: string
  readonly kind: 'compile' | 'wordcount' | 'output-read'
}
export interface WorkflowFilter {
  readonly projectId: string
  readonly userId?: string
  readonly kind?: WorkflowMetadata['kind']
}
export interface AcquireOptions {
  signal?: AbortSignal
  queueTimeoutMs?: number
}
export interface WorkflowScope {
  readonly identity: string
  readonly signal: AbortSignal
  /** Actual copied logical scope; immutable independently of caller metadata. */
  readonly metadata: Readonly<WorkflowMetadata>
  /** Bind one canonical existing private root for this complete lease lifetime.
   * Every workflow job must stay strictly inside it. Cleanup joins owned I/O. */
  ownWorkspace(rootDirectory: string, cleanup: () => Promise<void>): void
  /** One concrete callback may own allocation/cleanup before its root exists. */
  claimWorkspaceCleanup(cleanup: () => Promise<void>): void
  runJob(request: JobRequest): Promise<JobResult>
  runArtifacts(request: JobRequest): Promise<CompileArtifactJobResult>
  runStdout(request: StdoutJobRequest): Promise<StdoutJobResult>
}
const activeWorkflowScopes = new WeakMap<
  WorkflowScope,
  (
    manager?: CompilerAdmission,
    settledJobs?: boolean,
    artifact?: { directory: string; revision?: string }
  ) => string | undefined
>()
/** Brand/check only the existing real manager flow; no independent owner. */
export function assertActiveWorkflowScope(
  scope: WorkflowScope,
  manager?: CompilerAdmission,
  settledJobs = false
): void {
  const check = activeWorkflowScopes.get(scope)
  if (!check) throw new AdmissionError('CLOSED')
  check(manager, settledJobs)
}
/** Read only the current terminal artifact job on this same existing flow.
 * The existing owned job UUID is a revision, never a caller-created marker. */
export function completedArtifactRevision(
  scope: WorkflowScope,
  manager: CompilerAdmission,
  directory: string,
  revision?: string
): string {
  const check = activeWorkflowScopes.get(scope)
  if (!check) throw new AdmissionError('CLOSED')
  const current = check(manager, true, {
    directory,
    ...(revision === undefined ? {} : { revision }),
  })
  if (current === undefined) throw new AdmissionError('INVALID_REQUEST')
  return current
}
export interface WorkflowLease {
  readonly identity: string
  readonly signal: AbortSignal
  /** Resolves only after successful owned cleanup and required reconciliation. */
  readonly closed: Promise<void>
  run<T>(work: (scope: WorkflowScope) => Promise<T>): Promise<T>
}
interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
interface Entry {
  meta: WorkflowMetadata
  directories: readonly string[]
  signal: AbortSignal | undefined
  resolve: (lease: WorkflowLease) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  deadline: number
  cancel: () => void
  legacy?: {
    request: JobRequest
    resolve: (result: JobResult) => void
    reject: (error: unknown) => void
  }
}
interface Flow {
  id: string
  entry: Entry
  controller: AbortController
  cancel: () => void
  started: boolean
  workFinished: boolean
  completed: boolean
  closed: Deferred
  drained: Deferred
  jobPending: Promise<void> | undefined
  inJob: boolean
  jobFailure: { error: unknown } | undefined
  completedArtifact:
    | Readonly<{ directory: string; revision: string }>
    | undefined
  failedJobs: Set<string>
  workspaceRoot: string | undefined
  cleanup: (() => Promise<void>) | undefined
  cleanupAttempt: Promise<void> | undefined
  cleanupFailure: { error: unknown } | undefined
}
interface Control {
  filter: WorkflowFilter
  mode: 'stop' | 'reset' | 'expire'
  clear: () => Promise<void>
  pending: Promise<void> | undefined
  failure: { error: unknown } | undefined
}
function deferred(): Deferred {
  const d = Promise.withResolvers<void>()
  return { promise: d.promise, resolve: d.resolve }
}
function validId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new AdmissionError('INVALID_REQUEST')
}
function copyFilter(filter: WorkflowFilter): WorkflowFilter {
  validId(filter.projectId)
  if (filter.userId !== undefined) validId(filter.userId)
  if (
    filter.kind !== undefined &&
    !['compile', 'wordcount', 'output-read'].includes(filter.kind)
  )
    throw new AdmissionError('INVALID_REQUEST')
  return Object.freeze({
    projectId: filter.projectId,
    ...(filter.userId === undefined ? {} : { userId: filter.userId }),
    ...(filter.kind === undefined ? {} : { kind: filter.kind }),
  })
}
function copyMeta(meta: WorkflowMetadata): WorkflowMetadata {
  const copy = copyFilter(meta)
  if (copy.kind === undefined) throw new AdmissionError('INVALID_REQUEST')
  return Object.freeze({ ...copy, kind: copy.kind })
}
function matches(filter: WorkflowFilter, meta: WorkflowMetadata): boolean {
  return (
    filter.projectId === meta.projectId &&
    (filter.userId === undefined || filter.userId === meta.userId) &&
    (filter.kind === undefined || filter.kind === meta.kind)
  )
}
function controlsOverlap(a: WorkflowFilter, b: WorkflowFilter): boolean {
  return (
    a.projectId === b.projectId &&
    (a.userId === undefined ||
      b.userId === undefined ||
      a.userId === b.userId) &&
    (a.kind === undefined || b.kind === undefined || a.kind === b.kind)
  )
}
function combined(errors: readonly unknown[], message: string): unknown {
  const unique = Array.from(new Set(errors))
  return unique.length === 1
    ? unique[0]
    : new AggregateError(unique, message, { cause: unique[0] })
}
/** Registration is synchronous so it introduces no unjoined I/O lifetime.
 * This bounded metadata check requires trusted, nonconcurrently mutable ancestry;
 * it does not defend against a malicious same-UID/root directory replacement. */
function checkWorkspaceRoot(rootDirectory: string): void {
  try {
    if (
      typeof rootDirectory !== 'string' ||
      !path.isAbsolute(rootDirectory) ||
      path.resolve(rootDirectory) !== rootDirectory ||
      rootDirectory === path.parse(rootDirectory).root ||
      Buffer.byteLength(rootDirectory) > 4096 ||
      Array.from(rootDirectory).some(
        c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
      ) ||
      !process.geteuid ||
      realpathSync(rootDirectory) !== rootDirectory
    )
      throw new AdmissionError('INVALID_REQUEST')
    const uid = process.geteuid(),
      leaf = lstatSync(rootDirectory)
    if (
      !leaf.isDirectory() ||
      leaf.isSymbolicLink() ||
      leaf.uid !== uid ||
      (leaf.mode & 0o7777) !== 0o700
    )
      throw new AdmissionError('INVALID_REQUEST')
    for (
      let ancestor = path.dirname(rootDirectory);
      ;
      ancestor = path.dirname(ancestor)
    ) {
      const info = lstatSync(ancestor)
      const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.uid !== 0 && info.uid !== uid) ||
        ((info.mode & 0o022) !== 0 && !rootSticky)
      )
        throw new AdmissionError('INVALID_REQUEST')
      if (ancestor === path.dirname(ancestor)) break
    }
  } catch {
    throw new AdmissionError('INVALID_REQUEST')
  }
}
function checkWorkspaceJobPaths(
  request: ExecutionRequest & { outputDirectory?: string }
): void {
  try {
    if (realpathSync(request.inputDirectory) !== request.inputDirectory)
      throw new AdmissionError('INVALID_REQUEST')
    if (request.outputDirectory === undefined) return
    if (
      realpathSync(request.inputDirectory) !== request.inputDirectory ||
      realpathSync(path.dirname(request.outputDirectory)) !==
        path.dirname(request.outputDirectory)
    )
      throw new AdmissionError('INVALID_REQUEST')
    try {
      lstatSync(request.outputDirectory)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return
      throw error
    }
  } catch {
    throw new AdmissionError('INVALID_REQUEST')
  }
  throw new AdmissionError('INVALID_REQUEST')
}
function overlap(a: string, b: string): boolean {
  const relative = path.relative(a, b)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
function snapshotCommon(
  project: string,
  request: ExecutionRequest,
  wait: number
): ExecutionRequest {
  if (
    !Number.isSafeInteger(wait) ||
    wait <= 0 ||
    wait > 30_000 ||
    project.length === 0 ||
    project.length > 128 ||
    Array.from(project).some(
      character =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    request.image.length > 512 ||
    request.cwd.length > 4096 ||
    request.inputDirectory.length > 4096 ||
    !path.isAbsolute(request.inputDirectory) ||
    request.argv.length === 0 ||
    request.argv.length > 256 ||
    request.argv.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 65_536 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_COMPILE_TIMEOUT_MS
  )
    throw new AdmissionError('INVALID_REQUEST')
  const environment = Object.entries(request.environment ?? {})
  if (
    environment.length > 3 ||
    environment.some(
      ([key, value]) =>
        !['SOURCE_DATE_EPOCH', 'FORCE_SOURCE_DATE', 'TZ'].includes(key) ||
        Buffer.byteLength(value) > 1024
    )
  )
    throw new AdmissionError('INVALID_REQUEST')
  return {
    image: request.image,
    argv: [...request.argv],
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    environment: Object.fromEntries(environment),
    inputDirectory: path.resolve(request.inputDirectory),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }
}

function snapshot(
  project: string,
  request: JobRequest,
  wait: number
): JobRequest {
  if (
    typeof request.outputDirectory !== 'string' ||
    request.outputDirectory.length > 4096 ||
    !path.isAbsolute(request.outputDirectory)
  )
    throw new AdmissionError('INVALID_REQUEST')
  return {
    ...snapshotCommon(project, request, wait),
    outputDirectory: path.resolve(request.outputDirectory),
  }
}
function snapshotStdout(
  project: string,
  request: StdoutJobRequest
): StdoutJobRequest {
  if ('outputDirectory' in request) throw new AdmissionError('INVALID_REQUEST')
  return snapshotCommon(project, request, 30000)
}

/** One queue for real workflow metadata and the compatible bounded job API.
 * Work/cleanup callbacks are introduced only after activation, never queued.
 */
export class CompilerAdmission {
  private readonly executor: JobExecutor
  private readonly reconciler: OwnedJobReconciler
  private readonly activeLimit: number
  private readonly queueLimit: number
  private readonly sweepIntervalMs: number
  private readonly queue: Entry[] = []
  private readonly active = new Map<string, Flow>()
  private readonly activeIds = new Set<string>()
  private readonly pendingCleanup = new Set<string>()
  private readonly controls: Control[] = []
  private ready = false
  private started = false
  private closing = false
  private reconciliationError: unknown
  private cleanupRevision = 0
  private sweep: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private shutdown: Promise<void> | undefined
  constructor(
    executor: JobExecutor,
    reconciler: OwnedJobReconciler,
    options: Options = {}
  ) {
    this.executor = executor
    this.reconciler = reconciler
    this.activeLimit = options.activeLimit ?? 2
    this.queueLimit = options.queueLimit ?? 8
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000
    if (
      !Number.isSafeInteger(this.activeLimit) ||
      this.activeLimit < 1 ||
      this.activeLimit > 2 ||
      !Number.isSafeInteger(this.queueLimit) ||
      this.queueLimit < 0 ||
      this.queueLimit > 8 ||
      !Number.isSafeInteger(this.sweepIntervalMs) ||
      this.sweepIntervalMs < 1 ||
      this.sweepIntervalMs > 60000
    )
      throw new AdmissionError('INVALID_REQUEST')
    this.reconciler.claimAdmission(this)
  }
  async start(): Promise<void> {
    if (this.started || this.closing) throw new AdmissionError('CLOSED')
    this.started = true
    try {
      await this.reconcile()
    } catch (error) {
      this.started = false
      throw error
    }
    if (this.closing) throw new AdmissionError('CLOSED')
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {})
    }, this.sweepIntervalMs)
    this.timer.unref()
  }
  status(): {
    active: number
    queued: number
    ready: boolean
    reconciliationError: unknown
    cleanupHeld: number
    controlFences: number
  } {
    return {
      active: this.active.size,
      queued: this.queue.length,
      ready: this.ready,
      reconciliationError: this.reconciliationError,
      cleanupHeld: Array.from(this.active.values()).filter(
        f =>
          f.completed &&
          (f.cleanupFailure !== undefined || f.failedJobs.size > 0)
      ).length,
      controlFences: this.controls.length,
    }
  }
  acquire(
    metadata: WorkflowMetadata,
    options: AcquireOptions = {}
  ): Promise<WorkflowLease> {
    try {
      return this.enqueue(
        copyMeta(metadata),
        options.signal,
        [],
        options.queueTimeoutMs ?? 30000,
        true
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }
  submit(
    project: string,
    request: JobRequest,
    queueTimeoutMs = 30000
  ): Promise<JobResult> {
    try {
      const copy = snapshot(project, request, queueTimeoutMs)
      return new Promise<JobResult>((resolve, reject) => {
        void this.enqueue(
          copyMeta({ projectId: project, kind: 'compile' }),
          copy.signal,
          [copy.inputDirectory, copy.outputDirectory],
          queueTimeoutMs,
          false,
          { request: copy, resolve, reject }
        ).catch(reject)
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  private enqueue(
    meta: WorkflowMetadata,
    signal: AbortSignal | undefined,
    directories: readonly string[],
    wait: number,
    rejectBusy: boolean,
    legacy?: Entry['legacy']
  ): Promise<WorkflowLease> {
    if (this.closing) throw new AdmissionError('CLOSED')
    this.reconciler.assertHeld()
    if (!this.ready)
      throw new AdmissionError(
        this.reconciliationError === undefined
          ? 'NOT_READY'
          : 'RECONCILIATION_FAILED'
      )
    if (!Number.isSafeInteger(wait) || wait <= 0 || wait > 30000)
      throw new AdmissionError('INVALID_REQUEST')
    if (signal?.aborted) throw new AdmissionError('CANCELLED')
    if (this.controls.some(c => matches(c.filter, meta)))
      throw new AdmissionError('PROJECT_BUSY')
    if (
      rejectBusy &&
      meta.kind !== 'output-read' &&
      [...Array.from(this.active.values(), f => f.entry), ...this.queue].some(
        e =>
          e.meta.kind !== 'output-read' && e.meta.projectId === meta.projectId
      )
    )
      throw new AdmissionError('PROJECT_BUSY')
    const canStart =
      this.queue.length === 0 &&
      this.active.size < this.activeLimit &&
      !this.conflicts(meta, directories)
    if (!canStart && this.queue.length >= this.queueLimit)
      throw new AdmissionError('OVERLOADED')
    return new Promise<WorkflowLease>((resolve, reject) => {
      const entry: Entry = {
        meta,
        signal,
        directories,
        resolve,
        reject,
        timer: undefined,
        deadline: performance.now() + wait,
        cancel: () => this.removeQueued(entry, 'CANCELLED'),
        ...(legacy === undefined ? {} : { legacy }),
      }
      if (canStart) this.launch(entry)
      else {
        this.queue.push(entry)
        entry.timer = setTimeout(
          () => this.removeQueued(entry, 'QUEUE_DEADLINE'),
          wait
        )
        signal?.addEventListener('abort', entry.cancel, { once: true })
        if (signal?.aborted) entry.cancel()
      }
    })
  }
  private conflicts(
    meta: WorkflowMetadata,
    directories: readonly string[],
    except?: Flow
  ): boolean {
    return Array.from(this.active.values()).some(
      f =>
        f !== except &&
        ((meta.kind !== 'output-read' &&
          f.entry.meta.kind !== 'output-read' &&
          f.entry.meta.projectId === meta.projectId) ||
          f.entry.directories.some(a =>
            directories.some(b => overlap(a, b) || overlap(b, a))
          ))
    )
  }
  private detach(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.cancel)
  }
  private removeQueued(entry: Entry, code: AdmissionCode): void {
    const index = this.queue.indexOf(entry)
    if (index < 0) return
    this.queue.splice(index, 1)
    this.detach(entry)
    entry.reject(new AdmissionError(code))
    this.drain()
  }
  private drain(): void {
    if (!this.ready || this.closing) return
    try {
      this.reconciler.assertHeld()
    } catch (error) {
      this.failReconciliation(error)
      return
    }
    while (this.active.size < this.activeLimit) {
      const e = this.queue[0]
      if (
        !e ||
        this.conflicts(e.meta, e.directories) ||
        this.controls.some(c => matches(c.filter, e.meta))
      )
        return
      this.queue.shift()
      this.detach(e)
      if (e.signal?.aborted) e.reject(new AdmissionError('CANCELLED'))
      else if (performance.now() >= e.deadline)
        e.reject(new AdmissionError('QUEUE_DEADLINE'))
      else this.launch(e)
    }
  }
  private launch(entry: Entry): void {
    const controller = new AbortController()
    const flow: Flow = {
      id: randomUUID(),
      entry,
      controller,
      cancel: () => controller.abort(entry.signal?.reason),
      started: false,
      workFinished: false,
      completed: false,
      closed: deferred(),
      drained: deferred(),
      jobPending: undefined,
      inJob: false,
      jobFailure: undefined,
      completedArtifact: undefined,
      failedJobs: new Set(),
      workspaceRoot: undefined,
      cleanup: undefined,
      cleanupAttempt: undefined,
      cleanupFailure: undefined,
    }
    this.active.set(flow.id, flow)
    entry.signal?.addEventListener('abort', flow.cancel, { once: true })
    if (entry.signal?.aborted) flow.cancel()
    const lease: WorkflowLease = Object.freeze({
      identity: flow.id,
      signal: controller.signal,
      closed: flow.closed.promise,
      run: <T>(work: (scope: WorkflowScope) => Promise<T>) =>
        this.runFlow(flow, work),
    })
    entry.resolve(lease)
    const legacy = entry.legacy
    if (legacy)
      void lease
        .run(scope => scope.runJob(legacy.request))
        .then(legacy.resolve, legacy.reject)
  }
  private runJob(flow: Flow, request: JobRequest): Promise<JobResult> {
    return this.runOwnedJob(flow, { mode: 'generic', request })
  }
  private runOwnedJob(flow: Flow, job: GenericJob): Promise<JobResult>
  private runOwnedJob(
    flow: Flow,
    job: ArtifactJob
  ): Promise<CompileArtifactJobResult>
  private runOwnedJob(flow: Flow, job: StdoutJob): Promise<StdoutJobResult>
  private runOwnedJob(
    flow: Flow,
    job: GenericJob | ArtifactJob | StdoutJob
  ): Promise<JobResult | CompileArtifactJobResult | StdoutJobResult> {
    try {
      if (
        !flow.started ||
        flow.workFinished ||
        flow.inJob ||
        flow.jobFailure !== undefined ||
        !this.active.has(flow.id)
      )
        throw new AdmissionError('CLOSED')
      flow.controller.signal.throwIfAborted()
      this.reconciler.assertHeld()
      // Preserve the mode together with the one request copy whose paths are
      // checked below. Never reread caller accessors after authorization.
      const checked: GenericJob | ArtifactJob | StdoutJob =
        job.mode === 'stdout'
          ? {
              mode: 'stdout',
              request: snapshotStdout(flow.entry.meta.projectId, job.request),
            }
          : job.mode === 'artifacts'
            ? {
                mode: 'artifacts',
                request: snapshot(
                  flow.entry.meta.projectId,
                  job.request,
                  30000
                ),
              }
            : {
                mode: 'generic',
                request: snapshot(
                  flow.entry.meta.projectId,
                  job.request,
                  30000
                ),
              }
      const copy = checked.request
      const directories =
        copy.outputDirectory === undefined
          ? [copy.inputDirectory]
          : [copy.inputDirectory, copy.outputDirectory]
      if (
        (checked.mode === 'stdout' && !this.executor.runStdout) ||
        (checked.mode === 'artifacts' && !this.executor.runArtifacts)
      )
        throw new AdmissionError('INVALID_REQUEST')
      const workspace = flow.workspaceRoot
      if (
        flow.entry.legacy === undefined &&
        (workspace === undefined ||
          directories.some(
            directory =>
              directory === workspace || !overlap(workspace, directory)
          ))
      )
        throw new AdmissionError('INVALID_REQUEST')
      if (workspace !== undefined) checkWorkspaceJobPaths(copy)
      if (this.conflicts(flow.entry.meta, directories, flow))
        throw new AdmissionError('PROJECT_BUSY')
      flow.inJob = true
      flow.completedArtifact = undefined
      const id = randomUUID()
      this.activeIds.add(id)
      const signal =
        copy.signal === undefined
          ? flow.controller.signal
          : AbortSignal.any([flow.controller.signal, copy.signal])
      let pending: Promise<
        JobResult | CompileArtifactJobResult | StdoutJobResult
      >
      try {
        if (checked.mode === 'stdout') {
          const run = this.executor.runStdout
          if (!run) throw new AdmissionError('INVALID_REQUEST')
          pending = run.call(this.executor, { ...checked.request, signal }, id)
        } else if (checked.mode === 'artifacts') {
          const run = this.executor.runArtifacts
          if (!run) throw new AdmissionError('INVALID_REQUEST')
          pending = run
            .call(this.executor, { ...checked.request, signal }, id)
            .then(value => {
              if (value.outputDirectory !== checked.request.outputDirectory)
                throw new AdmissionError('INVALID_REQUEST')
              signal.throwIfAborted()
              flow.completedArtifact = Object.freeze({
                directory: checked.request.outputDirectory,
                revision: id,
              })
              return value
            })
        } else pending = this.executor.run({ ...checked.request, signal }, id)
      } catch (error) {
        pending = Promise.reject(error)
      }
      const result = pending.then(
        value => {
          flow.inJob = false
          this.activeIds.delete(id)
          return value
        },
        (error: unknown) => {
          flow.inJob = false
          this.activeIds.delete(id)
          flow.jobFailure = { error }
          flow.failedJobs.add(id)
          this.pendingCleanup.add(id)
          this.cleanupRevision++
          this.ready = false
          throw error
        }
      )
      flow.jobPending = result.then(
        () => {},
        () => {}
      )
      void result.catch(() => {})
      return result
    } catch (error) {
      return Promise.reject(error)
    }
  }
  private async runFlow<T>(
    flow: Flow,
    work: (scope: WorkflowScope) => Promise<T>
  ): Promise<T> {
    if (flow.started || !this.active.has(flow.id))
      throw new AdmissionError('CLOSED')
    flow.started = true
    const scope: WorkflowScope = Object.freeze({
      identity: flow.id,
      signal: flow.controller.signal,
      metadata: flow.entry.meta,
      claimWorkspaceCleanup: (cleanup: () => Promise<void>) => {
        if (flow.workFinished || !this.active.has(flow.id))
          throw new AdmissionError('CLOSED')
        this.reconciler.assertHeld()
        if (flow.controller.signal.aborted)
          throw new AdmissionError('CANCELLED')
        if (flow.cleanup !== undefined || typeof cleanup !== 'function')
          throw new AdmissionError('INVALID_REQUEST')
        flow.cleanup = cleanup
      },
      ownWorkspace: (rootDirectory: string, cleanup: () => Promise<void>) => {
        if (flow.workFinished || !this.active.has(flow.id))
          throw new AdmissionError('CLOSED')
        this.reconciler.assertHeld()
        if (flow.controller.signal.aborted)
          throw new AdmissionError('CANCELLED')
        if (
          flow.workspaceRoot !== undefined ||
          (flow.cleanup !== undefined && flow.cleanup !== cleanup) ||
          typeof cleanup !== 'function'
        )
          throw new AdmissionError('INVALID_REQUEST')
        checkWorkspaceRoot(rootDirectory)
        if (this.conflicts(flow.entry.meta, [rootDirectory], flow))
          throw new AdmissionError('PROJECT_BUSY')
        flow.workspaceRoot = rootDirectory
        flow.entry.directories = [rootDirectory]
        flow.cleanup = cleanup
      },
      runJob: (request: JobRequest) => this.runJob(flow, request),
      runArtifacts: (request: JobRequest) =>
        this.runOwnedJob(flow, { mode: 'artifacts', request }),
      runStdout: (request: StdoutJobRequest) =>
        this.runOwnedJob(flow, { mode: 'stdout', request }),
    })
    activeWorkflowScopes.set(scope, (manager, settledJobs, artifact) => {
      if (manager !== undefined && manager !== this)
        throw new AdmissionError('INVALID_REQUEST')
      if (!flow.started || flow.workFinished || !this.active.has(flow.id))
        throw new AdmissionError('CLOSED')
      if (settledJobs && (flow.inJob || flow.jobFailure !== undefined))
        throw new AdmissionError('INVALID_REQUEST')
      this.reconciler.assertHeld()
      if (artifact !== undefined) {
        const completed = flow.completedArtifact
        if (
          !completed ||
          completed.directory !== artifact.directory ||
          (artifact.revision !== undefined &&
            artifact.revision !== completed.revision)
        )
          throw new AdmissionError('INVALID_REQUEST')
        return completed.revision
      }
      return undefined
    })
    let value: { result: T } | undefined
    let failure: { error: unknown } | undefined
    try {
      flow.controller.signal.throwIfAborted()
      value = { result: await work(scope) }
      flow.controller.signal.throwIfAborted()
    } catch (error) {
      failure = { error }
    }
    flow.workFinished = true
    activeWorkflowScopes.delete(scope)
    if (flow.jobPending) await flow.jobPending
    let cleanupFailure: { error: unknown } | undefined
    try {
      await this.cleanupFlow(flow)
    } catch (error) {
      cleanupFailure = { error }
    }
    if (failure === undefined && flow.controller.signal.aborted)
      failure = { error: flow.controller.signal.reason }
    const errors: unknown[] = []
    if (failure) errors.push(failure.error)
    if (flow.jobFailure) errors.push(flow.jobFailure.error)
    if (cleanupFailure) errors.push(cleanupFailure.error)
    flow.completed = true
    flow.drained.resolve()
    this.releaseCompleted()
    if (flow.failedJobs.size > 0 && !this.closing)
      void this.reconcile().catch(() => {})
    if (errors.length > 0)
      throw combined(errors, 'Workflow work and cleanup failed')
    if (value === undefined)
      throw new Error('Workflow completed without a result')
    return value.result
  }
  private cleanupFlow(flow: Flow): Promise<void> {
    if (flow.cleanupAttempt) return flow.cleanupAttempt
    if (!flow.cleanup) return Promise.resolve()
    const cleanup = flow.cleanup
    flow.cleanupAttempt = Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          flow.cleanup = undefined
          flow.cleanupFailure = undefined
          this.cleanupRevision++
        },
        (error: unknown) => {
          flow.cleanupFailure = { error }
          this.cleanupRevision++
          this.failReconciliation(error)
          throw error
        }
      )
      .finally(() => {
        flow.cleanupAttempt = undefined
      })
    return flow.cleanupAttempt
  }
  private releaseCompleted(): void {
    for (const f of this.active.values())
      if (f.completed && f.cleanup === undefined && f.failedJobs.size === 0) {
        this.active.delete(f.id)
        f.entry.signal?.removeEventListener('abort', f.cancel)
        f.closed.resolve()
      }
    this.drain()
  }
  async retryCleanup(filter?: WorkflowFilter): Promise<void> {
    this.reconciler.assertHeld()
    const copy = filter === undefined ? undefined : copyFilter(filter)
    const outcomes = await Promise.allSettled(
      Array.from(this.active.values())
        .filter(
          f =>
            f.completed &&
            f.cleanupFailure !== undefined &&
            (copy === undefined || matches(copy, f.entry.meta))
        )
        .map(f => this.cleanupFlow(f))
    )
    const failures = outcomes
      .filter(x => x.status === 'rejected')
      .map(x => x.reason as unknown)
    this.releaseCompleted()
    if (failures.length)
      throw combined(failures, 'Owned workspace cleanup retry failed')
    if (!this.closing) await this.reconcile()
  }
  private failReconciliation(error: unknown): void {
    this.ready = false
    this.reconciliationError = error
    for (const e of this.queue.splice(0)) {
      this.detach(e)
      e.reject(new AdmissionError('RECONCILIATION_FAILED'))
    }
  }
  reconcile(): Promise<void> {
    if (this.closing) return Promise.reject(new AdmissionError('CLOSED'))
    if (this.sweep) return this.sweep
    this.ready = false
    const revision = this.cleanupRevision
    this.sweep = this.reconciler
      .sweep(this.activeIds, this.pendingCleanup)
      .then(
        () => {
          if (revision === this.cleanupRevision) {
            this.pendingCleanup.clear()
            for (const f of this.active.values()) f.failedJobs.clear()
          }
          const hostFailure = Array.from(this.active.values()).find(
            f => f.cleanupFailure !== undefined
          )?.cleanupFailure
          if (hostFailure !== undefined) {
            this.reconciliationError = hostFailure.error
            this.ready = false
          } else {
            if (revision === this.cleanupRevision)
              this.reconciliationError = undefined
            this.ready =
              this.started && !this.closing && revision === this.cleanupRevision
          }
          this.releaseCompleted()
        },
        (error: unknown) => {
          this.failReconciliation(error)
          throw error
        }
      )
      .finally(() => {
        this.sweep = undefined
        if (revision !== this.cleanupRevision && !this.closing)
          void this.reconcile().catch(() => {})
        else this.drain()
      })
    return this.sweep
  }
  /** Noncanceling maintenance fence on this same admission authority. The
   * activity check and control registration are synchronous against acquire.
   * Failed deletion retains its fence and original clear callback for retry. */
  tryExpire(
    filter: WorkflowFilter,
    clear: () => Promise<void>
  ): Promise<boolean> {
    try {
      this.reconciler.assertHeld()
      if (this.closing) throw new AdmissionError('CLOSED')
      if (!this.started) throw new AdmissionError('NOT_READY')
      const copy = copyFilter(filter)
      if (
        Array.from(this.active.values()).some(flow =>
          matches(copy, flow.entry.meta)
        ) ||
        this.queue.some(entry => matches(copy, entry.meta))
      )
        return Promise.resolve(false)
      const existing = this.controls.find(
        control =>
          control.mode === 'expire' &&
          JSON.stringify(control.filter) === JSON.stringify(copy)
      )
      if (
        this.controls.some(
          control =>
            control !== existing && controlsOverlap(control.filter, copy)
        ) ||
        (existing === undefined && this.controls.length >= 2)
      )
        return Promise.resolve(false)
      return this.control('expire', copy, clear).then(() => true)
    } catch (error) {
      return Promise.reject(error)
    }
  }
  cancelAndWait(filter: WorkflowFilter): Promise<void> {
    return this.control('stop', filter, async () => {})
  }
  reset(filter: WorkflowFilter, clear: () => Promise<void>): Promise<void> {
    return this.control('reset', filter, clear)
  }
  private control(
    mode: Control['mode'],
    filter: WorkflowFilter,
    clear: () => Promise<void>
  ): Promise<void> {
    try {
      this.reconciler.assertHeld()
      const copy = copyFilter(filter)
      let control = this.controls.find(
        c =>
          c.mode === mode && JSON.stringify(c.filter) === JSON.stringify(copy)
      )
      if (control?.pending) return control.pending
      if (!control) {
        if (this.closing) throw new AdmissionError('CLOSED')
        if (!this.started) throw new AdmissionError('NOT_READY')
        if (this.controls.some(c => controlsOverlap(c.filter, copy)))
          throw new AdmissionError('PROJECT_BUSY')
        if (this.controls.length >= 2) throw new AdmissionError('OVERLOADED')
        control = {
          filter: copy,
          mode,
          clear,
          pending: undefined,
          failure: undefined,
        }
        this.controls.push(control)
      }
      const held = control
      for (const e of this.queue.slice())
        if (matches(copy, e.meta)) this.removeQueued(e, 'CANCELLED')
      const flows = Array.from(this.active.values()).filter(f =>
        matches(copy, f.entry.meta)
      )
      for (const f of flows) f.controller.abort(new AdmissionError('CANCELLED'))
      held.pending = (async () => {
        await Promise.all(flows.map(f => f.drained.promise))
        const failures = flows.flatMap(f =>
          f.cleanupFailure === undefined ? [] : [f.cleanupFailure.error]
        )
        if (failures.length)
          throw combined(failures, 'Control blocked by owned cleanup failure')
        if (mode !== 'expire' && !this.closing) await this.reconcile()
        await Promise.all(flows.map(f => f.closed.promise))
        await held.clear()
        this.controls.splice(this.controls.indexOf(held), 1)
        this.drain()
      })()
        .catch((error: unknown) => {
          held.failure = { error }
          throw error
        })
        .finally(() => {
          held.pending = undefined
        })
      return held.pending
    } catch (error) {
      return Promise.reject(error)
    }
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.closing = true
    this.ready = false
    if (this.timer) clearInterval(this.timer)
    for (const e of this.queue.splice(0)) {
      this.detach(e)
      e.reject(new AdmissionError('CLOSED'))
    }
    const flows = Array.from(this.active.values())
    for (const f of flows)
      if (!f.started) f.controller.abort(new AdmissionError('CLOSED'))
    this.shutdown = (async () => {
      await Promise.all(flows.map(f => f.drained.promise))
      const hostErrors = flows.flatMap(f =>
        f.cleanupFailure === undefined ? [] : [f.cleanupFailure.error]
      )
      if (hostErrors.length)
        throw combined(hostErrors, 'Shutdown blocked by owned cleanup')
      if (this.sweep) await this.sweep
      await this.reconciler.sweep(this.activeIds, this.pendingCleanup)
      this.pendingCleanup.clear()
      for (const f of this.active.values()) f.failedJobs.clear()
      this.releaseCompleted()
      await Promise.all(flows.map(f => f.closed.promise))
      const controlResults = await Promise.allSettled(
        this.controls.flatMap(c => (c.pending === undefined ? [] : [c.pending]))
      )
      const errors = controlResults
        .filter(x => x.status === 'rejected')
        .map(x => x.reason as unknown)
        .concat(
          this.controls.flatMap(c =>
            c.failure === undefined ? [] : [c.failure.error]
          )
        )
      if (errors.length)
        throw combined(errors, 'Shutdown control cleanup failed')
      await this.reconciler.close()
    })().catch((error: unknown) => {
      this.shutdown = undefined
      throw error
    })
    return this.shutdown
  }
}

// Shared concrete private-directory guard for worker-owned staging and source plans.
export { checkWorkspaceRoot as validatePrivateCompileDirectory }
