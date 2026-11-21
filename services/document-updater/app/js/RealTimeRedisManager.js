/* eslint-disable
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const Settings = require('@overleaf/settings')
const { promisifyAll } = require('@overleaf/promise-utils')
const { callbackify } = require('node:util')
const ProjectUpdateQueue = require('@overleaf/redis-wrapper/ProjectUpdateQueue.js')
const rclient = require('@overleaf/redis-wrapper').createClient(
  Settings.redis.documentupdater
)
const pubsubClient = require('@overleaf/redis-wrapper').createClient(
  Settings.redis.pubsub
)
const Keys = Settings.redis.documentupdater.key_schema
const projectUpdates = new ProjectUpdateQueue(
  rclient,
  Keys.pendingProjectUpdates
)
const logger = require('@overleaf/logger')
const os = require('node:os')
const crypto = require('node:crypto')
const metrics = require('./Metrics')
const { ProjectUpdateQueueGuardedError } = require('./Errors')

const HOST = os.hostname()
const RND = crypto.randomBytes(4).toString('hex') // generate a random key for this process
let COUNT = 0

// Refusal is an error because synchronous callers must not treat a protected
// queue as drained. The Lua check and destructive pop run on one project slot.
const getPendingUpdatesFromQueue = callbackify(async projectId => {
  const result = await projectUpdates.popLegacyBatch(projectId)
  if (result.status === 'guarded') {
    throw new ProjectUpdateQueueGuardedError(
      'legacy drain refused for guarded project',
      { projectId }
    )
  }
  metrics.histogram(
    'redis.pendingUpdates.llen',
    result.length,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 50, 75, 100],
    { path: 'project' }
  )
  for (const jsonUpdate of result.entries) {
    metrics.summary('redis.pendingUpdates', jsonUpdate.length, {
      status: 'pop',
      path: 'project',
    })
  }
  return result.entries.map(entry => JSON.parse(entry))
})

const RealTimeRedisManager = {
  /**
   * Drain a batch of updates from a project's per-project queue. Each update
   * on the per-project queue carries its own `doc` id so the caller knows
   * which doc to apply it to.
   *
   * @param {string} projectId
   * @param {function(Error, Array<Object>=): void} callback
   */
  getPendingProjectUpdates(projectId, callback) {
    getPendingUpdatesFromQueue(projectId, callback)
  },

  /**
   * Get the length of a project's per-project queue.
   *
   * @param {string} projectId
   * @param {function(Error, number=): void} callback
   */
  getProjectUpdatesLength(projectId, callback) {
    rclient.llen(
      Keys.pendingProjectUpdates({ project_id: projectId }),
      callback
    )
  },

  /**
   * Publish an applied op or an error for a doc back to real-time.
   *
   * The message is published on the project's editor-events channel, which
   * real-time subscribes to for the lifetime of every connected project. It is
   * broadcast to the project room in real-time; clients filter by doc id.
   *
   * @param {Object} data
   * @param {string} data.project_id - routes the message to the project's
   *        editor-events channel and to the project room in real-time
   * @param {string} data.doc_id - identifies the doc for clients
   * @param {Object} [data.op] - the applied op
   * @param {string} [data.error] - the error message when applying failed
   */
  sendData(data) {
    // create a unique message id using a counter
    const messageId = `doc:${HOST}:${RND}-${COUNT++}`
    data._id = messageId

    // the message name routes the message to the applied-ops handling in
    // real-time's editor-events processing
    data.message = data.op ? 'otUpdateApplied' : 'otUpdateError'

    const blob = JSON.stringify(data)
    metrics.summary('redis.publish.applied-ops', blob.length, {
      path: 'editor-events',
    })

    // publish on a per-project channel when configured (needs realtime to be
    // configured for this too), otherwise on the base editor-events channel.
    if (Settings.publishOnIndividualChannels) {
      return pubsubClient.publish(`editor-events:${data.project_id}`, blob)
    } else {
      return pubsubClient.publish('editor-events', blob)
    }
  },
}

module.exports = RealTimeRedisManager
module.exports.promises = promisifyAll(RealTimeRedisManager, {
  without: ['sendData'],
})
module.exports.guardedProjectQueue = projectUpdates
