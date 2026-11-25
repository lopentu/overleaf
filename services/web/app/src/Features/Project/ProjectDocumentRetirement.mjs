// @ts-check

import mongoose from 'mongoose'
import { Project } from '../../models/Project.mjs'

const { ObjectId } = mongoose.Types

/** @typedef {import('mongoose').Types.ObjectId} BsonObjectId */

/** @typedef {{projectId: string, docId: string, operationId: string, version: number}} RetirementOwner */
/** @typedef {{sourceCommit: string, fileId: string, hash: string, name: string, created: Date}} RetirementReplacement */
/** @typedef {Omit<RetirementReplacement, 'fileId'> & {fileId: BsonObjectId}} StoredReplacement */
/** @typedef {RetirementOwner & {folderId: string, path: string, baseStructureVersion: number | null, userId: string, completedAt?: Date, replacement?: RetirementReplacement}} RetirementIntent */
/** @typedef {RetirementIntent & {committedStructureVersion: number, deletedAt: Date, docstoreRev?: number}} CommittedRetirement */
/** @typedef {{status: 'prepared', retirement: RetirementIntent} | {status: 'committed', retirement: CommittedRetirement} | {status: 'aborted', retirement: RetirementIntent} | {status: 'missing' | 'unknown' | 'conflict'}} RetirementResult */
/** @typedef {{_id: BsonObjectId, name: string}} TreeEntity */
/** @typedef {TreeEntity & {folders?: (TreeFolder | null)[], docs?: (TreeEntity | null)[]}} TreeFolder */
/** @typedef {{docId: BsonObjectId, folderId: BsonObjectId, userId: BsonObjectId, path: string, editorVersion: number, baseStructureVersion: number | null, phase: 'prepared' | 'committed' | 'aborted', committedStructureVersion?: number, deletedAt?: Date, completedAt?: Date, replacement?: StoredReplacement, docstoreRev?: number}} StoredRetirement */
/** @typedef {{_id: BsonObjectId, rootFolder?: (TreeFolder | null)[], version?: number, rootDoc_id?: BsonObjectId, mainBibliographyDoc_id?: BsonObjectId, documentRetirements?: Record<string, StoredRetirement>, activeDocumentRetirement?: string}} ProjectSnapshot */
/** @typedef {import('mongoose').FilterQuery<ProjectSnapshot>} ProjectFilter */
/** @typedef {import('mongoose').UpdateQuery<ProjectSnapshot>} ProjectUpdate */

const receiptProjection = {
  _id: 1,
  documentRetirements: 1,
  activeDocumentRetirement: 1,
}
const treeProjection = {
  ...receiptProjection,
  rootFolder: 1,
  version: 1,
  rootDoc_id: 1,
  mainBibliographyDoc_id: 1,
}
const majorityRead = /** @type {const} */ ({
  readPreference: 'primary',
  readConcern: { level: 'majority' },
})

/** @param {unknown} input */
function isId(input) {
  return typeof input === 'string' && /^[a-f0-9]{24}$/.test(input)
}

/** @param {unknown} input @returns {input is number} */
function isRevision(input) {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

/** @param {RetirementReplacement} replacement @param {string} docId */
function validReplacement(replacement, docId) {
  return (
    replacement != null &&
    isId(replacement.fileId) &&
    replacement.fileId !== docId &&
    typeof replacement.sourceCommit === 'string' &&
    /^[a-f0-9]{40}$/.test(replacement.sourceCommit) &&
    typeof replacement.hash === 'string' &&
    /^[a-f0-9]{40}$/.test(replacement.hash) &&
    typeof replacement.name === 'string' &&
    replacement.name.length > 0 &&
    replacement.created instanceof Date &&
    Number.isFinite(replacement.created.getTime())
  )
}

/** @param {RetirementOwner} owner */
function validateOwner(owner) {
  if (
    !isId(owner.projectId) ||
    !isId(owner.docId) ||
    typeof owner.operationId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner.operationId) ||
    !isRevision(owner.version)
  )
    throw new Error('Invalid document retirement identity')
}

