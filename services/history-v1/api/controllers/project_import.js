// @ts-check

'use strict'

const config = require('config')
const { expressify } = require('@overleaf/promise-utils')

const HTTPStatus = require('http-status')

const core = require('overleaf-editor-core')
const Change = core.Change
const Chunk = core.Chunk
const File = core.File
const FileMap = core.FileMap
const Origin = core.Origin
const Snapshot = core.Snapshot
const TextOperation = core.TextOperation

const logger = require('@overleaf/logger')
const OError = require('@overleaf/o-error')

const storage = require('../../storage')
const BatchBlobStore = storage.BatchBlobStore
const BlobStore = storage.BlobStore
const chunkStore = storage.chunkStore
const HashCheckBlobStore = storage.HashCheckBlobStore
const commitChanges = storage.commitChanges
const persistBuffer = storage.persistBuffer
const buildSetContentChange = storage.buildSetContentChange
const InvalidChangeError = storage.InvalidChangeError

const render = require('./render')
const {
  InvalidParamsError,
  InvalidRequestError,
  parseReq,
} = require('@overleaf/validation-tools')
const schemas = require('../schema')
const Rollout = require('../app/rollout')
const redisBackend = require('../../storage/lib/chunk_store/redis')
const mongoChunkStore = require('../../storage/lib/chunk_store/mongo')

const rollout = new Rollout(config)
rollout.report(logger) // display the rollout configuration in the logs

async function importSnapshot(req, res) {
  const { params, body } = parseReq(req, schemas.importSnapshot, {
    fallbackSchema: schemas.importSnapshotFallbackSchema,
  })
  const projectId = params.project_id
  let snapshot

  try {
    snapshot = Snapshot.fromRaw(body)
  } catch (err) {
    logger.warn({ err, projectId }, 'failed to import snapshot')
    return render.unprocessableEntity(res)
  }

  let historyId
  try {
    historyId = await chunkStore.initializeProject(projectId, snapshot)
  } catch (err) {
    if (err instanceof chunkStore.AlreadyInitialized) {
      logger.warn({ err, projectId }, 'already initialized')
      return render.conflict(res)
    } else {
      throw err
    }
  }

  res.status(HTTPStatus.OK).json({ projectId: historyId })
}

// Limits that force us to persist all of the changes.
function getPersistLimits() {
  const farFuture = new Date()
  farFuture.setTime(farFuture.getTime() + 7 * 24 * 3600 * 1000)
  return {
    maxChanges: 0,
    minChangeTimestamp: farFuture,
    maxChangeTimestamp: farFuture,
  }
}

/**
 * @param {InstanceType<typeof BlobStore>} blobStore
 * @param {InstanceType<typeof Change>[]} changes
 */
async function loadChangeFiles(blobStore, changes) {
  const batchBlobStore = new BatchBlobStore(blobStore)
  const blobHashes = new Set()
  for (const change of changes) {
    change.findBlobHashes(blobHashes)
  }

  await batchBlobStore.preload(Array.from(blobHashes))

  /** @type {import('overleaf-editor-core/lib/types').ReadonlyBlobStore & Pick<InstanceType<typeof BlobStore>, 'getBlob'>} */
  const cachedBlobStore = {
    getBlob: hash => batchBlobStore.getBlob(hash),
    getString: hash => blobStore.getString(hash),
    getObject: hash => blobStore.getObject(hash),
  }
  for (const change of changes) {
    await change.loadFiles('lazy', cachedBlobStore)
  }
}

/** @param {unknown} err */
function isInvalidChange(err) {
  return (
    err instanceof TextOperation.UnprocessableError ||
    err instanceof File.NotEditableError ||
    err instanceof FileMap.PathnameError ||
    err instanceof Snapshot.EditMissingFileError ||
    err instanceof InvalidChangeError
  )
}

