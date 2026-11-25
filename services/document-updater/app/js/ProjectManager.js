const RedisManager = require('./RedisManager')
const ProjectHistoryRedisManager = require('./ProjectHistoryRedisManager')
const DocumentManager = require('./DocumentManager')
const HistoryManager = require('./HistoryManager')
const logger = require('@overleaf/logger')
const Metrics = require('./Metrics')
const Errors = require('./Errors')
const { callbackifyAll } = require('@overleaf/promise-utils')
const Settings = require('@overleaf/settings')

const { MAX_PROJECT_DRAIN_ATTEMPTS } = require('./QueuedProjectUpdates')

/**
 * @typedef {{
 *   queue: { getDrainMode: (projectId: string) => Promise<'legacy' | 'guarded'> },
 *   withProjectLock: <T>(projectId: string, operation: (lock: string) => Promise<T>) => Promise<T>,
 *   drainWithLock: (
 *     projectId: string,
 *     lock: string
 *   ) => Promise<'empty' | 'acknowledged' | 'waiting-history' | 'reconcile'>
 * }} ProjectDrain
 */

/** @returns {ProjectDrain | undefined} */
function guardedProjectDrain() {
  if (
    Settings.documentupdater?.enableRetirementQueue !== true ||
    Settings.documentupdater?.enableRetirementWriterSeal !== true
  ) {
    return
  }
  const { guardedProjectQueue: queue } = require('./RealTimeRedisManager')
  const UpdateManager = require('./UpdateManager').promises
  return {
    queue,
    withProjectLock: UpdateManager.withGuardedProjectLock,
    drainWithLock: (projectId, lock) =>
      UpdateManager.processGuardedQueuedBatchUnderLock(projectId, lock, {
        queue,
        ensureHistoryDurable:
          HistoryManager.promises.ensureQueuedHistoryDurable,
      }),
  }
}

/**
 * Capture loaded documents only after the guarded queue is observed empty.
 * The supplied lock wrapper must validate ownership before returning a
 * successful capture. Document methods and the history flush take their own
 * locks and run after this lock has been released.
 *
 * @param {string} projectId
 * @param {ProjectDrain} [drain]
 * @returns {Promise<string[]>}
 */
async function getDocIdsForProjectFlush(
  projectId,
  drain = guardedProjectDrain()
) {
  if (!drain) {
    return await RedisManager.promises.getDocIdsInProject(projectId)
  }

  for (let attempt = 0; attempt < MAX_PROJECT_DRAIN_ATTEMPTS; attempt++) {
    const docIds = await drain.withProjectLock(projectId, async lock => {
      const mode = await drain.queue.getDrainMode(projectId)
      if (mode === 'guarded') {
        const result = await drain.drainWithLock(projectId, lock)
        // Take a fresh lock for the next batch. ACK says nothing about the
        // tail and is insufficient proof of an empty queue.
        if (result === 'acknowledged') return null
        if (result !== 'empty') {
          throw new Errors.ProjectStateChangedError(
            'project updates have not drained'
          )
        }
        return await RedisManager.promises.getDocIdsInProject(projectId)
      }
      if (mode !== 'legacy')
        throw new Error('Unknown project update drain mode')

      const docIds = await RedisManager.promises.getDocIdsInProject(projectId)
      // A producer can persist guarded mode while a legacy capture is running.
      return (await drain.queue.getDrainMode(projectId)) === 'legacy'
        ? docIds
        : null
    })
    if (docIds !== null) return docIds
  }

  throw new Errors.ProjectStateChangedError('project updates have not drained')
}

/** @param {string} projectId @param {ProjectDrain} [drain] */
async function flushProjectWithLocks(projectId, drain) {
  const timer = new Metrics.Timer('projectManager.flushProjectWithLocks')
  const docIds = await getDocIdsForProjectFlush(projectId, drain)

  logger.debug({ projectId, docIds }, 'flushing docs')
  const errors = []
  for (const docId of docIds) {
    try {
      await DocumentManager.promises.flushDocIfLoadedWithLock(projectId, docId)
    } catch (error) {
      if (error instanceof Errors.NotFoundError) {
        logger.warn(
          { err: error, projectId, docId },
          'found deleted doc when flushing'
        )
      } else {
        logger.error({ err: error, projectId, docId }, 'error flushing doc')
        errors.push(error)
      }
    }
  }

  timer.done()
  if (errors.length > 0) {
    throw new Error('Errors flushing docs. See log for details')
  }
}

/**
 * @param {string} projectId
 * @param {object} options
 * @param {ProjectDrain} [drain]
 */
