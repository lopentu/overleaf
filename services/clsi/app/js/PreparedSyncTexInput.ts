import path from 'node:path'
import { BUILD_REGEX } from './CompileBuildId.ts'
import {
  assertActiveWorkflowScope,
  type CompilerAdmission,
  type WorkflowScope,
} from './CompilerAdmission.ts'
import {
  withCompileInputSnapshot,
  type CompileInputSnapshotRequest,
} from './CompileInputSnapshot.ts'
import { canonicalProjectArchivePath } from './BoundedProjectArchive.ts'
export type SyncTexQuery =
  | {
      readonly kind: 'code'
      readonly file: string
      readonly line: number
      readonly column: number
    }
  | {
      readonly kind: 'pdf'
      readonly page: number
      readonly h: number
      readonly v: number
    }
function validateSyncTexQuery(query: SyncTexQuery): void {
  if (query.kind === 'code') {
    canonicalProjectArchivePath(query.file, false)
    if (
      !Number.isSafeInteger(query.line) ||
      !Number.isSafeInteger(query.column)
    )
      throw new Error('Invalid SyncTeX position')
  } else if (
    query.kind !== 'pdf' ||
    !Number.isSafeInteger(query.page) ||
    !Number.isFinite(query.h) ||
    !Number.isFinite(query.v)
  )
    throw new Error('Invalid SyncTeX position')
}
export function buildSyncTexCommand(
  executable: string,
  query: SyncTexQuery
): string[] {
  validateSyncTexQuery(query)
  return query.kind === 'code'
    ? [
        executable,
        'view',
        '-i',
        `${query.line}:${query.column}:${path.posix.join('/compile', query.file)}`,
        '-o',
        '/compile/output.pdf',
      ]
    : [
        executable,
        'edit',
        '-o',
        `${query.page}:${query.h}:${query.v}:/compile/output.pdf`,
      ]
}
/** A sealed real copy of the exact requested build, never mutable latest input.
 * Private fields expire after the one awaited reader callback; no registry. */
const construction = Symbol('synctex-input')
export class PreparedSyncTexInput {
  readonly scope: WorkflowScope
  readonly manager: CompilerAdmission
  readonly inputDirectory: string
  readonly buildId: string
  readonly query: SyncTexQuery
  #live = true
  private constructor(
    authority: typeof construction,
    scope: WorkflowScope,
    manager: CompilerAdmission,
    inputDirectory: string,
    buildId: string,
    query: SyncTexQuery
  ) {
    if (authority !== construction)
      throw new Error('Invalid preparation construction')
    this.scope = scope
    this.manager = manager
    this.inputDirectory = inputDirectory
    this.buildId = buildId
    this.query = query
    Object.freeze(this)
  }
  static require(
    value: unknown,
    inputDirectory: string,
    projectId: string
  ): SyncTexQuery {
    if (!(value instanceof PreparedSyncTexInput) || !value.#live)
      throw new Error('Missing genuine SyncTeX input')
    assertActiveWorkflowScope(value.scope, value.manager)
    if (
      value.scope.metadata.kind !== 'output-read' ||
      value.scope.metadata.projectId !== projectId ||
      value.inputDirectory !== inputDirectory
    )
      throw new Error('Invalid SyncTeX workflow')
    value.scope.signal.throwIfAborted()
    return value.query
  }
  static async withInput<T>(
    scope: WorkflowScope,
    manager: CompilerAdmission,
    source: CompileInputSnapshotRequest,
    buildId: string,
    configured: SyncTexQuery,
    use: (prepared: PreparedSyncTexInput) => Promise<T>
  ): Promise<T> {
    assertActiveWorkflowScope(scope, manager, true)
    if (scope.metadata.kind !== 'output-read')
      throw new Error('Invalid SyncTeX workflow')
    const query: SyncTexQuery =
      configured.kind === 'code'
        ? Object.freeze({
            kind: 'code',
            file: configured.file,
            line: configured.line,
            column: configured.column,
          })
        : Object.freeze({
            kind: 'pdf',
            page: configured.page,
            h: configured.h,
            v: configured.v,
          })
    validateSyncTexQuery(query)
    const request = {
      sourceRoot: source.sourceRoot,
      sourceDirectory: source.sourceDirectory,
      stagingRoot: source.stagingRoot,
      signal: scope.signal,
    }
    if (
      !BUILD_REGEX.test(buildId) ||
      !request.sourceDirectory.endsWith(
        path.sep + path.join('generated-files', buildId)
      )
    )
      throw new Error('Invalid exact SyncTeX build')
    return await withCompileInputSnapshot(request, async snapshot => {
      assertActiveWorkflowScope(scope, manager, true)
      const prepared = new PreparedSyncTexInput(
        construction,
        scope,
        manager,
        snapshot.inputDirectory,
        buildId,
        query
      )
      try {
        return await use(prepared)
      } finally {
        prepared.#live = false
      }
    })
  }
}
