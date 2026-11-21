import { callbackify, promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import redis from '@overleaf/redis-wrapper'
import metrics from '@overleaf/metrics'
import OError from '@overleaf/o-error'
import {
  clearHistoryQueueTimestamp,
  enqueueHistoryPublication,
  removeHistoryQueueEntries,
  resetHistoryQueue,
} from './HistoryPublicationBuffer.js'
import {
  getHistoryPublication,
  parseHistoryUpdate,
} from './HistoryPublicationEnvelope.js'

/**
 * Maximum size taken from the redis queue, to prevent project history
 * consuming unbounded amounts of memory
 */
export const RAW_UPDATE_SIZE_THRESHOLD = 4 * 1024 * 1024

/**
 * Batch size when reading updates from Redis
 */
export const RAW_UPDATES_BATCH_SIZE = 50

/**
 * Maximum length of ops (insertion and deletions) to process in a single
 * iteration
 */
export const MAX_UPDATE_OP_LENGTH = 1024

/**
 * Warn if we exceed this raw update size, the final compressed updates we
 * send could be smaller than this
 */
const WARN_RAW_UPDATE_SIZE = 1024 * 1024

/**
 * Maximum number of new docs to process in a single iteration
 */
export const MAX_NEW_DOC_CONTENT_COUNT = 32

const CACHE_TTL_IN_SECONDS = 3600

const Keys = Settings.redis.project_history.key_schema
const rclient = redis.createClient(Settings.redis.project_history)

/** @param {import('./HistoryPublication.js').BufferRequest} request */
export function bufferHistoryPublication(request) {
  return enqueueHistoryPublication(rclient, Keys, request)
}

async function countUnprocessedUpdates(projectId) {
  const key = Keys.projectHistoryOps({ project_id: projectId })
  const updates = await rclient.llen(key)
  return updates
}

async function* getRawUpdates(projectId) {
  const key = Keys.projectHistoryOps({ project_id: projectId })
  let start = 0
  while (true) {
    const stop = start + RAW_UPDATES_BATCH_SIZE - 1
    const updates = await rclient.lrange(key, start, stop)
    for (const update of updates) {
      yield update
    }
    if (updates.length < RAW_UPDATES_BATCH_SIZE) {
      return
    }
    start += RAW_UPDATES_BATCH_SIZE
  }
}

async function getRawUpdatesBatch(projectId, batchSize) {
  const rawUpdates = []
  let totalRawUpdatesSize = 0
  let hasMore = false
  for await (const rawUpdate of getRawUpdates(projectId)) {
    totalRawUpdatesSize += rawUpdate.length
    if (
      rawUpdates.length > 0 &&
      totalRawUpdatesSize > RAW_UPDATE_SIZE_THRESHOLD
    ) {
      hasMore = true
      break
    }
    rawUpdates.push(rawUpdate)
    if (rawUpdates.length >= batchSize) {
      hasMore = true
      break
    }
  }
  metrics.timing('redis.incoming.bytes', totalRawUpdatesSize, 1)
  if (totalRawUpdatesSize > WARN_RAW_UPDATE_SIZE) {
    const rawUpdateSizes = rawUpdates.map(rawUpdate => rawUpdate.length)
    logger.warn(
      {
        projectId,
        totalRawUpdatesSize,
        rawUpdateSizes,
      },
      'large raw update size'
    )
  }
  return { rawUpdates, hasMore }
}

export function parseDocUpdates(jsonUpdates) {
  return jsonUpdates.map(parseHistoryUpdate)
}

async function getUpdatesInBatches(projectId, batchSize, runner) {
  let moreBatches = true
  while (moreBatches) {
    const redisBatch = await getRawUpdatesBatch(projectId, batchSize)
    if (redisBatch.rawUpdates.length === 0) {
      break
    }
    moreBatches = redisBatch.hasMore

    const rawUpdates = []
    const updates = []
    let publicationBatch = false
    let totalOpLength = 0
    let totalDocContentCount = 0
    for (const rawUpdate of redisBatch.rawUpdates) {
      let update
      try {
        update = parseHistoryUpdate(rawUpdate)
      } catch (error) {
        throw OError.tag(error, 'failed to parse update', {
          projectId,
          update,
        })
      }

      if (getHistoryPublication(update)) {
        if (updates.length > 0) {
          moreBatches = true
          break
        }
        // A publication is committed and acknowledged as one exact entry.
        publicationBatch = true
        moreBatches ||= redisBatch.rawUpdates.length > 1
        rawUpdates.push(rawUpdate)
        updates.push(update)
        break
      }

      totalOpLength += update?.op?.length || 1
      if (update.resyncDocContent) {
        totalDocContentCount += 1
      }

      if (
        updates.length > 0 &&
        (totalOpLength > MAX_UPDATE_OP_LENGTH ||
          totalDocContentCount > MAX_NEW_DOC_CONTENT_COUNT)
      ) {
        moreBatches = true
        break
      }
      if (update.resyncProjectStructureOnly) {
        update._raw = rawUpdate
      }

      rawUpdates.push(rawUpdate)
      updates.push(update)
    }

    await runner(updates)
    if (publicationBatch) {
      await removeAppliedUpdates(projectId, rawUpdates, 'publication')
    } else {
      await deleteAppliedDocUpdates(projectId, rawUpdates)
    }

    if (batchSize === 1) {
      // Special case for single stepping, don't process more batches
      break
    }
  }
}

/**
 * @param {string} projectId
 * @param {ResyncProjectStructureUpdate} update
 * @return {Promise<void>}
 */
async function deleteAppliedDocUpdate(projectId, update) {
  await removeAppliedUpdates(projectId, [update._raw], 'resync')
}

async function deleteAppliedDocUpdates(projectId, updates) {
  await removeAppliedUpdates(projectId, updates, 'legacy')
}

async function removeAppliedUpdates(projectId, updates, kind) {
  for (const update of updates) {
    metrics.summary('redis.projectHistoryOps', update.length, {
      status: 'lrem',
    })
  }
  await removeHistoryQueueEntries(rclient, Keys, projectId, updates, kind)
}

async function destroyDocUpdatesQueue(projectId) {
  await resetHistoryQueue(rclient, Keys, projectId)
}

/**
 * Iterate over keys asynchronously using redis scan (non-blocking)
 *
 * handle all the cluster nodes or single redis server
 */
async function _getKeys(pattern, limit) {
  const nodes = rclient.nodes?.('master') || [rclient]
  const keysByNode = []
  for (const node of nodes) {
    const keys = await _getKeysFromNode(node, pattern, limit)
    keysByNode.push(keys)
  }
  return [].concat(...keysByNode)
}

async function _getKeysFromNode(node, pattern, limit) {
  let cursor = 0 // redis iterator
  const keySet = new Set() // avoid duplicate results
  const batchSize = limit != null ? Math.min(limit, 1000) : 1000

  // scan over all keys looking for pattern
  while (true) {
    const reply = await node.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize)
    const [newCursor, keys] = reply
    cursor = newCursor

    for (const key of keys) {
      keySet.add(key)
    }

    const noResults = cursor === '0' // redis returns string results not numeric
    const limitReached = limit != null && keySet.size >= limit
    if (noResults || limitReached) {
      return Array.from(keySet)
    }

    // avoid hitting redis too hard
    await setTimeout(10)
  }
}

