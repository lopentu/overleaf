// @ts-check

const { randomUUID } = require('node:crypto')
const MAX_PROJECT_DRAIN_ATTEMPTS = 8

/**
 * @typedef {import('@overleaf/redis-wrapper/ProjectUpdateQueue.js')} ProjectUpdateQueue
 * @typedef {import('./DocumentWriterSeal').QueueApplicationIdentity} QueueApplicationIdentity
 * @typedef {import('./DocumentWriterSeal').DocumentApplicationReceipt} DocumentApplicationReceipt
 * @typedef {Pick<ProjectUpdateQueue, 'getBatchState' | 'claimBatch' | 'acknowledgeBatch'>} BatchQueue
 * @typedef {{
 *   queue: BatchQueue,
 *   apply: (
 *     projectId: string,
 *     rawUpdate: string,
 *     identity: QueueApplicationIdentity
 *   ) => Promise<DocumentApplicationReceipt>,
 *   ensureHistoryDurable: (
 *     projectId: string,
 *     identity: QueueApplicationIdentity,
 *     receipt: DocumentApplicationReceipt
 *   ) => Promise<'durable' | 'pending'>
 * }} Dependencies
 */

/**
 * Process one batch while the caller holds the project lock. An incomplete
 * batch remains claimable with the same update identities. A Redis history
 * enqueue alone cannot satisfy the durable history check.
 *
 * @param {Dependencies} dependencies
 * @param {string} projectId
 * @param {() => Promise<void>} renewLock
 * @returns {Promise<'empty' | 'reconcile' | 'waiting-history' | 'acknowledged'>}
 */
async function processQueuedBatch(
  { queue, apply, ensureHistoryDurable },
  projectId,
  renewLock
) {
  const { generation, activeBatchId } = await queue.getBatchState(projectId)
  const batchId = activeBatchId ?? randomUUID()
  const claim = await queue.claimBatch(projectId, batchId, generation)

  if (claim.status === 'empty') return 'empty'
  if (!('entries' in claim)) return 'reconcile'

  for (const [ordinal, rawUpdate] of claim.entries.entries()) {
    const identity = { batchId, ordinal }
    await renewLock()
    const receipt = await apply(projectId, rawUpdate, identity)
    await renewLock()
    if (
      (await ensureHistoryDurable(projectId, identity, receipt)) !== 'durable'
    ) {
      return 'waiting-history'
    }
  }

  await renewLock()
  const result = await queue.acknowledgeBatch(projectId, batchId, generation)
  return result.status === 'acknowledged' ? 'acknowledged' : 'reconcile'
}

module.exports = { MAX_PROJECT_DRAIN_ATTEMPTS, processQueuedBatch }