/** @param {RetirementOwner} first @param {RetirementOwner} second */
function sameOwner(first, second) {
  return (
    first.projectId === second.projectId &&
    first.docId === second.docId &&
    first.operationId === second.operationId &&
    first.version === second.version
  )
}

/** @param {RetirementIntent} first @param {RetirementIntent} second */
function sameIntent(first, second) {
  return (
    first.folderId === second.folderId &&
    first.userId === second.userId &&
    first.path === second.path &&
    first.baseStructureVersion === second.baseStructureVersion &&
    // Upload retries produce new provisional file IDs. Reuse the file identity
    // already recorded for the same source commit, path and blob.
    first.replacement?.sourceCommit === second.replacement?.sourceCommit &&
    first.replacement?.hash === second.replacement?.hash &&
    first.replacement?.name === second.replacement?.name
  )
}

/** @param {number | null} expected */
function versionPredicate(expected) {
  // Before the first structural edit a project may have no revision field.
  return expected === null ? { $exists: false } : expected
}

/** @param {ProjectSnapshot|null} project @param {RetirementOwner} owner @returns {RetirementResult} */
function resolveReceipt(project, owner) {
  if (!project) return { status: 'missing' }
  if (project._id.toHexString() !== owner.projectId)
    return { status: 'unknown' }
  const stored = project.documentRetirements?.[owner.operationId]
  if (!stored) return { status: 'missing' }
  if (
    stored.docId.toHexString() !== owner.docId ||
    stored.editorVersion !== owner.version
  ) {
    return { status: 'conflict' }
  }
  if (
    stored.baseStructureVersion !== null &&
    !isRevision(stored.baseStructureVersion)
  ) {
    return { status: 'unknown' }
  }
  const replacement = stored.replacement && {
    ...stored.replacement,
    fileId: stored.replacement.fileId.toHexString(),
  }
  if (replacement && !validReplacement(replacement, owner.docId)) {
    return { status: 'unknown' }
  }
  const retirement = {
    projectId: owner.projectId,
    docId: owner.docId,
    operationId: owner.operationId,
    version: owner.version,
    folderId: stored.folderId.toHexString(),
    path: stored.path,
    userId: stored.userId.toHexString(),
    baseStructureVersion: stored.baseStructureVersion,
    ...(replacement ? { replacement } : {}),
    ...(stored.completedAt instanceof Date && {
      completedAt: stored.completedAt,
    }),
  }
  if (stored.phase === 'prepared') return { status: 'prepared', retirement }
  if (stored.phase === 'aborted') return { status: 'aborted', retirement }
  if (
    stored.phase === 'committed' &&
    stored.committedStructureVersion ===
      (stored.baseStructureVersion ?? 0) + 1 &&
    stored.deletedAt instanceof Date
  ) {
    return {
      status: 'committed',
      retirement: {
        ...retirement,
        committedStructureVersion: stored.committedStructureVersion,
        deletedAt: stored.deletedAt,
        ...(isRevision(stored.docstoreRev) && {
          docstoreRev: stored.docstoreRev,
        }),
      },
    }
  }
  return { status: 'unknown' }
}

/** @template {TreeEntity} T @param {(T | null)[] | undefined} entries @param {string} name */
function findUniqueName(entries, name) {
  const index = entries?.findIndex(entry => entry?.name === name) ?? -1
  if (
    !entries ||
    index < 0 ||
    entries.findIndex(
      (entry, position) => position > index && entry?.name === name
    ) !== -1
  )
    return null
  const entry = entries[index]
  return entry && { entry, index }
}

/** @param {ProjectSnapshot} project @param {RetirementIntent} intent */
function locateDocument(project, intent) {
  const parts = intent.path.slice(1).split('/')
  if (
    !intent.path.startsWith('/') ||
    parts.some(part => !part || part === '.' || part === '..')
  )
    return null
  const name = parts.pop()
  const root = project.rootFolder?.[0]
  if (!root || !name) return null
  /** @type {TreeFolder} */
  let parent = root
  let parentPath = 'rootFolder.0'
  /** @type {ProjectFilter} */
  const predicates = { [`${parentPath}._id`]: parent._id }
  for (const part of parts) {
    const child = findUniqueName(parent.folders, part)
    if (!child) return null
    parent = child.entry
    parentPath += `.folders.${child.index}`
    predicates[`${parentPath}._id`] = parent._id
    predicates[`${parentPath}.name`] = part
  }
  const doc = findUniqueName(parent.docs, name)
  if (
    !doc ||
    doc.entry._id.toHexString() !== intent.docId ||
    parent._id.toHexString() !== intent.folderId ||
    (intent.replacement && intent.replacement.name !== name)
  )
    return null
  const list = `${parentPath}.docs`
  predicates[`${list}.${doc.index}._id`] = doc.entry._id
  predicates[`${list}.${doc.index}.name`] = name
  return { list, doc: doc.entry, parentPath, predicates }
}