/**
 * Extract ids from keys like DocsWithHistoryOps:57fd0b1f53a8396d22b2c24b
 * or DocsWithHistoryOps:{57fd0b1f53a8396d22b2c24b} (for redis cluster)
 */
function _extractIds(keyList) {
  return keyList.map(key => {
    const m = key.match(/:\{?([0-9a-f]{24})\}?/) // extract object id
    return m[1]
  })
}

async function getProjectIdsWithHistoryOps(limit) {
  const projectKeys = await _getKeys(
    Keys.projectHistoryOps({ project_id: '*' }),
    limit
  )
  const projectIds = _extractIds(projectKeys)
  return projectIds
}

async function getProjectIdsWithHistoryOpsCount() {
  const projectIds = await getProjectIdsWithHistoryOps()
  const queuedProjectsCount = projectIds.length
  metrics.globalGauge('queued-projects', queuedProjectsCount)
  return queuedProjectsCount
}

async function setFirstOpTimestamp(projectId) {
  const key = Keys.projectHistoryFirstOpTimestamp({ project_id: projectId })
  // store current time as an integer (string)
  await rclient.setnx(key, Date.now())
}

async function getFirstOpTimestamp(projectId) {
  const key = Keys.projectHistoryFirstOpTimestamp({ project_id: projectId })
  const result = await rclient.get(key)

  // convert stored time back to a numeric timestamp
  const timestamp = parseInt(result, 10)

  // check for invalid timestamp
  if (isNaN(timestamp)) {
    return null
  }

  // convert numeric timestamp to a date object
  const firstOpTimestamp = new Date(timestamp)

  return firstOpTimestamp
}

async function getFirstOpTimestamps(projectIds) {
  const keys = projectIds.map(projectId =>
    Keys.projectHistoryFirstOpTimestamp({ project_id: projectId })
  )
  const results = await rclient.mget(keys)
  const timestamps = results.map(result => {
    // convert stored time back to a numeric timestamp
    const timestamp = parseInt(result, 10)

    // check for invalid timestamp
    if (isNaN(timestamp)) {
      return null
    }

    // convert numeric timestamp to a date object
    return new Date(timestamp)
  })
  return timestamps
}

async function clearFirstOpTimestamp(projectId) {
  await clearHistoryQueueTimestamp(rclient, Keys, projectId, false)
}