async function importChanges(req, res, next) {
  const { params, query, body } = parseReq(req, schemas.importChanges, {
    fallbackSchema: schemas.importChangesFallbackSchema,
  })
  const projectId = params.project_id
  const endVersion = query.end_version
  const returnSnapshot = query.return_snapshot ?? 'none'

  let changes

  try {
    changes = body.map(rawChange => Change.mustFromRaw(rawChange))
  } catch (err) {
    logger.warn({ err, projectId }, 'failed to parse changes')
    return render.unprocessableEntity(res)
  }

  const limits = getPersistLimits()

  const blobStore = new BlobStore(projectId)
  const hashCheckBlobStore = new HashCheckBlobStore(blobStore)

  async function buildResultSnapshot(resultChunk) {
    const chunk =
      resultChunk ||
      (await chunkStore.loadLatest(projectId, { persistedOnly: true }))
    const snapshot = chunk.getSnapshot()
    snapshot.applyAll(chunk.getChanges())
    const rawSnapshot = await snapshot.store(hashCheckBlobStore)
    return rawSnapshot
  }

  await loadChangeFiles(blobStore, changes)

  let result
  try {
    const { historyBufferLevel, forcePersistBuffer } =
      rollout.getHistoryBufferLevelOptions(projectId)
    result = await commitChanges(projectId, changes, limits, endVersion, {
      historyBufferLevel,
      forcePersistBuffer,
    })
  } catch (err) {
    if (
      err instanceof Chunk.ConflictingEndVersion ||
      err instanceof chunkStore.ChunkVersionConflictError ||
      isInvalidChange(err)
    ) {
      // If we failed to apply operations, that's probably because they were
      // invalid.
      logger.warn({ err, projectId, endVersion }, 'changes rejected by history')
      return render.unprocessableEntity(res)
    } else if (err instanceof Chunk.NotFoundError) {
      logger.warn({ err, projectId }, 'chunk not found')
      return render.notFound(res)
    } else {
      throw err
    }
  }

  if (returnSnapshot === 'none') {
    res.status(HTTPStatus.CREATED).json({
      resyncNeeded: result.resyncNeeded,
    })
  } else {
    const rawSnapshot = await buildResultSnapshot(result && result.currentChunk)
    res.status(HTTPStatus.CREATED).json(rawSnapshot)
  }
}

function supportsDirectActivation(historyId) {
  const { historyBufferLevel, forcePersistBuffer } =
    rollout.getHistoryBufferLevelOptions(historyId)
  return historyBufferLevel === 0 && forcePersistBuffer === false
}

async function getActivationReadiness(req, res) {
  const {
    params: { project_id: historyId },
  } = parseReq(req, schemas.activationReadiness)
  res.set('Cache-Control', 'no-store')
  if (!supportsDirectActivation(historyId)) {
    return res.json({ ready: false })
  }

  try {
    const { id, startVersion, endVersion } =
      await chunkStore.getLatestChunkMetadata(historyId)
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      !Number.isSafeInteger(startVersion) ||
      startVersion < 0 ||
      !Number.isSafeInteger(endVersion) ||
      endVersion < startVersion ||
      endVersion >= Number.MAX_SAFE_INTEGER
    ) {
      return res.json({ ready: false })
    }
    // The reader includes a Redis tail, but the guarded append checks a
    // persisted end version. A leftover tail from a prior rollout is unready.
    const pending = await chunkStore.getChunkExtension(historyId, endVersion, {
      maxChanges: 1,
    })
    if (pending.length !== 0) return res.json({ ready: false })
  } catch {
    logger.warn({ historyId }, 'history activation metadata is unavailable')
    return res.status(HTTPStatus.SERVICE_UNAVAILABLE).json({ ready: false })
  }
  return res.json({ ready: true, historyId })
}

async function appendActivationChange(req, res) {
  res.set('Cache-Control', 'no-store')
  let parsed
  try {
    parsed = parseReq(req, schemas.appendActivationChange)
  } catch (err) {
    if (
      err instanceof InvalidParamsError ||
      err instanceof InvalidRequestError
    ) {
      return render.badRequest(
        res,
        'Expected one tagged history change and its end version'
      )
    }
    throw err
  }

  const {
    params: { project_id: historyId },
    query: { end_version: endVersion },
    body,
  } = parsed
  const publication = body.historyPublication
  if (publication.historyId !== historyId) {
    return render.badRequest(res, 'Expected a change for this Mongo history')
  }

  let existing
  try {
    existing = await mongoChunkStore.lookupHistoryActivationReceipt(
      historyId,
      publication
    )
  } catch {
    logger.warn(
      { historyId },
      'tagged history receipt is temporarily unavailable'
    )
    return res
      .status(HTTPStatus.SERVICE_UNAVAILABLE)
      .json({ status: 'unavailable' })
  }
  if (existing.status !== 'pending') {
    return res.status(HTTPStatus.OK).json(existing)
  }

  if (!supportsDirectActivation(historyId)) {
    // A buffered writer needs an atomic reservation for the publication identity.
    return res
      .status(HTTPStatus.SERVICE_UNAVAILABLE)
      .json({ status: 'unavailable' })
  }

  let change
  try {
    change = Change.fromStorageRaw(body)
  } catch {
    return render.unprocessableEntity(res, 'Invalid tagged history change')
  }
  try {
    await loadChangeFiles(new BlobStore(historyId), [change])
  } catch (err) {
    if (
      err instanceof core.Blob.NotFoundError ||
      err instanceof storage.BlobNotFoundError
    ) {
      return render.unprocessableEntity(
        res,
        'Tagged history change references a missing blob'
      )
    }
    logger.warn(
      { historyId },
      'tagged history change blob loading is temporarily unavailable'
    )
    return res
      .status(HTTPStatus.SERVICE_UNAVAILABLE)
      .json({ status: 'unavailable' })
  }

  let commitError
  try {
    await commitChanges(
      historyId,
      [change],
      {
        minChangeTimestamp: Infinity,
        maxChangeTimestamp: Infinity,
        maxChanges: 0,
      },
      endVersion,
      { historyBufferLevel: 0 }
    )
  } catch (err) {
    commitError = err
  }

  let receipt
  try {
    receipt = await mongoChunkStore.lookupHistoryActivationReceipt(
      historyId,
      publication
    )
  } catch {
    logger.warn({ historyId }, 'tagged history activation outcome is unknown')
    return res.status(HTTPStatus.ACCEPTED).json({ status: 'pending' })
  }
  if (receipt.status !== 'pending') {
    return res.status(HTTPStatus.OK).json(receipt)
  }
  if (
    commitError instanceof Chunk.ConflictingEndVersion ||
    commitError instanceof chunkStore.ChunkVersionConflictError
  ) {
    return res.status(HTTPStatus.CONFLICT).json({ status: 'version-conflict' })
  }
  if (isInvalidChange(commitError)) {
    return render.unprocessableEntity(res, 'Invalid tagged history change')
  }
  if (commitError instanceof Chunk.NotFoundError) {
    return render.notFound(res)
  }
  if (commitError) {
    logger.warn({ historyId }, 'tagged history activation outcome is unknown')
  }
  return res.status(HTTPStatus.ACCEPTED).json(receipt)
}

