// @ts-check

/* eslint-disable
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS202: Simplify dynamic range loops
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const redis = require('@overleaf/redis-wrapper')
const ProjectDispatchHandoff = require('@overleaf/redis-wrapper/ProjectDispatchHandoff.js')
const ProjectUpdateQueue = require('@overleaf/redis-wrapper/ProjectUpdateQueue.js')
const { randomUUID } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const Errors = require('./Errors')
const _ = require('lodash')

/** @typedef {(projectId: string, callback: (error: Error | null) => void) => void} ProcessLegacyUpdates */
// UpdateManager creates the legacy callback export with callbackifyAll.
const UpdateManager =
  /** @type {typeof import('./UpdateManager') & {processOutstandingUpdatesWithLock: ProcessLegacyUpdates}} */ (
    require('./UpdateManager')
  )
const Metrics = require('./Metrics')
const RateLimitManager = require('./RateLimitManager')

/** @typedef {import('./QueuedProjectUpdates').Dependencies['ensureHistoryDurable']} EnsureHistoryDurable */
/** @typedef {import('@overleaf/redis-wrapper/ProjectDispatchHandoff.js').DispatchMarker} DispatchMarker */

const reclaimIdleMs = 30_000
const waitForMarkerMs = 1_000

/**
 * @param {ProjectDispatchHandoff} handoff
 * @param {DispatchMarker[]} markers
 * @param {ProjectUpdateQueue} queue
 * @param {EnsureHistoryDurable} ensureHistoryDurable
 */
async function processDispatchMarkers(
  handoff,
  markers,
  queue,
  ensureHistoryDurable
) {
  for (const marker of markers) {
    if (Settings.shuttingDown) return
    const { projectId, shard, markerId } = marker
    try {
      const status = await handoff.admit(marker)
      // A receipt can expire while its admitted update is still queued.
      if (
        status !== 'admitted' &&
        status !== 'document_fenced' &&
        status !== 'missing'
      ) {
        logger.error(
          { projectId, shard, markerId, status },
          'could not reconcile dispatch ticket'
        )
        continue
      }
      const result =
        await UpdateManager.promises.processGuardedQueuedBatchWithLock(
          projectId,
          { queue, ensureHistoryDurable }
        )
      if (result === 'empty' || result === 'acknowledged') {
        await handoff.acknowledgeTerminal(marker)
      }
    } catch {
      // Redis and apply errors can include serialized edits. Keep the marker
      // pending and log just the identifiers needed to locate it.
      logger.error(
        { projectId, shard, markerId },
        'guarded dispatch marker remains pending after an error'
      )
    }
  }
}

/**
 * @param {number} shard
 * @param {number} shardCount
 * @param {ProjectUpdateQueue} queue
 * @param {EnsureHistoryDurable} ensureHistoryDurable
 */
async function runGuardedDispatcher(
  shard,
  shardCount,
  queue,
  ensureHistoryDurable
) {
  // Keep blocking stream reads off the connection used for project queues.
  const client = redis.createClient(Settings.redis.documentupdater)
  const handoff = new ProjectDispatchHandoff(client, queue, shardCount)
  const consumer = randomUUID()
  let cursor = '0-0'
  let open = false
  try {
    while (!Settings.shuttingDown) {
      try {
        if (!open) {
          await handoff.openShard(shard)
          open = true
        }
        const reclaimed = await handoff
          .reclaim(shard, consumer, reclaimIdleMs, cursor)
          .catch(() => {
            logger.error(
              { shard },
              'could not reclaim pending dispatch markers'
            )
          })
        if (reclaimed) {
          cursor = reclaimed.cursor
          await processDispatchMarkers(
            handoff,
            reclaimed.markers,
            queue,
            ensureHistoryDurable
          )
        }
        if (Settings.shuttingDown) break
        const timer = new Metrics.Timer('worker.waiting')
        const markers = await handoff
          .read(
            shard,
            consumer,
            reclaimed?.markers.length ? 0 : waitForMarkerMs
          )
          .finally(() => timer.done())
        await processDispatchMarkers(
          handoff,
          markers,
          queue,
          ensureHistoryDurable
        )
      } catch {
        open = false
        logger.error({ shard }, 'error reading guarded dispatch stream')
        await delay(waitForMarkerMs)
      }
    }
  } finally {
    client.disconnect()
  }
}

const DispatchManager = {
  createDispatcher(RateLimiter, queueShardNumber) {
    let pendingListKey
    if (queueShardNumber === 0) {
      pendingListKey = 'pending-updates-list'
    } else {
      pendingListKey = `pending-updates-list-${queueShardNumber}`
    }

    const client = redis.createClient(Settings.redis.documentupdater)
    const worker = {
      client,
      _waitForUpdateThenDispatchWorker(callback) {
        if (callback == null) {
          callback = function () {}
        }
        const timer = new Metrics.Timer('worker.waiting')
        return worker.client.blpop(pendingListKey, 0, function (error, result) {
          logger.debug(`getting ${queueShardNumber}`, error, result)
          timer.done()
          if (error != null) {
            return callback(error)
          }
          if (result == null) {
            return callback()
          }
          const [listName, projectId] = Array.from(result)
          // Dispatch this in the background
          const backgroundTask = cb =>
            UpdateManager.processOutstandingUpdatesWithLock(
              projectId,
              function (error) {
                // log everything except OpRangeNotAvailable errors, these are normal
                if (error != null) {
                  // downgrade OpRangeNotAvailable and "Delete component" errors so they are not sent to sentry
                  const logAsDebug =
                    error instanceof Errors.OpRangeNotAvailableError ||
                    error instanceof Errors.DeleteMismatchError
                  if (logAsDebug) {
                    logger.debug(
                      { err: error, projectId },
                      'error processing update'
                    )
                  } else {
                    logger.error(
                      { err: error, projectId },
                      'error processing update'
                    )
                  }
                }
                return cb()
              }
            )
          return RateLimiter.run(backgroundTask, callback)
        })
      },

      run() {
        if (Settings.shuttingDown) {
          return
        }
        return worker._waitForUpdateThenDispatchWorker(error => {
          if (error != null) {
            logger.error({ err: error }, 'Error in worker process')
            throw error
          } else {
            return worker.run()
          }
        })
      },
    }

    return worker
  },

  /**
   * @param {number} number
   * @param {EnsureHistoryDurable} [ensureHistoryDurable]
   */
  createAndStartDispatchers(number, ensureHistoryDurable) {
    if (Settings.documentupdater?.enableRetirementQueue === true) {
      if (typeof ensureHistoryDurable !== 'function') {
        throw new Error('Guarded dispatch requires durable history proof')
      }
      if (Settings.documentupdater.enableRetirementWriterSeal !== true) {
        throw new Error('Guarded dispatch requires the retirement writer seal')
      }
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error('Invalid guarded dispatch shard count')
      }
      const config = Settings.redis.documentupdater
      const commands = redis.createClient(config)
      const queue = new ProjectUpdateQueue(
        commands,
        config.key_schema.pendingProjectUpdates
      )
      return Promise.all(
        _.times(number, shard =>
          runGuardedDispatcher(shard, number, queue, ensureHistoryDurable)
        )
      ).finally(() => commands.disconnect())
    }

    const RateLimiter = new RateLimitManager(number)
    _.times(number, function (shardNumber) {
      return DispatchManager.createDispatcher(RateLimiter, shardNumber).run()
    })
  },
}

module.exports = DispatchManager
