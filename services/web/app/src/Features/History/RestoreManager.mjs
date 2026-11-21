import Settings from '@overleaf/settings'
import Path from 'node:path'
import fs from 'node:fs'
import FileWriter from '../../infrastructure/FileWriter.mjs'
import Metrics from '../../infrastructure/Metrics.mjs'
import FileSystemImportManager from '../Uploads/FileSystemImportManager.mjs'
import FileTypeManager from '../Uploads/FileTypeManager.mjs'
import EditorController from '../Editor/EditorController.mjs'
import Errors from '../Errors/Errors.js'
import moment from 'moment'
import { callbackifyAll } from '@overleaf/promise-utils'
import ProjectLocator from '../Project/ProjectLocator.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ChatApiHandler from '../Chat/ChatApiHandler.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import logger from '@overleaf/logger'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import ChatManager from '../Chat/ChatManager.mjs'
import OError from '@overleaf/o-error'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import HistoryManager from './HistoryManager.mjs'
import { Snapshot, getDocUpdaterCompatibleRanges } from 'overleaf-editor-core'

async function getCommentThreadIds(projectId) {
  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  const raw = await DocstoreManager.promises.getCommentThreadIds(projectId)
  return new Map(Object.entries(raw).map(([doc, ids]) => [doc, new Set(ids)]))
}

function restoredFileName(basename) {
  const date = moment(new Date()).format('Do MMM YY H:mm:ss')
  const extension = Path.extname(basename)
  return (
    Path.basename(basename, extension) +
    ' (Restored on ' +
    date +
    ')' +
    extension
  )
}

async function restoreCommentThreadState(projectId, comments, userId) {
  const newCommentThreadData = await ChatApiHandler.promises.generateThreadData(
    projectId,
    comments.map(({ op: { t } }) => t)
  )

  // Resolve/reopen threads in chat service to match what is in history
  for (const commentRange of comments) {
    const threadData = newCommentThreadData[commentRange.op.t]
    if (!threadData) {
      // comment thread was deleted
      continue
    }

    if (commentRange.op.resolved && threadData.resolved == null) {
      // The history snapshot stores the comment's resolved property as a boolean,
      // but it does not include information about who resolved the comment or the timestamp.
      // Until this is fixed, we will resolve the thread with the current user and the current timestamp.
      await ChatApiHandler.promises.resolveThread(
        projectId,
        commentRange.op.t,
        userId
      )
      threadData.resolved = true
      threadData.resolved_by_user_id = userId
      threadData.resolved_at = new Date().toISOString()
    } else if (!commentRange.op.resolved && threadData.resolved != null) {
      await ChatApiHandler.promises.reopenThread(projectId, commentRange.op.t)
      delete threadData.resolved
      delete threadData.resolved_by_user_id
      delete threadData.resolved_at
    }
  }

  await ChatManager.promises.injectUserInfoIntoThreads(newCommentThreadData)

  return newCommentThreadData
}

