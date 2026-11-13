import { z, zz } from '@overleaf/validation-tools'
import { Change, Snapshot, BlobStoreBase } from 'overleaf-editor-core'
import rawSchemas from 'overleaf-editor-core/lib/schemas.js'
import RequestParser from './RequestParser.js'
import Errors from './Errors.js'
import {
  canonicalProjectArchivePath,
  INPUT_LIMITS,
} from './BoundedProjectArchive.ts'
import { assertActiveWorkflowScope } from './CompilerAdmission.ts'
import type {
  WorkflowScope,
  WorkflowMetadata,
  CompilerAdmission,
} from './CompilerAdmission.ts'
import {
  SourceInputError,
  SourceInputAggregateError,
  checkSourceSignal,
} from './SourceInputError.ts'

export const MAX_SOURCE_PLAN_BYTES = 7 * 1024 * 1024
export interface FullSourcePlan {
  readonly kind: 'full' | 'history-full'
  readonly rootResourcePath: string
}
export interface SourcePlanWriter {
  writeContent(name: string, content: string): Promise<void>
  writeUrl(name: string, url: string, fallbackURL?: string): Promise<void>
  fetchText(url: string): Promise<string>
  historyBlobURL(hash: string, context: HistorySourceContext): string
}
export interface HistorySourceContext {
  readonly historyId: string | undefined
  readonly globalBlobs: readonly string[]
  readonly filestoreBlobPrefix: string | undefined
  readonly clsiPerfVariant: string | undefined
}
const sourceView = z.object({
  rootResourcePath: z.string(),
  syncType: z.string().nullish(),
  resources: z.array(
    z.object({
      path: z.string(),
      content: z.string().nullish(),
      url: z.string().nullish(),
      fallbackURL: z.string().nullish(),
    })
  ),
  rawSnapshot: z.unknown(),
  rawChangeOperations: z.unknown(),
  baseHistoryVersion: z.number().nullish(),
  historyId: z.string().nullish(),
  globalBlobs: z.array(z.string()).nullish(),
  filestoreBlobPrefix: z.string().nullish(),
  clsiPerfVariant: z.string().nullish(),
})
type ParsedSource = z.infer<typeof sourceView>
interface PrivatePlan {
  readonly identity: string
  readonly scope: Readonly<WorkflowMetadata>
  readonly raw: Buffer
  readonly source: ParsedSource
  readonly snapshot: Snapshot | undefined
  readonly paths: readonly string[]
  readonly baseHistoryVersion: number | undefined
  materialized: boolean
}
const plans = new WeakMap<FullSourcePlan, PrivatePlan>()
const projectId = zz.objectId().or(zz.submissionId())
export function sourceScope(
  scope: WorkflowScope,
  manager?: CompilerAdmission,
  settledJobs = false
): Readonly<WorkflowMetadata> {
  try {
    assertActiveWorkflowScope(scope, manager, settledJobs)
  } catch {
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
  checkSourceSignal(scope.signal)
  const meta = scope.metadata
  if (
    !meta ||
    !Object.isFrozen(meta) ||
    !['compile', 'wordcount'].includes(meta.kind)
  )
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  try {
    projectId.parse(meta.projectId)
    if (meta.userId !== undefined) zz.objectId().parse(meta.userId)
  } catch {
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
  return meta
}
function privatePlan(scope: WorkflowScope, plan: FullSourcePlan): PrivatePlan {
  const meta = sourceScope(scope),
    data = plans.get(plan)
  if (
    !data ||
    data.identity !== scope.identity ||
    data.scope.projectId !== meta.projectId ||
    data.scope.userId !== meta.userId
  )
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  return data
}
function validatePaths(paths: readonly string[]): void {
  const nodes = new Map<string, 'file' | 'directory'>()
  for (const name of paths) {
    canonicalProjectArchivePath(name, false)
    let prefix = ''
    const parts = name.split('/')
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!
      const kind = index === parts.length - 1 ? 'file' : 'directory'
      const old = nodes.get(prefix)
      if (old === 'file' || (old === 'directory' && kind === 'file'))
        throw new SourceInputError('INVALID_SOURCE_REQUEST')
      nodes.set(prefix, kind)
      if (nodes.size > INPUT_LIMITS.maxEntries)
        throw new SourceInputError('INPUT_LIMIT')
    }
  }
}
export async function parseFullSourcePlan(
  scope: WorkflowScope,
  decodedBytes: Buffer
): Promise<FullSourcePlan> {
  const meta = sourceScope(scope)
  if (
    !Buffer.isBuffer(decodedBytes) ||
    decodedBytes.length > MAX_SOURCE_PLAN_BYTES
  )
    throw new SourceInputError('INPUT_LIMIT')
  const raw = Buffer.from(decodedBytes)
  let source: ParsedSource
  try {
    const body: unknown = JSON.parse(
      raw.toString('utf8').replace(/^\uFEFF/, '')
    )
    const parsed: unknown = await new Promise<unknown>((resolve, reject) => {
      RequestParser.parse(body, (error: unknown, result: unknown) => {
        if (error != null)
          reject(new SourceInputError('INVALID_SOURCE_REQUEST'))
        else resolve(result)
      })
    })
    source = sourceView.parse(parsed)
  } catch {
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
  checkSourceSignal(scope.signal)
  if (source.syncType === 'incremental')
    throw Errors.FilesOutOfSyncError('full source resync required')
  if (source.syncType === 'history-incremental')
    throw new Errors.MissingUpdatesError('full source resync required', {
      baseHistoryVersion: -1,
    })
  let snapshot: Snapshot | undefined,
    baseHistoryVersion: number | undefined,
    kind: FullSourcePlan['kind'] = 'full'
  let paths: string[]
  try {
    canonicalProjectArchivePath(source.rootResourcePath, false)
    if (
      source.syncType === 'history-full' ||
      source.rawChangeOperations != null
    ) {
      if (source.rawSnapshot == null)
        throw new Errors.MissingUpdatesError('full source resync required', {
          baseHistoryVersion: -1,
        })
      const version = source.baseHistoryVersion
      if (
        !Number.isSafeInteger(version) ||
        version === undefined ||
        version === null ||
        version < 0
      )
        throw new SourceInputError('INVALID_SOURCE_REQUEST')
      const raw = rawSchemas.rawSnapshot.parse(source.rawSnapshot)
      validatePaths(Object.keys(raw.files))
      const operations = z
        .array(z.array(rawSchemas.rawOperation))
        .parse(source.rawChangeOperations)
      snapshot = Snapshot.fromRaw(raw)
      const changes = operations.map(operations =>
        Change.mustFromRaw({ operations, timestamp: '0' })
      )
      snapshot.applyAll(changes)
      paths = snapshot.getFilePathnames()
      baseHistoryVersion = version + changes.length
      if (!Number.isSafeInteger(baseHistoryVersion))
        throw new SourceInputError('INPUT_LIMIT')
      kind = 'history-full'
    } else paths = source.resources.map(resource => resource.path)
    validatePaths(paths)
  } catch (error) {
    if (
      error instanceof SourceInputError ||
      error instanceof Errors.MissingUpdatesError
    )
      throw error
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  }
  checkSourceSignal(scope.signal)
  const plan = Object.freeze({
    kind,
    rootResourcePath: source.rootResourcePath,
  })
  plans.set(plan, {
    identity: scope.identity,
    scope: meta,
    raw,
    source,
    snapshot,
    paths: Object.freeze(paths),
    baseHistoryVersion,
    materialized: false,
  })
  return plan
}
export function copyMaterializedPlanBytes(
  scope: WorkflowScope,
  plan: FullSourcePlan
): Buffer {
  const data = privatePlan(scope, plan)
  if (!data.materialized) throw new SourceInputError('INVALID_SOURCE_REQUEST')
  return Buffer.from(data.raw)
}
export function finishSourcePlanMaterialization(
  scope: WorkflowScope,
  plan: FullSourcePlan
): void {
  const data = privatePlan(scope, plan)
  if (data.materialized) throw new SourceInputError('INVALID_SOURCE_REQUEST')
  data.materialized = true
}
export async function writeFullSourcePlan(
  scope: WorkflowScope,
  plan: FullSourcePlan,
  writer: SourcePlanWriter
): Promise<{
  readonly resourceList: readonly { readonly path: string }[]
  readonly baseHistoryVersion?: number
}> {
  const data = privatePlan(scope, plan)
  if (data.materialized) throw new SourceInputError('INVALID_SOURCE_REQUEST')
  try {
    if (data.snapshot) {
      const context: HistorySourceContext = {
        historyId: data.source.historyId ?? undefined,
        globalBlobs: data.source.globalBlobs ?? [],
        filestoreBlobPrefix: data.source.filestoreBlobPrefix ?? undefined,
        clsiPerfVariant: data.source.clsiPerfVariant ?? undefined,
      }
      const fetches: Promise<string>[] = []
      class Store extends BlobStoreBase {
        fetchString(hash: string): Promise<string> {
          // Actual editor-core loads at most content+ranges for one file. Join
          // both even when its Promise.all rejects on the first failure.
          if (fetches.length >= 2)
            return Promise.reject(new SourceInputError('INPUT_LIMIT'))
          const pending = (async () => {
            try {
              return await writer.fetchText(
                writer.historyBlobURL(hash, context)
              )
            } catch (error) {
              if (
                error instanceof SourceInputError &&
                'status' in error &&
                error.status === 404
              )
                throw Errors.NotFoundError('history source missing')
              throw error
            }
          })()
          fetches.push(pending)
          return pending
        }
      }
      const store = new Store()
      for (const name of data.paths) {
        checkSourceSignal(scope.signal)
        const file = data.snapshot.getFile(name)
        if (!file) throw new SourceInputError('INVALID_SOURCE_REQUEST')
        try {
          await file.load('eager', store)
        } finally {
          await Promise.allSettled(fetches)
          fetches.length = 0
        }
        const content = file.getContent({ filterTrackedDeletes: true })
        if (typeof content === 'string')
          await writer.writeContent(name, content)
        else {
          const hash = file.getHash()
          if (!hash) throw new SourceInputError('INVALID_SOURCE_REQUEST')
          await writer.writeUrl(name, writer.historyBlobURL(hash, context))
        }
      }
    } else
      for (const resource of data.source.resources) {
        checkSourceSignal(scope.signal)
        if (resource.url != null)
          await writer.writeUrl(
            resource.path,
            resource.url,
            resource.fallbackURL ?? undefined
          )
        else if (resource.content != null)
          await writer.writeContent(resource.path, resource.content)
        else throw new SourceInputError('INVALID_SOURCE_REQUEST')
      }
  } catch (error) {
    if (
      error instanceof SourceInputError ||
      error instanceof SourceInputAggregateError ||
      error instanceof Errors.NotFoundError
    )
      throw error
    throw new SourceInputError('SOURCE_IO_FAILED')
  }
  checkSourceSignal(scope.signal)
  return Object.freeze({
    resourceList: Object.freeze(
      data.paths.map(path => Object.freeze({ path }))
    ),
    ...(data.baseHistoryVersion === undefined
      ? {}
      : { baseHistoryVersion: data.baseHistoryVersion }),
  })
}
