// @ts-check
'use strict'

/** @import { HistoryPublication } from './types' */

const historyIdPattern = /^[a-f0-9]{24}$/
const batchIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const fields = ['historyId', 'batchId', 'ordinal', 'entryOrdinal', 'digest']

/** @param {unknown} value @returns {value is HistoryPublication} */
function isHistoryPublication(value) {
  if (!value || typeof value !== 'object') return false
  const publication = /** @type {Partial<HistoryPublication>} */ (value)
  const { historyId, batchId, ordinal, entryOrdinal, digest } = publication
  return (
    Reflect.ownKeys(value).length === fields.length &&
    fields.every(field =>
      Object.prototype.propertyIsEnumerable.call(value, field)
    ) &&
    typeof historyId === 'string' &&
    historyIdPattern.test(historyId) &&
    typeof batchId === 'string' &&
    batchIdPattern.test(batchId) &&
    typeof ordinal === 'number' &&
    Number.isSafeInteger(ordinal) &&
    ordinal >= 0 &&
    typeof entryOrdinal === 'number' &&
    Number.isSafeInteger(entryOrdinal) &&
    entryOrdinal >= 0 &&
    typeof digest === 'string' &&
    digestPattern.test(digest)
  )
}

module.exports = { isHistoryPublication }