/** @param {RetirementOwner} owner @param {boolean} includeTree @returns {Promise<ProjectSnapshot|null>} */
async function loadProject(owner, includeTree) {
  // The lean projection returns BSON values and plain recursive arrays.
  return /** @type {ProjectSnapshot | null} */ (
    await Project.findById(
      owner.projectId,
      includeTree ? treeProjection : receiptProjection,
      majorityRead
    )
      .lean()
      .exec()
  )
}

/** @param {RetirementOwner} owner @param {ProjectFilter} filter @param {ProjectUpdate} update @param {'prepare' | 'commit' | 'abort'} action @returns {Promise<RetirementResult>} */
async function persistRetirement(owner, filter, update, action) {
  /** @param {RetirementResult} result */
  const confirmsOutcome = result =>
    result.status === 'committed' ||
    result.status === 'aborted' ||
    (action === 'prepare' && result.status === 'prepared')
  let indeterminate = false
  try {
    const project = /** @type {ProjectSnapshot | null} */ (
      await Project.findOneAndUpdate(filter, update, {
        new: true,
        fields: receiptProjection,
        writeConcern: { w: 'majority' },
      })
        .lean()
        .exec()
    )
    if (project) {
      const result = resolveReceipt(project, owner)
      if (confirmsOutcome(result)) return result
      indeterminate = true
    }
  } catch {
    indeterminate = true
  }
  const result = await readDocumentRetirement(owner)
  if (
    confirmsOutcome(result) ||
    result.status === 'unknown' ||
    result.status === 'conflict'
  )
    return result
  return { status: indeterminate ? 'unknown' : 'conflict' }
}

/** @param {RetirementOwner} owner @returns {Promise<RetirementResult>} */
export async function readDocumentRetirement(owner) {
  validateOwner(owner)
  try {
    return resolveReceipt(await loadProject(owner, false), owner)
  } catch {
    return { status: 'unknown' }
  }
}

/** @param {string} projectId */
export async function readActiveDocumentRetirement(projectId) {
  const project = /** @type {ProjectSnapshot | null} */ (
    await Project.findById(projectId, receiptProjection, majorityRead)
      .lean()
      .exec()
  )
  const operationId = project?.activeDocumentRetirement
  if (operationId === undefined) return null
  const receipt = project?.documentRetirements?.[operationId]
  if (!receipt) throw new Error('Active document retirement receipt is missing')
  const state = resolveReceipt(project, {
    projectId,
    docId: receipt.docId.toHexString(),
    operationId,
    version: receipt.editorVersion,
  })
  if (!('retirement' in state) || state.retirement.completedAt) {
    throw new Error('Active document retirement receipt is inconsistent')
  }
  return state
}

