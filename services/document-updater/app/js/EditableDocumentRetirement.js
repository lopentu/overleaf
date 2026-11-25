// @ts-check

const Settings = require('@overleaf/settings')
const ProjectLockManager = require('./ProjectLockManager')
const RedisManager = require('./RedisManager')
const RealTimeRedisManager = require('./RealTimeRedisManager')
const DocumentManager = require('./DocumentManager')
const HistoryManager = require('./HistoryManager')
const UpdateManager = require('./UpdateManager')
const WebApiManager = require('./WebApiManager')
const { MAX_PROJECT_DRAIN_ATTEMPTS } = require('./QueuedProjectUpdates')

/** @typedef {import('./RedisManager').SealOwner} SealOwner */
/** @typedef {{version: number, rev: number}} PersistedRevision */
/** @typedef {{status: 'prepared', persisted: PersistedRevision} | {status: 'pending' | 'conflict' | 'committed' | 'aborted'}} RetirementResult */

/** @returns {boolean} */
function isEnabled() {
  return (
    Settings.documentupdater?.enableRetirementQueue === true &&
    Settings.documentupdater?.enableRetirementWriterSeal === true
  )
}

/**
 * Reconcile the exact majority-confirmed Web decision under the project lock.
 * A missing or indeterminate decision cannot authorize cleanup.
 * @param {SealOwner} owner
 * @returns {Promise<RetirementResult>}
 */
async function reconcileRetirement(owner) {
  if (!isEnabled())
    throw new Error('Guarded document retirement is unavailable')

  const { projectId, docId, operationId } = owner
  const queue = RealTimeRedisManager.guardedProjectQueue
  return await UpdateManager.promises.withGuardedProjectLock(
    projectId,
    async lock => {
      const decision = await WebApiManager.promises.getRetirementDecision(owner)
      await ProjectLockManager.promises.extendLock(projectId, lock)

      if (decision === 'prepared') return await prepareUnderLock(owner, lock)
      if (decision === 'unknown') return { status: 'pending' }
      if (decision === 'committed') {
        const history =
          await HistoryManager.promises.ensureRetirementHistoryDurable(owner)
        if (history !== 'durable') return { status: 'pending' }
        await ProjectLockManager.promises.extendLock(projectId, lock)
        const evicted =
          await RedisManager.promises.evictSealedDocumentCache(owner)
        if (evicted !== 'evicted') return { status: 'conflict' }
        const outcome = await queue.resolveDocumentFence(
          projectId,
          docId,
          operationId,
          'commit'
        )
        if (outcome !== 'committed' && outcome !== 'already_committed') {
          return { status: 'conflict' }
        }
        // Keep the committed seal as a tombstone for this retired document ID.
        return { status: 'committed' }
      }
      if (decision === 'aborted') {
        const released =
          await RedisManager.promises.releaseDocumentWriteSeal(owner)
        if (released !== 'released' && released !== 'missing')
          return { status: 'conflict' }
        const outcome = await queue.resolveDocumentFence(
          projectId,
          docId,
          operationId,
          'abort'
        )
        if (
          outcome === 'aborted' ||
          outcome === 'already_aborted' ||
          outcome === 'stale_operation'
        ) {
          return { status: 'aborted' }
        }
      }
      return { status: 'conflict' }
    }
  )
}

/**
 * @param {SealOwner} owner
 * @param {string} lock
 * @returns {Promise<RetirementResult>}
 */
async function prepareUnderLock(owner, lock) {
  const { projectId, docId, operationId, version } = owner
  const queue = RealTimeRedisManager.guardedProjectQueue
  const ensureHistoryDurable =
    HistoryManager.promises.ensureQueuedHistoryDurable
  for (let attempt = 0; attempt < MAX_PROJECT_DRAIN_ATTEMPTS; attempt++) {
    await ProjectLockManager.promises.extendLock(projectId, lock)
    const fence = await queue.fenceDocument(projectId, docId, operationId)
    if (fence === 'not_drained') {
      const result =
        await UpdateManager.promises.processGuardedQueuedBatchUnderLock(
          projectId,
          lock,
          { queue, ensureHistoryDurable }
        )
      if (result === 'empty' || result === 'acknowledged') continue
      return { status: 'pending' }
    }
    if (fence !== 'fenced' && fence !== 'already_fenced')
      return { status: 'conflict' }

    const doc = await DocumentManager.promises.getDoc(projectId, docId)
    if (doc.version !== version) return { status: 'conflict' }

    await ProjectLockManager.promises.extendLock(projectId, lock)
    const sealed = await RedisManager.promises.sealDocumentWrite(owner)
    if (sealed === 'load-in-progress') return { status: 'pending' }
    if (sealed !== 'sealed') return { status: 'conflict' }

    const persisted = await DocumentManager.promises.flushSealedDocument(owner)
    if (persisted.version !== version)
      throw new Error('Persisted retirement version did not match the seal')
    return { status: 'prepared', persisted }
  }
  return { status: 'pending' }
}

module.exports = { isEnabled, reconcileRetirement }