async function setContent(req, res) {
  const { params, body } = parseReq(req, schemas.setContent)
  const projectId = params.project_id
  const { pathname, source, userId, timestamp, metadata, trackChanges } = body
  const content = 'content' in body ? body.content : undefined
  const blobHash = 'blobHash' in body ? body.blobHash : undefined
  if (timestamp == null) {
    // The schema requires a timestamp; this narrows the type for the checker.
    return render.unprocessableEntity(res)
  }

  let result
  try {
    result = await buildSetContentChange(projectId, pathname, {
      content,
      blobHash,
      metadata,
      userId,
      timestamp,
      origin: new Origin(source),
      trackChanges,
    })
  } catch (err) {
    if (err instanceof storage.ContentTooLargeError) {
      return render.requestEntityTooLarge(res)
    } else if (err instanceof Chunk.NotFoundError) {
      logger.warn({ err, projectId }, 'chunk not found')
      return render.notFound(res)
    } else if (
      err instanceof storage.BlobNotFoundError ||
      err instanceof TextOperation.UnprocessableError ||
      err instanceof File.NotEditableError ||
      err instanceof FileMap.PathnameError ||
      err instanceof Snapshot.EditMissingFileError ||
      err instanceof InvalidChangeError ||
      (err instanceof OError &&
        err.message.startsWith('StringFileData.trackedChanges out of sync'))
    ) {
      logger.warn({ err, projectId, pathname }, 'set content rejected')
      return render.unprocessableEntity(res)
    } else {
      throw err
    }
  }

  const { change, baseVersion } = result
  res.status(HTTPStatus.OK).json({
    baseVersion,
    change: change ? change.toRaw() : null,
  })
}

async function flushChanges(req, res, next) {
  const { params } = parseReq(req, schemas.flushChanges, {
    fallbackSchema: schemas.flushChangesFallbackSchema,
  })
  const projectId = params.project_id
  // Use the same limits importChanges, since these are passed to persistChanges
  const limits = {
    ...getPersistLimits(),
    autoResync: true,
  }
  try {
    await persistBuffer(projectId, limits)
    res.status(HTTPStatus.OK).end()
  } catch (err) {
    if (err instanceof Chunk.NotFoundError) {
      render.notFound(res)
    } else {
      throw err
    }
  }
}

async function expireProject(req, res, next) {
  const { params } = parseReq(req, schemas.expireProject, {
    fallbackSchema: schemas.expireProjectFallbackSchema,
  })
  const projectId = params.project_id
  await redisBackend.expireProject(projectId)
  res.status(HTTPStatus.OK).end()
}

exports.importSnapshot = expressify(importSnapshot)
exports.importChanges = expressify(importChanges)
exports.appendActivationChange = expressify(appendActivationChange)
exports.getActivationReadiness = expressify(getActivationReadiness)
exports.setContent = expressify(setContent)
exports.flushChanges = expressify(flushChanges)
exports.expireProject = expressify(expireProject)