/** Record the intent before fencing the live writer. @param {RetirementIntent} intent @returns {Promise<RetirementResult>} */
export async function prepareDocumentRetirement(intent) {
  validateOwner(intent)
  if (
    !isId(intent.folderId) ||
    !isId(intent.userId) ||
    typeof intent.path !== 'string' ||
    (intent.replacement !== undefined &&
      !validReplacement(intent.replacement, intent.docId)) ||
    (intent.baseStructureVersion !== null &&
      !isRevision(intent.baseStructureVersion))
  ) {
    throw new Error('Invalid document retirement intent')
  }
  const project = await loadProject(intent, true).catch(() => undefined)
  if (project === undefined) return { status: 'unknown' }
  if (project === null) return { status: 'missing' }
  const prior = resolveReceipt(project, intent)
  if ('retirement' in prior)
    return sameIntent(prior.retirement, intent) ? prior : { status: 'conflict' }
  if (prior.status !== 'missing') return prior
  const target = locateDocument(project, intent)
  if (!target || project.version !== (intent.baseStructureVersion ?? undefined))
    return { status: 'conflict' }
  const marker = `documentRetirements.${intent.operationId}`
  const record = {
    docId: target.doc._id,
    folderId: new ObjectId(intent.folderId),
    userId: new ObjectId(intent.userId),
    path: intent.path,
    editorVersion: intent.version,
    baseStructureVersion: intent.baseStructureVersion,
    phase: 'prepared',
    ...(intent.replacement
      ? {
          replacement: {
            ...intent.replacement,
            fileId: new ObjectId(intent.replacement.fileId),
          },
        }
      : {}),
  }
  const result = await persistRetirement(
    intent,
    {
      _id: project._id,
      version: versionPredicate(intent.baseStructureVersion),
      activeDocumentRetirement: { $exists: false },
      historyResyncReservation: { $exists: false },
      [marker]: { $exists: false },
      ...target.predicates,
    },
    {
      $set: { [marker]: record, activeDocumentRetirement: intent.operationId },
    },
    'prepare'
  )
  return 'retirement' in result && !sameIntent(result.retirement, intent)
    ? { status: 'conflict' }
    : result
}

/**
 * The caller must have verified the fence against the updater for this exact
 * operation. Mongo only binds the proof's identity to its prepared record.
 * A conflict or unknown outcome alone never authorizes releasing the fence.
 * @param {RetirementOwner} owner
 * @param {RetirementOwner & {docstoreRev?: number}} verifiedFence
 * @param {Date} [now]
 * @returns {Promise<RetirementResult>}
 */
export function commitDocumentRetirement(
  owner,
  verifiedFence,
  now = new Date()
) {
  return commitRetirement(owner, verifiedFence, now, 'remove')
}

/**
 * Commit the file recorded at prepare after verifying the same editor fence.
 * @param {RetirementOwner} owner
 * @param {RetirementOwner & {docstoreRev?: number}} verifiedFence
 * @param {Date} [now]
 * @returns {Promise<RetirementResult>}
 */
export function commitDocumentReplacement(
  owner,
  verifiedFence,
  now = new Date()
) {
  return commitRetirement(owner, verifiedFence, now, 'replace')
}

/**
 * @param {RetirementOwner} owner
 * @param {RetirementOwner & {docstoreRev?: number}} verifiedFence
 * @param {Date} now
 * @param {'remove' | 'replace'} action
 * @returns {Promise<RetirementResult>}
 */