const RestoreManager = {
  async restoreFileFromV2(userId, projectId, version, pathname) {
    const project = await ProjectGetter.promises.getProject(projectId, {
      overleaf: true,
    })
    if (project?.overleaf?.history?.rangesSupportEnabled) {
      return await RestoreManager._recoverSnapshotFile(
        userId,
        projectId,
        project.overleaf.history.id,
        version,
        pathname
      )
    }

    const fsPath = await RestoreManager._writeFileVersionToDisk(
      projectId,
      version,
      pathname
    )
    try {
      const basename = Path.basename(pathname)
      let dirname = Path.dirname(pathname)
      if (dirname === '.') {
        // no directory
        dirname = ''
      }
      const parentFolderId = await RestoreManager._findOrCreateFolder(
        projectId,
        dirname,
        userId
      )
      const addEntityWithName = async name =>
        await FileSystemImportManager.promises.addEntity(
          userId,
          projectId,
          parentFolderId,
          name,
          fsPath,
          false
        )
      return await RestoreManager._addEntityWithUniqueName(
        addEntityWithName,
        basename
      )
    } finally {
      await fs.promises.unlink(fsPath).catch(() => {})
    }
  },

  async _recoverSnapshotFile(userId, projectId, historyId, version, pathname) {
    const { content, timestamp, metadata, changes, comments } =
      await HistoryManager.promises.getFileRecoveryAtVersion(
        projectId,
        version,
        pathname
      )

    const basename = Path.basename(pathname)
    const dirname = Path.dirname(pathname)
    const origin = {
      kind: 'file-restore',
      path: pathname,
      version,
      timestamp: timestamp ?? undefined,
    }
    let mayHaveAttached = false
    const add = async content => {
      const folderId = await RestoreManager._findOrCreateFolder(
        projectId,
        dirname === '.' ? '' : dirname,
        userId
      )
      return await EditorController.promises.addHistoryRecovery(
        projectId,
        folderId,
        basename,
        restoredFileName(basename),
        content,
        origin,
        userId,
        () => {
          // Insertion can succeed before history notification fails.
          // Any comments now belong to a potentially live document.
          mayHaveAttached = true
        }
      )
    }

    if (
      content === null ||
      (metadata && 'provider' in metadata) ||
      !FileTypeManager.isEditable(content, { filename: pathname })
    ) {
      const fsPath =
        content === null
          ? await RestoreManager._writeFileVersionToDisk(
              projectId,
              version,
              pathname
            )
          : await FileWriter.promises.writeContentToDisk(
              historyId + '_restore-manager-editable',
              content
            )
      try {
        return await add({
          type: 'file',
          fsPath,
          linkedFileData: metadata ?? undefined,
        })
      } finally {
        await fs.promises.unlink(fsPath).catch(() => {})
      }
    }

    const lines = content.split('\n')
    const originalIds = new Set(comments.map(comment => comment.op.t))
    if (originalIds.size === 0) {
      return await add({ type: 'doc', lines, ranges: { changes, comments } })
    }

    // A restored copy must never resolve or reopen an existing chat thread.
    const { newThreads } =
      await ChatApiHandler.promises.duplicateCommentThreads(projectId, [
        ...originalIds,
      ])
    const copies = new Map()
    for (const id of originalIds) {
      const copy = newThreads[id]?.duplicateId
      if (copy && !originalIds.has(copy)) copies.set(id, copy)
    }
    try {
      for (const id of originalIds) {
        if (!copies.has(id) && newThreads[id]?.error !== 'not found') {
          throw new OError('failed to duplicate a historical comment thread')
        }
      }
      const recoveredComments = comments.flatMap(comment => {
        const copy = copies.get(comment.op.t)
        return copy
          ? [{ ...comment, id: copy, op: { ...comment.op, t: copy } }]
          : []
      })
      const threadData = await restoreCommentThreadState(
        projectId,
        recoveredComments,
        userId
      )
      if (recoveredComments.some(comment => !threadData[comment.op.t])) {
        throw new OError('a recovered comment thread is unavailable')
      }

      const restored = await add({
        type: 'doc',
        lines,
        ranges: { changes, comments: recoveredComments },
      })
      EditorRealTimeController.emitToRoom(
        projectId,
        'new-comment-threads',
        threadData
      )
      return restored
    } catch (error) {
      // These tree validation errors precede the Mongo insertion.
      const rejectedBeforeInsert =
        error instanceof Errors.TooManyFilesError ||
        error instanceof Errors.InvalidNameError ||
        error instanceof Errors.DuplicateNameError
      if (!mayHaveAttached || rejectedBeforeInsert) {
        for (const id of copies.values()) {
          try {
            await ChatApiHandler.promises.deleteThread(projectId, id)
          } catch (cleanupError) {
            logger.warn(
              { err: cleanupError, projectId },
              'failed to clean up a recovered comment thread'
            )
          }
        }
      }
      throw error
    }
  },

  async revertFile(userId, projectId, version, pathname, options = {}) {
    const threadIds = await getCommentThreadIds(projectId)

    const snapshotRaw = await HistoryManager.promises.getContentAtVersion(
      projectId,
      version
    )
    const snapshot = Snapshot.fromRaw(snapshotRaw)

    const origin = options.origin ?? {
      kind: 'file-restore',
      path: pathname,
      version,
      timestamp: snapshot.getTimestamp()?.toISOString(),
    }

    return await RestoreManager._revertSingleFile(
      userId,
      projectId,
      version,
      pathname,
      threadIds,
      snapshot,
      { origin }
    )
  },

  /**
   *
   * @param {string} userId
   * @param {string} projectId
   * @param {string} version
   * @param {string} pathname
   * @param {Set<string>} threadIds
   * @param {Snapshot} projectSnapshotAtVersion
   * @param {object} options
   */
  async _revertSingleFile(
    userId,
    projectId,
    version,
    pathname,
    threadIds,
    projectSnapshotAtVersion,
    options = {}
  ) {
    const endTimer = Metrics.revertFileDurationSeconds.startTimer()
    const project = await ProjectGetter.promises.getProject(projectId, {
      overleaf: true,
      rootDoc_id: true,
    })
    if (!project?.overleaf?.history?.rangesSupportEnabled) {
      throw new OError('project does not have ranges support', { projectId })
    }
    const historyId = project.overleaf.history.id

    const basename = Path.basename(pathname)
    let dirname = Path.dirname(pathname)
    if (dirname === '.') {
      // root directory
      dirname = '/'
    }
    const parentFolderId = await RestoreManager._findOrCreateFolder(
      projectId,
      dirname,
      userId
    )
    const file = await ProjectLocator.promises
      .findElementByPath({
        project_id: projectId,
        path: pathname,
      })
      .catch(() => null)

    const snapshotFile = projectSnapshotAtVersion.getFile(pathname)
    if (!snapshotFile) {
      throw new OError('file not found in snapshot', {
        projectId,
        version,
        pathname,
      })
    }

    let hadDeletedRootFile = false
    if (file) {
      if (file.type !== 'doc' && file.type !== 'file') {
        throw new OError('unexpected file type', { type: file.type })
      }
      logger.debug(
        { projectId, fileId: file.element._id },
        'deleting entity before reverting it'
      )
      await EditorController.promises.deleteEntity(
        projectId,
        file.element._id,
        file.type,
        options.origin,
        userId
      )

      if (
        file.element._id &&
        project.rootDoc_id &&
        file.element._id.toString() === project.rootDoc_id.toString()
      ) {
        hadDeletedRootFile = true
      }

      threadIds.delete(file.element._id.toString())
    }

    // Look for metadata indicating a linked file.
    const fileMetadata = snapshotFile.getMetadata()
    const isLinkedFile = fileMetadata && 'provider' in fileMetadata

    logger.debug({ fileMetadata }, 'metadata from history')

    if (
      isLinkedFile ||
      !snapshotFile.isEditable() ||
      !FileTypeManager.isEditable(snapshotFile.getContent(), {
        filename: pathname,
      })
    ) {
      const fsPath = await RestoreManager._writeSnapshotFileToDisk(
        historyId,
        snapshotFile
      )
      try {
        const newFile = await EditorController.promises.upsertFile(
          projectId,
          parentFolderId,
          basename,
          fsPath,
          fileMetadata,
          options.origin,
          userId
        )

        endTimer({ type: 'file' })
        return {
          _id: newFile._id,
          type: 'file',
        }
      } finally {
        await fs.promises.unlink(fsPath).catch(() => {})
      }
    }

    const ranges = getDocUpdaterCompatibleRanges(snapshotFile)

    const documentCommentIds = new Set(
      ranges.comments?.map(({ op: { t } }) => t)
    )
    const commentIdsToDuplicate = Array.from(documentCommentIds).filter(id => {
      for (const ids of threadIds.values()) {
        if (ids.has(id)) return true
      }
      return false
    })

    const newRanges = { changes: ranges.changes, comments: [] }

    if (commentIdsToDuplicate.length > 0) {
      const { newThreads: newCommentIds } =
        await ChatApiHandler.promises.duplicateCommentThreads(
          projectId,
          commentIdsToDuplicate
        )

      logger.debug({ mapping: newCommentIds }, 'replacing comment threads')

      for (const comment of ranges.comments ?? []) {
        if (Object.prototype.hasOwnProperty.call(newCommentIds, comment.op.t)) {
          const result = newCommentIds[comment.op.t]
          if (result.error) {
            // We couldn't duplicate the thread, so we need to delete it from
            // the resulting ranges.
            continue
          }
          // We have a new id for this comment thread
          comment.id = result.duplicateId
          comment.op.t = result.duplicateId
        }
        newRanges.comments.push(comment)
      }
    } else {
      newRanges.comments = ranges.comments
    }

    const newCommentThreadData = await restoreCommentThreadState(
      projectId,
      newRanges.comments,
      userId
    )

    // Only keep restored comment ranges that point to a valid thread.
    // The chat service won't have generated thread data for deleted threads.
    newRanges.comments = newRanges.comments.filter(
      comment => newCommentThreadData[comment.op.t] != null
    )

    logger.debug({ newCommentThreadData }, 'emitting new comment threads')
    EditorRealTimeController.emitToRoom(
      projectId,
      'new-comment-threads',
      newCommentThreadData
    )

    const lines = snapshotFile
      .getContent({ filterTrackedDeletes: true })
      .split('\n')

    const { _id } = await EditorController.promises.addDocWithRanges(
      projectId,
      parentFolderId,
      basename,
      lines,
      newRanges,
      options.origin,
      userId
    )

    if (hadDeletedRootFile) {
      await EditorController.promises.setRootDoc(projectId, _id)
    }

    // For revertProject: The next doc that gets reverted will need to duplicate all the threads seen here.
    threadIds.set(
      _id.toString(),
      new Set(newRanges.comments.map(({ op: { t } }) => t))
    )

    endTimer({ type: 'doc' })
    return {
      _id,
      type: 'doc',
    }
  },

  async _findOrCreateFolder(projectId, dirname, userId) {
    const { lastFolder } = await EditorController.promises.mkdirp(
      projectId,
      dirname,
      userId
    )
    return lastFolder?._id
  },

  async _addEntityWithUniqueName(addEntityWithName, basename) {
    try {
      return await addEntityWithName(basename)
    } catch (error) {
      if (error instanceof Errors.DuplicateNameError) {
        // Duplicate name, so try with a prefix
        return await addEntityWithName(restoredFileName(basename))
      } else {
        throw error
      }
    }
  },

  async revertProject(userId, projectId, version) {
    const endTimer = Metrics.revertProjectDurationSeconds.startTimer()
    const project = await ProjectGetter.promises.getProject(projectId, {
      overleaf: true,
    })
    if (!project?.overleaf?.history?.rangesSupportEnabled) {
      throw new OError('project does not have ranges support', { projectId })
    }

    const snapshotRaw = await HistoryManager.promises.getContentAtVersion(
      projectId,
      version
    )
    const snapshot = Snapshot.fromRaw(snapshotRaw)

    const pathsAtPastVersion = snapshot.getFilePathnames()

    const origin = {
      kind: 'project-restore',
      version,
      timestamp: snapshot.getTimestamp()?.toISOString(),
    }
    const threadIds = await getCommentThreadIds(projectId)

    const reverted = []
    for (const pathname of pathsAtPastVersion) {
      const res = await RestoreManager._revertSingleFile(
        userId,
        projectId,
        version,
        pathname,
        threadIds,
        snapshot,
        { origin }
      )
      reverted.push({
        id: res._id,
        type: res.type,
        path: pathname,
      })
    }

    const entitiesAtLiveVersion =
      await ProjectEntityHandler.promises.getAllEntities(projectId)

    const trimLeadingSlash = path => path.replace(/^\//, '')

    const pathsAtLiveVersion = entitiesAtLiveVersion.docs
      .map(doc => doc.path)
      .concat(entitiesAtLiveVersion.files.map(file => file.path))
      .map(trimLeadingSlash)

    // Delete files that were not present at the reverted version
    for (const path of pathsAtLiveVersion) {
      if (!pathsAtPastVersion.includes(path)) {
        await EditorController.promises.deleteEntityWithPath(
          projectId,
          path,
          origin,
          userId
        )
      }
    }

    endTimer()
    return reverted
  },

  async _writeFileVersionToDisk(projectId, version, pathname) {
    const url = `${
      Settings.apis.project_history.url
    }/project/${projectId}/version/${version}/${encodeURIComponent(pathname)}`
    return await FileWriter.promises.writeUrlToDisk(
      projectId + '_restore-manager-version',
      url
    )
  },

  async _writeSnapshotFileToDisk(historyId, file) {
    if (file.isEditable()) {
      return await FileWriter.promises.writeContentToDisk(
        historyId + '_restore-manager-editable',
        file.getContent({ filterTrackedDeletes: true })
      )
    } else {
      const hash = file.getHash()
      const { stream } = await HistoryManager.promises.requestBlob(
        historyId,
        hash
      )
      return await FileWriter.promises.writeStreamToDisk(
        historyId + '_restore-manager-blob',
        stream
      )
    }
  },
}

export default { ...callbackifyAll(RestoreManager), promises: RestoreManager }
