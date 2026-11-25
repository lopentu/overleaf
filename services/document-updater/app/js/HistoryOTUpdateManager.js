// @ts-check

const Profiler = require('./Profiler')
const DocumentManager = require('./DocumentManager')
const Errors = require('./Errors')
const RedisManager = require('./RedisManager')
const {
  EditOperationBuilder,
  StringFileData,
  EditOperationTransformer,
} = require('overleaf-editor-core')
const Metrics = require('./Metrics')
const ProjectHistoryRedisManager = require('./ProjectHistoryRedisManager')
const HistoryManager = require('./HistoryManager')
const RealTimeRedisManager = require('./RealTimeRedisManager')
const QueuedDocumentApply = require('./QueuedDocumentApply')

/**
 * @typedef {import("./types").Update} Update
 * @typedef {import("./types").HistoryOTEditOperationUpdate} HistoryOTEditOperationUpdate
 * @typedef {import("./QueuedDocumentApply").GuardedProcessingContext} GuardedProcessingContext
 */

/**
 * @param {Update} update
 * @return {update is HistoryOTEditOperationUpdate}
 */
function isHistoryOTEditOperationUpdate(update) {
  return (
    update &&
    'doc' in update &&
    'op' in update &&
    'v' in update &&
    Array.isArray(update.op) &&
    update.op.length > 0 &&
    update.op.every(op => EditOperationBuilder.isValid(op))
  )
}

/**
 * Try to apply an update to the given document
 *
 * @param {string} projectId
 * @param {string} docId
 * @param {HistoryOTEditOperationUpdate} update
 * @param {Profiler} profiler
 * @param {GuardedProcessingContext} [processing]
 */
async function tryApplyUpdate(projectId, docId, update, profiler, processing) {
  if (processing) {
    const receipt = await QueuedDocumentApply.getExistingReceipt(
      projectId,
      docId,
      processing
    )
    if (receipt) return receipt
    update = structuredClone(update)
  }
  let { lines, version, pathname, type } =
    await DocumentManager.promises.getDoc(projectId, docId)
  profiler.log('getDoc')

  if (lines == null || version == null) {
    throw new Errors.NotFoundError(`document not found: ${docId}`)
  }
  if (type !== 'history-ot') {
    throw new Errors.OTTypeMismatchError(type, 'history-ot')
  }
  const previousVersion = version

  // An update carries a list of sequential ops (e.g. a text edit composed
  // with a comment op). Keep the sequential apply in step with the frontend's
  // historyOTType.apply and HistoryOTAdapter.onRemoteOp.
  let ops = update.op.map(EditOperationBuilder.fromJSON)
  if (version !== update.v) {
    const transformUpdates = await RedisManager.promises.getPreviousDocOps(
      docId,
      update.v,
      version
    )
    for (const transformUpdate of transformUpdates) {
      if (!isHistoryOTEditOperationUpdate(transformUpdate)) {
        throw new Errors.OTTypeMismatchError('sharejs-text-ot', 'history-ot')
      }

      if (
        transformUpdate.meta.source &&
        update.dupIfSource?.includes(transformUpdate.meta.source)
      ) {
        update.dup = true
        break
      }

      // Rebase our ops onto the concurrent update.
      const transformOps = transformUpdate.op.map(EditOperationBuilder.fromJSON)
      EditOperationTransformer.transformMultiple(ops, transformOps)
    }
    update.op = ops.map(op => op.toJSON())
  }

  if (!update.dup) {
    const file = StringFileData.fromRaw(lines)
    for (const op of ops) {
      file.edit(op)
    }
    lines = file.toRaw()
    version += 1
    update.meta.ts = Date.now()
  }

  const forHistory = () => ({
    ...update,
    meta: { ...update.meta, pathname },
  })
  let receipt
  if (processing) {
    // The editor's submitted base version remains on the broadcast update.
    // History must see the actual base used by the guarded document write.
    const historyEntries = update.dup
      ? []
      : [JSON.stringify({ ...forHistory(), v: previousVersion })]
    const result = QueuedDocumentApply.requireReceipt(
      await RedisManager.promises.updateDocument(
        projectId,
        docId,
        lines,
        version,
        update.dup ? [] : [update],
        {},
        update.meta,
        { identity: processing.identity, previousVersion, historyEntries }
      )
    )
    if (result.status === 'replayed') return result.receipt
    receipt = result.receipt
  } else if (!update.dup) {
    await RedisManager.promises.updateDocument(
      projectId,
      docId,
      lines,
      version,
      [update],
      {},
      update.meta
    )

    Metrics.inc('history-queue', 1, { status: 'project-history' })
    try {
      const projectOpsLength =
        await ProjectHistoryRedisManager.promises.queueOps(projectId, [
          JSON.stringify(forHistory()),
        ])
      HistoryManager.recordAndFlushHistoryOps(
        projectId,
        [update],
        projectOpsLength
      )
      profiler.log('recordAndFlushHistoryOps')
    } catch (err) {
      // The full project history can re-sync a project in case
      //  updates went missing.
      // Just record the error here and acknowledge the write-op.
      Metrics.inc('history-queue-error')
    }
  }
  if (!update.dup) {
    await RedisManager.promises.recordProjectNotificationTimestamp(
      projectId,
      update.meta.ts
    )
    profiler.log('recordProjectNotificationTimestamp')
  }
  RealTimeRedisManager.sendData({
    project_id: projectId,
    doc_id: docId,
    op: update,
  })
  return receipt
}

/**
 * Apply an update to the given document
 *
 * @param {string} projectId
 * @param {string} docId
 * @param {HistoryOTEditOperationUpdate} update
 * @param {GuardedProcessingContext} [processing]
 */
async function applyUpdate(projectId, docId, update, processing) {
  const profiler = new Profiler('applyUpdate', {
    project_id: projectId,
    doc_id: docId,
    type: 'history-ot',
  })

  try {
    return await tryApplyUpdate(projectId, docId, update, profiler, processing)
  } catch (error) {
    // The batch owner reconciles an uncertain guarded write before notifying.
    if (!processing) {
      RealTimeRedisManager.sendData({
        project_id: projectId,
        doc_id: docId,
        error: error instanceof Error ? error.message : String(error),
      })
      profiler.log('sendData')
    }
    throw error
  } finally {
    profiler.end()
  }
}

module.exports = { isHistoryOTEditOperationUpdate, applyUpdate }
