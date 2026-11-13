import Errors from './Errors.js'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { validatePrivateCompileDirectory } from './CompilerAdmission.ts'
import type { CompilerAdmission, WorkflowScope } from './CompilerAdmission.ts'
import { removeOwnedCompileJob } from './CompileInputSnapshot.ts'
import {
  writeFullSourcePlan,
  finishSourcePlanMaterialization,
  sourceScope,
  type FullSourcePlan,
} from './CompileSourcePlan.ts'
import {
  SourceInputError,
  SourceInputAggregateError,
  checkSourceSignal,
} from './SourceInputError.ts'
import {
  SourceInputBudget,
  writeBoundedSourceContent,
  pipeBoundedSourceUrlToFileWithRetry,
  fetchBoundedSourceText,
  boundedHistorySourceURL,
} from './BoundedSourceDownload.ts'
export { parseFullSourcePlan } from './CompileSourcePlan.ts'
export type { FullSourcePlan } from './CompileSourcePlan.ts'

export interface FreshSourceConfiguration {
  stagingRoot: string
}
export interface MaterializedSource {
  readonly sourceRoot: string
  readonly sourceDirectory: string
  readonly stagingRoot: string
  readonly resourceList: readonly { readonly path: string }[]
  readonly baseHistoryVersion?: number
}
interface OwnedSourceState {
  operationRoot: string | undefined
  transactionCleanup: (() => Promise<void>) | undefined
}
const ownedSources = new WeakMap<WorkflowScope, OwnedSourceState>()
/** One concrete persistent filesystem transaction, joined by this factory's existing
 * registered cleanup callback. No unbounded cleanup registry. */
export function ownSourceFilesystemTransaction(
  scope: WorkflowScope,
  cleanup: () => Promise<void>
): () => void {
  sourceScope(scope)
  const state = ownedSources.get(scope)
  if (
    !state ||
    state.operationRoot === undefined ||
    state.transactionCleanup !== undefined
  )
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  state.transactionCleanup = cleanup
  return () => {
    if (state.transactionCleanup === cleanup)
      state.transactionCleanup = undefined
  }
}
/** Internal publication authority from the completed real source factory. */
export function sourceOperationDirectory(
  scope: WorkflowScope,
  manager: CompilerAdmission
): string {
  sourceScope(scope, manager, true)
  const root = ownedSources.get(scope)?.operationRoot
  if (root === undefined) throw new SourceInputError('INVALID_SOURCE_REQUEST')
  return root
}
function identity(stat: Stats) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
}
/** Only call inside the real active lease.run callback. The manager retains the
 * complete workspace through joined work, cleanup failure and cleanup retry. */
export async function materializeFullSource(
  scope: WorkflowScope,
  plan: FullSourcePlan,
  configuration: FreshSourceConfiguration
): Promise<MaterializedSource> {
  sourceScope(scope)
  if (ownedSources.has(scope))
    throw new SourceInputError('INVALID_SOURCE_REQUEST')
  const owner = process.geteuid?.()
  if (owner === undefined) throw new SourceInputError('SOURCE_IO_FAILED')
  const root = configuration.stagingRoot
  try {
    validatePrivateCompileDirectory(root)
  } catch {
    throw new SourceInputError('SOURCE_IO_FAILED', 'staging')
  }
  const rootIdentity = identity(await fs.lstat(root))
  checkSourceSignal(scope.signal)
  let directory: string | undefined
  let owned: ReturnType<typeof identity> | undefined
  let allocationAttempted = false
  const ioDone = Promise.withResolvers<void>()
  const state: OwnedSourceState = {
    operationRoot: undefined,
    transactionCleanup: undefined,
  }
  const cleanup = async () => {
    // One existing flow callback joins its concrete allocator/writer and optional
    // cache transaction. It remains usable after active work loses its brand.
    await ioDone.promise
    const failures: unknown[] = []
    try {
      await state.transactionCleanup?.()
    } catch (error) {
      failures.push(error)
    }
    try {
      if (directory !== undefined)
        await removeOwnedCompileJob(root, rootIdentity, directory, owned, owner)
      else if (allocationAttempted)
        throw new SourceInputError('SOURCE_IO_FAILED', 'unknown-allocation')
    } catch {
      failures.push(
        new SourceInputError('SOURCE_IO_FAILED', 'workspace-cleanup')
      )
    }
    if (failures.length)
      throw new SourceInputAggregateError(failures, 'owned-source-cleanup')
    ownedSources.delete(scope)
  }
  scope.claimWorkspaceCleanup(cleanup)
  ownedSources.set(scope, state)
  const budget = new SourceInputBudget()
  try {
    checkSourceSignal(scope.signal)
    allocationAttempted = true
    directory = await fs.mkdtemp(path.join(root, 'operation-'))
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.uid !== owner)
      throw new SourceInputError('SOURCE_IO_FAILED', 'identity')
    owned = identity(stat)
    await fs.chmod(directory, 0o700)
    scope.ownWorkspace(directory, cleanup)
    const sourceRoot = path.join(directory, 'source'),
      sourceDirectory = path.join(sourceRoot, 'project'),
      stagingRoot = path.join(directory, 'jobs')
    await fs.mkdir(sourceRoot, { mode: 0o700 })
    await fs.mkdir(sourceDirectory, { mode: 0o700 })
    await fs.mkdir(stagingRoot, { mode: 0o700 })
    const result = await writeFullSourcePlan(scope, plan, {
      async writeContent(name, content) {
        const destination = path.join(sourceDirectory, name)
        await fs.mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        })
        await writeBoundedSourceContent(
          destination,
          content,
          budget,
          scope.signal
        )
      },
      async writeUrl(name, url, fallbackURL) {
        const destination = path.join(sourceDirectory, name)
        await fs.mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        })
        await pipeBoundedSourceUrlToFileWithRetry(
          url,
          fallbackURL,
          destination,
          budget,
          scope.signal
        )
      },
      async fetchText(url) {
        return await fetchBoundedSourceText(url, budget, scope.signal)
      },
      historyBlobURL: boundedHistorySourceURL,
    })
    checkSourceSignal(scope.signal)
    const current = await fs.lstat(directory)
    if (
      current.dev !== owned?.dev ||
      current.ino !== owned.ino ||
      current.uid !== owned.uid ||
      !current.isDirectory()
    )
      throw new SourceInputError('SOURCE_IO_FAILED', 'workspace-identity')
    finishSourcePlanMaterialization(scope, plan)
    state.operationRoot = directory
    return Object.freeze({
      sourceRoot,
      sourceDirectory,
      stagingRoot,
      ...result,
    })
  } catch (error) {
    if (
      error instanceof SourceInputError ||
      error instanceof SourceInputAggregateError ||
      error instanceof Errors.NotFoundError
    )
      throw error
    throw new SourceInputError(
      scope.signal.aborted ? 'SOURCE_CANCELLED' : 'SOURCE_IO_FAILED'
    )
  } finally {
    ioDone.resolve()
  }
}
