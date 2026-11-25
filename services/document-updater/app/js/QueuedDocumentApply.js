// @ts-check

const Settings = require('@overleaf/settings')
const RedisManager = require('./RedisManager')
const { DocumentVersionMismatchError } = require('./Errors')

/** @typedef {import('./DocumentWriterSeal').QueueApplicationIdentity} QueueApplicationIdentity */
/** @typedef {import('./DocumentWriterSeal').DocumentApplicationResult} DocumentApplicationResult */
/** @typedef {{identity: QueueApplicationIdentity}} GuardedProcessingContext */

/**
 * @param {string} projectId
 * @param {string} docId
 * @param {GuardedProcessingContext} processing
 */
async function getExistingReceipt(projectId, docId, processing) {
  if (Settings.documentupdater?.enableRetirementWriterSeal !== true) {
    throw new Error('Queued document applications require the writer seal')
  }
  return await RedisManager.promises.getQueuedUpdateReceipt(
    projectId,
    docId,
    processing.identity
  )
}

/** @param {DocumentApplicationResult | undefined} result */
function requireReceipt(result) {
  if (result && 'receipt' in result) return result
  if (result?.status === 'version-mismatch') {
    throw new DocumentVersionMismatchError('document version changed')
  }
  if (result?.status === 'sealed') {
    throw new Error('document writer seal rejected the queued update')
  }
  throw new Error('queued document write did not return a receipt')
}

module.exports = { getExistingReceipt, requireReceipt }