async function commitRetirement(owner, verifiedFence, now, action) {
  validateOwner(owner)
  if (
    !sameOwner(owner, verifiedFence) ||
    (verifiedFence.docstoreRev !== undefined &&
      !isRevision(verifiedFence.docstoreRev))
  )
    return { status: 'conflict' }
  const project = await loadProject(owner, true).catch(() => undefined)
  if (project === undefined) return { status: 'unknown' }
  if (project === null) return { status: 'missing' }
  const result = resolveReceipt(project, owner)
  if (
    'retirement' in result &&
    Boolean(result.retirement.replacement) !== (action === 'replace')
  ) {
    return { status: 'conflict' }
  }
  if (result.status !== 'prepared') return result
  const intent = result.retirement
  const target = locateDocument(project, intent)
  const next = (intent.baseStructureVersion ?? 0) + 1
  if (
    !target ||
    project.version !== (intent.baseStructureVersion ?? undefined) ||
    !isRevision(next)
  )
    return { status: 'conflict' }
  const marker = `documentRetirements.${owner.operationId}`
  const actor = new ObjectId(intent.userId)
  /** @type {ProjectFilter} */
  const filter = {
    _id: project._id,
    version: versionPredicate(intent.baseStructureVersion),
    activeDocumentRetirement: owner.operationId,
    [`${marker}.phase`]: 'prepared',
    [`${marker}.docId`]: target.doc._id,
    [`${marker}.editorVersion`]: owner.version,
    [`${marker}.folderId`]: new ObjectId(intent.folderId),
    [`${marker}.userId`]: actor,
    [`${marker}.path`]: intent.path,
    [`${marker}.baseStructureVersion`]: intent.baseStructureVersion ?? {
      $type: 'null',
    },
    ...target.predicates,
  }
  const replacement = intent.replacement
  const files = `${target.parentPath}.fileRefs`
  const fileRef = replacement && {
    _id: new ObjectId(replacement.fileId),
    name: replacement.name,
    hash: replacement.hash,
    created: replacement.created,
    rev: 0,
  }
  if (replacement && fileRef) {
    Object.assign(filter, {
      [`${marker}.replacement.sourceCommit`]: replacement.sourceCommit,
      [`${marker}.replacement.fileId`]: fileRef._id,
      [`${marker}.replacement.hash`]: fileRef.hash,
      [`${marker}.replacement.name`]: fileRef.name,
      [`${marker}.replacement.created`]: fileRef.created,
      [`${files}._id`]: { $ne: fileRef._id },
      [`${files}.name`]: { $ne: fileRef.name },
      [`${target.parentPath}.folders.name`]: { $ne: fileRef.name },
    })
  } else {
    filter[`${marker}.replacement`] = { $exists: false }
  }
  /** @type {Record<string, number>} */
  const unset = {}
  for (const field of /** @type {const} */ ([
    'rootDoc_id',
    'mainBibliographyDoc_id',
  ])) {
    if (project[field]?.toHexString() === owner.docId) {
      filter[field] = target.doc._id
      unset[field] = 1
    } else {
      filter[field] = { $ne: target.doc._id }
    }
  }
  return persistRetirement(
    owner,
    filter,
    {
      $pull: { [target.list]: { _id: target.doc._id } },
      ...(fileRef ? { $push: { [files]: fileRef } } : {}),
      $inc: { version: 1 },
      $set: {
        lastUpdated: now,
        lastUpdatedBy: actor,
        [`${marker}.phase`]: 'committed',
        [`${marker}.committedStructureVersion`]: next,
        [`${marker}.deletedAt`]: now,
        ...(verifiedFence.docstoreRev !== undefined && {
          [`${marker}.docstoreRev`]: verifiedFence.docstoreRev,
        }),
      },
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    'commit'
  )
}

/**
 * Record a rollback only while the exact operation is still prepared.
 * Competing commits and uncertain replies are resolved by the stored outcome.
 * @param {RetirementOwner} owner
 * @returns {Promise<RetirementResult>}
 */
export async function abortDocumentRetirement(owner) {
  validateOwner(owner)
  const marker = `documentRetirements.${owner.operationId}`
  return persistRetirement(
    owner,
    {
      _id: new ObjectId(owner.projectId),
      activeDocumentRetirement: owner.operationId,
      [`${marker}.phase`]: 'prepared',
      [`${marker}.docId`]: new ObjectId(owner.docId),
      [`${marker}.editorVersion`]: owner.version,
    },
    { $set: { [`${marker}.phase`]: 'aborted' } },
    'abort'
  )
}

/**
 * Release the structure barrier only after the authoritative terminal effects.
 * @param {RetirementOwner} owner
 * @param {'committed' | 'aborted'} phase
 */
export async function completeDocumentRetirement(owner, phase) {
  validateOwner(owner)
  const marker = `documentRetirements.${owner.operationId}`
  try {
    const result = await Project.updateOne(
      {
        _id: new ObjectId(owner.projectId),
        activeDocumentRetirement: owner.operationId,
        [`${marker}.phase`]: phase,
        [`${marker}.docId`]: new ObjectId(owner.docId),
        [`${marker}.editorVersion`]: owner.version,
      },
      {
        $set: { [`${marker}.completedAt`]: new Date() },
        $unset: { activeDocumentRetirement: 1 },
      },
      { writeConcern: { w: 'majority' } }
    ).exec()
    if (result.acknowledged && result.matchedCount === 1) return
  } catch {
    // A lost reply can leave the terminal record fully finalized.
  }
  const state = await readDocumentRetirement(owner)
  if (state.status !== phase || !state.retirement.completedAt) {
    throw new Error('Document retirement completion is unresolved')
  }
}