async function getProjectIdsWithFirstOpTimestamps(limit) {
  const projectKeys = await _getKeys(
    Keys.projectHistoryFirstOpTimestamp({ project_id: '*' }),
    limit
  )
  const projectIds = _extractIds(projectKeys)
  return projectIds
}

async function clearDanglingFirstOpTimestamp(projectId) {
  return await clearHistoryQueueTimestamp(rclient, Keys, projectId, true)
}

async function getCachedHistoryId(projectId) {
  const key = Keys.projectHistoryCachedHistoryId({ project_id: projectId })
  const historyId = await rclient.get(key)
  return historyId
}

async function setCachedHistoryId(projectId, historyId) {
  const key = Keys.projectHistoryCachedHistoryId({ project_id: projectId })
  await rclient.setex(key, CACHE_TTL_IN_SECONDS, historyId)
}

async function clearCachedHistoryId(projectId) {
  const key = Keys.projectHistoryCachedHistoryId({ project_id: projectId })
  await rclient.del(key)
}

async function cleanupTestRedis() {
  await redis.cleanupTestRedis(rclient)
}

// EXPORTS

const countUnprocessedUpdatesCb = callbackify(countUnprocessedUpdates)
const getRawUpdatesBatchCb = callbackify(getRawUpdatesBatch)
const deleteAppliedDocUpdatesCb = callbackify(deleteAppliedDocUpdates)
const destroyDocUpdatesQueueCb = callbackify(destroyDocUpdatesQueue)
const getProjectIdsWithHistoryOpsCb = callbackify(getProjectIdsWithHistoryOps)
const getProjectIdsWithHistoryOpsCountCb = callbackify(
  getProjectIdsWithHistoryOpsCount
)
const setFirstOpTimestampCb = callbackify(setFirstOpTimestamp)
const getFirstOpTimestampCb = callbackify(getFirstOpTimestamp)
const getFirstOpTimestampsCb = callbackify(getFirstOpTimestamps)
const clearFirstOpTimestampCb = callbackify(clearFirstOpTimestamp)
const getProjectIdsWithFirstOpTimestampsCb = callbackify(
  getProjectIdsWithFirstOpTimestamps
)
const clearDanglingFirstOpTimestampCb = callbackify(
  clearDanglingFirstOpTimestamp
)
const getCachedHistoryIdCb = callbackify(getCachedHistoryId)
const setCachedHistoryIdCb = callbackify(setCachedHistoryId)
const clearCachedHistoryIdCb = callbackify(clearCachedHistoryId)

const getUpdatesInBatchesCb = function (
  projectId,
  batchSize,
  runner,
  callback
) {
  const runnerPromises = promisify(runner)
  getUpdatesInBatches(projectId, batchSize, runnerPromises)
    .then(result => {
      callback(null, result)
    })
    .catch(err => {
      callback(err)
    })
}

export {
  countUnprocessedUpdatesCb as countUnprocessedUpdates,
  getRawUpdatesBatchCb as getRawUpdatesBatch,
  deleteAppliedDocUpdatesCb as deleteAppliedDocUpdates,
  destroyDocUpdatesQueueCb as destroyDocUpdatesQueue,
  getUpdatesInBatchesCb as getUpdatesInBatches,
  getProjectIdsWithHistoryOpsCb as getProjectIdsWithHistoryOps,
  getProjectIdsWithHistoryOpsCountCb as getProjectIdsWithHistoryOpsCount,
  setFirstOpTimestampCb as setFirstOpTimestamp,
  getFirstOpTimestampCb as getFirstOpTimestamp,
  getFirstOpTimestampsCb as getFirstOpTimestamps,
  clearFirstOpTimestampCb as clearFirstOpTimestamp,
  getProjectIdsWithFirstOpTimestampsCb as getProjectIdsWithFirstOpTimestamps,
  clearDanglingFirstOpTimestampCb as clearDanglingFirstOpTimestamp,
  getCachedHistoryIdCb as getCachedHistoryId,
  setCachedHistoryIdCb as setCachedHistoryId,
  clearCachedHistoryIdCb as clearCachedHistoryId,
}

export const promises = {
  countUnprocessedUpdates,
  getRawUpdatesBatch,
  deleteAppliedDocUpdates,
  deleteAppliedDocUpdate,
  destroyDocUpdatesQueue,
  getUpdatesInBatches,
  getProjectIdsWithHistoryOps,
  getProjectIdsWithHistoryOpsCount,
  setFirstOpTimestamp,
  getFirstOpTimestamp,
  getFirstOpTimestamps,
  clearFirstOpTimestamp,
  getProjectIdsWithFirstOpTimestamps,
  clearDanglingFirstOpTimestamp,
  getCachedHistoryId,
  setCachedHistoryId,
  clearCachedHistoryId,
  cleanupTestRedis,
}
