// @ts-check

import { createHash } from 'node:crypto'
import { EditOperationBuilder } from 'overleaf-editor-core'
import { isHistoryPublication } from 'overleaf-editor-core/lib/history_publication.js'

/** @import { HistoryPublication } from 'overleaf-editor-core/lib/types' */

/** @type {WeakMap<object, HistoryPublication>} */
const publications = new WeakMap()

const editableUpdateFields = new Set([
  'doc',
  'op',
  'v',
  'meta',
  'projectHistoryId',
  'dupIfSource',
  'lastV',
  'hash',
])

/** @param {object} update */
export function getHistoryPublication(update) {
  return publications.get(update)
}

/** @param {string} raw */
export function parseHistoryUpdate(raw) {
  const envelope = JSON.parse(raw)
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    !Object.hasOwn(envelope, 'historyPublication')
  ) {
    return envelope
  }

  const invalidPublication = () =>
    new Error('invalid private history publication')
  const { historyPublication, source } = envelope
  if (
    Object.keys(envelope).length !== 2 ||
    !isHistoryPublication(historyPublication) ||
    typeof source !== 'string' ||
    !source.isWellFormed() ||
    createHash('sha256').update(source, 'utf8').digest('hex') !==
      historyPublication.digest
  ) {
    throw invalidPublication()
  }

  let update
  try {
    update = JSON.parse(source)
  } catch {
    throw invalidPublication()
  }
  if (
    !(isEditableUpdate(update) || isRetirementStructureUpdate(update)) ||
    (update.projectHistoryId != null &&
      update.projectHistoryId !== historyPublication.historyId)
  ) {
    throw invalidPublication()
  }

  publications.set(update, Object.freeze(historyPublication))
  return update
}

// These structural entries can only be issued by the committed Web
// retirement path. The ordinary editor ingress excludes both shapes.
export function isRetirementStructureUpdate(update) {
  return isRetiredDocumentRemoval(update) || isRetirementFileAddition(update)
}

function isRetiredDocumentRemoval(update) {
  return (
    isRetirementStructureStep(update, '0') &&
    typeof update.doc === 'string' &&
    /^[a-f0-9]{24}$/.test(update.doc) &&
    update.new_pathname === ''
  )
}

export function isRetirementFileAddition(update) {
  return (
    isRetirementStructureStep(update, '1') &&
    typeof update.file === 'string' &&
    /^[a-f0-9]{24}$/.test(update.file) &&
    typeof update.hash === 'string' &&
    /^[a-f0-9]{40}$/.test(update.hash)
  )
}

function isRetirementStructureStep(update, step) {
  if (
    !update ||
    typeof update !== 'object' ||
    Object.keys(update).length !== 5
  ) {
    return false
  }
  const { pathname, version, meta } = update
  const versionMatch =
    typeof version === 'string' && /^([1-9]\d*)\.([01])$/.exec(version)
  return (
    typeof pathname === 'string' &&
    pathname.startsWith('/') &&
    pathname
      .slice(1)
      .split('/')
      .every(part => part && part !== '.' && part !== '..') &&
    Boolean(
      versionMatch &&
      versionMatch[2] === step &&
      Number.isSafeInteger(Number(versionMatch[1]))
    ) &&
    meta != null &&
    typeof meta === 'object' &&
    Object.keys(meta).length === 2 &&
    typeof meta.user_id === 'string' &&
    /^[a-f0-9]{24}$/.test(meta.user_id) &&
    typeof meta.ts === 'string' &&
    Number.isFinite(Date.parse(meta.ts)) &&
    new Date(meta.ts).toISOString() === meta.ts
  )
}

function isEditableUpdate(update) {
  if (
    update === null ||
    typeof update !== 'object' ||
    !Object.keys(update).every(key => editableUpdateFields.has(key)) ||
    typeof update.doc !== 'string' ||
    !update.doc ||
    !Number.isSafeInteger(update.v) ||
    update.v < 0 ||
    !Array.isArray(update.op) ||
    update.op.length === 0 ||
    typeof update.meta?.pathname !== 'string' ||
    !update.meta.pathname ||
    !['number', 'string'].includes(typeof update.meta.ts) ||
    !Number.isFinite(new Date(update.meta.ts).getTime())
  ) {
    return false
  }

  if (EditOperationBuilder.isValid(update.op[0])) {
    return update.op.every(EditOperationBuilder.isValid)
  }
  return (
    Number.isSafeInteger(update.meta.doc_length) &&
    update.meta.doc_length >= 0 &&
    update.op.every(
      op =>
        op &&
        Number.isSafeInteger(op.p) &&
        op.p >= 0 &&
        (typeof op.i === 'string' ||
          typeof op.d === 'string' ||
          typeof op.r === 'string' ||
          (typeof op.c === 'string' && typeof op.t === 'string'))
    )
  )
}
