// @ts-check

import { setTimeout } from 'node:timers/promises'
import OError from '@overleaf/o-error'
import { fetchJson } from '@overleaf/fetch-utils'
import Settings from '@overleaf/settings'
import Path from 'node:path'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import TpdsUpdateSender from '../ThirdPartyDataStore/TpdsUpdateSender.mjs'
import ProjectGetter from './ProjectGetter.mjs'
import ProjectLocator from './ProjectLocator.mjs'
import {
  abortDocumentRetirement,
  commitDocumentReplacement,
  commitDocumentRetirement,
  completeDocumentRetirement,
  prepareDocumentRetirement,
  readActiveDocumentRetirement,
  readDocumentRetirement,
} from './ProjectDocumentRetirement.mjs'

/** @import { CommittedRetirement, RetirementOwner, RetirementIntent, RetirementReplacement, RetirementResult } from './ProjectDocumentRetirement.mjs' */

export function retirementEnabled() {
  return (
    Settings.documentupdater?.enableRetirementQueue === true &&
    Settings.documentupdater?.enableRetirementWriterSeal === true
  )
}

function retirementConflict() {
  return new OError(
    'The editable document retirement is unresolved or the project changed. Retry GitHub sync.',
    { status: 409 }
  )
}

/**
 * Reconcile under the Web project structure lock. The active receipt keeps the
 * same barrier across network failures and across requests.
 * @param {Extract<RetirementResult, {status: 'committed' | 'aborted'}>} state
 */
async function finishRetirement(state) {
  const { status, retirement } = state
  if (retirement.completedAt) return
  const deadline = Date.now() + 3000
  let reply =
    await DocumentUpdaterHandler.promises.reconcileDocumentRetirement(
      retirement
    )
  while (reply.status === 'pending' && Date.now() < deadline) {
    await setTimeout(250)
    reply =
      await DocumentUpdaterHandler.promises.reconcileDocumentRetirement(
        retirement
      )
  }
  if (reply.status !== status) throw retirementConflict()

  if (status === 'committed') {
    const { projectId, docId, path, deletedAt, version, docstoreRev } =
      state.retirement
    if (docstoreRev === undefined) throw retirementConflict()
    const project = await ProjectGetter.promises.getProject(projectId, {
      name: true,
      'overleaf.history.id': true,
      rootFolder: true,
    })
    if (!project?.name) throw retirementConflict()
    await DocstoreManager.promises.deleteDoc(
      projectId,
      docId,
      Path.basename(path),
      deletedAt,
      { version, rev: docstoreRev }
    )
    await TpdsUpdateSender.promises.deleteEntity({
      projectId,
      projectName: project.name,
      path,
      entityId: docId,
      entityType: 'doc',
      subtreeEntityIds: [docId],
    })
    await EditorRealTimeController.emitToRoom(
      projectId,
      'removeEntity',
      docId,
      'github'
    )
    if (state.retirement.replacement) {
      const { fileId, hash } = state.retirement.replacement
      await TpdsUpdateSender.promises.addFile({
        projectId,
        historyId: project.overleaf?.history?.id,
        fileId,
        hash,
        path,
        projectName: project.name,
        rev: 0,
        folderId: state.retirement.folderId,
      })
      const file = await ProjectLocator.promises.findElementByPath({
        project,
        path,
        exactCaseMatch: true,
      })
      if (
        file?.type !== 'file' ||
        file.element._id.toString() !== fileId ||
        !file.folder
      ) {
        throw retirementConflict()
      }
      await EditorRealTimeController.emitToRoom(
        projectId,
        'reciveNewFile',
        file.folder._id,
        file.element,
        'github',
        null,
        retirement.userId
      )
    }
  }
  await completeDocumentRetirement(retirement, status)
}

/**
 * @param {string} projectId
 * @param {{operationId?: string}} [options]
 * @returns {Promise<CommittedRetirement | undefined>} Committed operation when cleanup was resumed.
 */
export async function settleActiveRetirement(projectId, options = {}) {
  if (!retirementEnabled()) return
  const active = await readActiveDocumentRetirement(projectId)
  if (!active || active.retirement.operationId === options.operationId) return

  const state =
    active.status === 'prepared'
      ? await decidePreparedRetirement(active.retirement)
      : active
  if (state.status !== 'committed' && state.status !== 'aborted') {
    throw retirementConflict()
  }
  await finishRetirement(state)
  if (state.status === 'committed') return state.retirement
}

/** @param {RetirementIntent} retirement */
async function decidePreparedRetirement(retirement) {
  const { projectId, docId, operationId, version, replacement } = retirement
  const owner = { projectId, docId, operationId, version }
  const reply =
    await DocumentUpdaterHandler.promises.reconcileDocumentRetirement(owner)
  if (reply.status === 'conflict') return await abortDocumentRetirement(owner)
  if (reply.status !== 'prepared' || reply.persisted.version !== version) {
    throw retirementConflict()
  }
  const history = await fetchJson(
    `${Settings.apis.project_history.url}/project/${projectId}/retirement-ready`,
    { signal: AbortSignal.timeout(5000) }
  )
  if (history?.ready !== true) throw retirementConflict()
  const commit = replacement
    ? commitDocumentReplacement
    : commitDocumentRetirement
  const state = await commit(owner, {
    ...owner,
    docstoreRev: reply.persisted.rev,
  })
  return state.status === 'conflict'
    ? await abortDocumentRetirement(owner)
    : state
}

/**
 * @param {RetirementOwner} owner
 * @param {string} path
 * @param {string} userId
 * @param {RetirementReplacement} [replacement]
 * @returns {Promise<CommittedRetirement>}
 */
export async function retireGitHubDocument(owner, path, userId, replacement) {
  const { projectId, docId } = owner
  const canonicalPath = path.startsWith('/') ? path : `/${path}`
  let state = await readDocumentRetirement(owner)
  if (state.status === 'missing') {
    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: true,
      version: true,
      'overleaf.history.id': true,
    })
    if (!project) throw retirementConflict()
    const historyId = project.overleaf?.history?.id?.toString()
    if (!historyId || !/^[a-f0-9]{24}$/.test(historyId)) {
      throw new OError(
        'Editable document retirement requires a Mongo history project.',
        { status: 409 }
      )
    }
    const located = await ProjectLocator.promises.findElementByPath({
      project,
      path: canonicalPath,
      exactCaseMatch: true,
    })
    if (
      located?.type !== 'doc' ||
      located.element._id.toString() !== docId ||
      !located.folder?._id
    ) {
      throw retirementConflict()
    }
    /** @type {RetirementIntent} */
    const intent = {
      ...owner,
      folderId: located.folder._id.toString(),
      baseStructureVersion: project.version ?? null,
      path: canonicalPath,
      userId,
      ...(replacement && { replacement }),
    }
    state = await prepareDocumentRetirement(intent)
  }
  if ('retirement' in state) {
    const stored = state.retirement.replacement
    if (
      state.retirement.path !== canonicalPath ||
      stored?.sourceCommit !== replacement?.sourceCommit ||
      stored?.hash !== replacement?.hash ||
      stored?.name !== replacement?.name
    ) {
      throw retirementConflict()
    }
  }

  if (state.status === 'prepared')
    state = await decidePreparedRetirement(state.retirement)

  if (state.status === 'committed' || state.status === 'aborted') {
    await finishRetirement(state)
    if (state.status === 'committed') return state.retirement
  }
  throw retirementConflict()
}