async function flushAndDeleteProjectWithLocks(projectId, options, drain) {
  const timer = new Metrics.Timer(
    'projectManager.flushAndDeleteProjectWithLocks'
  )

  const docIds = await getDocIdsForProjectFlush(projectId, drain)

  logger.debug({ projectId, docIds }, 'deleting docs')
  const errors = []
  for (const docId of docIds) {
    try {
      await DocumentManager.promises.flushAndDeleteDocWithLock(
        projectId,
        docId,
        {}
      )
    } catch (error) {
      logger.error({ err: error, projectId, docId }, 'error deleting doc')
      errors.push(error)
    }
  }

  // When deleting the project here we want to ensure that project
  // history is completely flushed because the project may be
  // deleted in web after this call completes, and so further
  // attempts to flush would fail after that.
  await HistoryManager.promises.flushProjectChanges(projectId, options)
  timer.done()
  if (errors.length > 0) {
    throw new Error('Errors deleting docs. See log for details')
  }
}

async function queueFlushAndDeleteProject(projectId) {
  await RedisManager.promises.queueFlushAndDeleteProject(projectId)
  Metrics.inc('queued-delete')
}

async function getProjectDocsTimestamps(projectId, callback) {
  const docIds = await RedisManager.promises.getDocIdsInProject(projectId)
  if (docIds.length === 0) {
    return []
  }

  const timestamps = await RedisManager.promises.getDocTimestamps(docIds)
  return timestamps
}

async function getProjectDocsAndFlushIfOld(projectId, projectStateHash) {
  const timer = new Metrics.Timer('projectManager.getProjectDocsAndFlushIfOld')

  const projectStateChanged =
    await RedisManager.promises.checkOrSetProjectState(
      projectId,
      projectStateHash
    )

  // we can't return docs if project structure has changed
  if (projectStateChanged) {
    timer.done()
    throw new Errors.ProjectStateChangedError('project state changed')
  }

  // project structure hasn't changed, return doc content from redis
  const docs = []
  const docIds = await RedisManager.promises.getDocIdsInProject(projectId)
  for (const docId of docIds) {
    const { lines, version } =
      await DocumentManager.promises.getDocAndFlushIfOldWithLock(
        projectId,
        docId
      )
    docs.push({ _id: docId, lines, v: version })
  }

  timer.done()
  return docs
}

async function getProjectRanges(projectId) {
  const docIds = await RedisManager.promises.getDocIdsInProject(projectId)
  const docs = []
  for (const docId of docIds) {
    const ranges = await RedisManager.promises.getDocRanges(docId)
    docs.push({ id: docId, ranges })
  }
  return docs
}

async function clearProjectState(projectId) {
  await RedisManager.promises.clearProjectState(projectId)
}

async function updateProjectWithLocks(
  projectId,
  projectHistoryId,
  userId,
  updates,
  projectVersion,
  source
) {
  const timer = new Metrics.Timer('projectManager.updateProject')

  let projectSubversion = 0 // project versions can have multiple operations
  let projectOpsLength = 0

  for (const update of updates) {
    update.version = `${projectVersion}.${projectSubversion++}`
    switch (update.type) {
      case 'add-doc':
        projectOpsLength =
          await ProjectHistoryRedisManager.promises.queueAddEntity(
            projectId,
            projectHistoryId,
            'doc',
            update.id,
            userId,
            update,
            source
          )
        break
      case 'rename-doc':
        if (!update.newPathname) {
          // an empty newPathname signifies a delete, so there is no need to
          // update the pathname in redis
          projectOpsLength =
            await ProjectHistoryRedisManager.promises.queueRenameEntity(
              projectId,
              projectHistoryId,
              'doc',
              update.id,
              userId,
              update,
              source
            )
        } else {
          // rename the doc in redis before queuing the update
          await DocumentManager.promises.renameDocWithLock(
            projectId,
            update.id,
            userId,
            update,
            projectHistoryId
          )
          projectOpsLength =
            await ProjectHistoryRedisManager.promises.queueRenameEntity(
              projectId,
              projectHistoryId,
              'doc',
              update.id,
              userId,
              update,
              source
            )
        }
        break
      case 'add-file':
        projectOpsLength =
          await ProjectHistoryRedisManager.promises.queueAddEntity(
            projectId,
            projectHistoryId,
            'file',
            update.id,
            userId,
            update,
            source
          )
        break
      case 'rename-file':
        projectOpsLength =
          await ProjectHistoryRedisManager.promises.queueRenameEntity(
            projectId,
            projectHistoryId,
            'file',
            update.id,
            userId,
            update,
            source
          )
        break
      default:
        throw new Error(`Unknown update type: ${update.type}`)
    }
  }

  if (
    HistoryManager.shouldFlushHistoryOps(
      projectId,
      projectOpsLength,
      updates.length
    )
  ) {
    HistoryManager.flushProjectChangesAsync(projectId)
  }

  timer.done()
}

const ProjectManager = {
  flushProjectWithLocks,
  flushAndDeleteProjectWithLocks,
  queueFlushAndDeleteProject,
  getProjectDocsTimestamps,
  getProjectDocsAndFlushIfOld,
  getProjectRanges,
  clearProjectState,
  updateProjectWithLocks,
}

module.exports = {
  ...callbackifyAll(ProjectManager),
  promises: ProjectManager,
}
