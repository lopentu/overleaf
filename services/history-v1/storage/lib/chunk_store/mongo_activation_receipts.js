// @ts-check

const {
  isHistoryPublication,
} = require('overleaf-editor-core/lib/history_publication.js')

/** @import Change from 'overleaf-editor-core/lib/change' */
/** @import Chunk from 'overleaf-editor-core/lib/chunk' */
/** @typedef {import('overleaf-editor-core/lib/types').HistoryPublication} HistoryPublication */
/** @typedef {{_id: string, historyVersion: number} & HistoryPublication} ReceiptRow */
/** @import { ClientSession, Collection } from 'mongodb' */
/** @typedef {{status: 'pending' | 'conflict'} | {status: 'committed', historyVersion: number}} ReceiptStatus */

/** @param {Chunk} chunk */
function hasHistoryActivationReceipts(chunk) {
  return chunk
    .getChanges()
    .some(change => change.getHistoryPublication() != null)
}

/** @param {Change} change @param {HistoryPublication} receipt */
function assertReceiptIsPersistedInChange(change, receipt) {
  const taggedRaw = change.toStorageRaw().historyPublication
  if (
    !taggedRaw ||
    taggedRaw.historyId !== receipt.historyId ||
    taggedRaw.batchId !== receipt.batchId ||
    taggedRaw.ordinal !== receipt.ordinal ||
    taggedRaw.entryOrdinal !== receipt.entryOrdinal ||
    taggedRaw.digest !== receipt.digest
  ) {
    throw new Error(
      'History receipt metadata is missing or changed on the serialized change'
    )
  }
}

const historyIdPattern = /^[a-f0-9]{24}$/

/** @param {number} value */
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** @param {string} historyId */
function assertMongoHistoryId(historyId) {
  if (!historyIdPattern.test(historyId))
    throw new TypeError('Expected a Mongo history ID')
}

/** @param {string} historyId @param {HistoryPublication} entry */
function receiptId(historyId, entry) {
  if (!isHistoryPublication(entry) || entry.historyId !== historyId) {
    throw new TypeError('Invalid history publication metadata')
  }
  return `${historyId}:${entry.batchId}:${entry.ordinal}:${entry.entryOrdinal}`
}

/** @param {Collection<ReceiptRow>} collection */
function createMongoHistoryActivationReceipts(collection) {
  /** @param {string} historyId @param {HistoryPublication} entry @returns {Promise<ReceiptStatus>} */
  async function lookup(historyId, entry) {
    assertMongoHistoryId(historyId)
    const row = await collection.findOne(
      { _id: receiptId(historyId, entry) },
      {
        readPreference: 'primary',
        readConcern: { level: 'majority' },
      }
    )
    if (!row) return { status: 'pending' }
    if (row.digest !== entry.digest) return { status: 'conflict' }
    if (!nonnegativeInteger(row.historyVersion) || row.historyVersion === 0) {
      throw new Error('Invalid committed history receipt version')
    }
    return { status: 'committed', historyVersion: row.historyVersion }
  }

  /**
   * Called only from a history-v1 transaction that activates this chunk.
   * For an extension, previousEnd is the durably stored end of the replaced
   * active chunk, never the caller's submitted end_version.
   * @param {string} historyId
   * @param {Chunk} chunk
   * @param {number} previousEnd
   * @param {ClientSession} session
   */
  async function recordNewlyActivated(historyId, chunk, previousEnd, session) {
    assertMongoHistoryId(historyId)
    if (!session.inTransaction())
      throw new Error('An active chunk transaction is required')
    const start = chunk.getStartVersion()
    const end = chunk.getEndVersion()
    const changes = chunk.getChanges()
    if (
      !nonnegativeInteger(start) ||
      !nonnegativeInteger(end) ||
      !nonnegativeInteger(previousEnd) ||
      start > previousEnd ||
      previousEnd > end ||
      start + changes.length !== end
    ) {
      throw new Error('Invalid activation version boundary')
    }

    /** @type {ReceiptRow[]} */
    const records = []
    const known = new Set()
    for (let i = previousEnd - start; i < changes.length; i++) {
      const entry = changes[i].getHistoryPublication()
      if (!entry) continue
      assertReceiptIsPersistedInChange(changes[i], entry)
      const _id = receiptId(historyId, entry)
      if (known.has(_id))
        throw new Error('Duplicate history processing identity in chunk')
      known.add(_id)
      const { batchId, ordinal, entryOrdinal, digest } = entry
      records.push({
        _id,
        historyId,
        historyVersion: start + i + 1,
        batchId,
        ordinal,
        entryOrdinal,
        digest,
      })
    }
    // Insert only. A duplicate key from an overlapping attempt must abort the
    // chunk activation. The caller then obtains the original receipt by lookup.
    if (records.length)
      await collection.insertMany(records, { session, ordered: true })
  }

  return { lookup, recordNewlyActivated }
}

module.exports = {
  createMongoHistoryActivationReceipts,
  hasHistoryActivationReceipts,
}
