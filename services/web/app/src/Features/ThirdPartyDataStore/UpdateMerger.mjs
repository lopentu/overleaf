import { callbackify } from 'node:util'
import _ from 'lodash'
import fsPromises from 'node:fs/promises'
import fs from 'node:fs'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import { blobHashFromString } from 'overleaf-editor-core/lib/blob_utils.js'
import EditorController from '../Editor/EditorController.mjs'
import FileTypeManager from '../Uploads/FileTypeManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { pipeline } from 'node:stream/promises'

async function mergeUpdate(userId, projectId, path, updateRequest, source) {
  const fsPath = await writeUpdateToDisk(projectId, updateRequest)

  try {
    // note: important to await here so file reading finishes before cleaning up below
    return await _mergeUpdate(userId, projectId, path, fsPath, source)
  } finally {
    // note: not awaited or thrown
    fsPromises.unlink(fsPath).catch(err => {
      logger.err({ err, projectId, fsPath }, 'error deleting file')
    })
  }
}

async function writeUpdateToDisk(projectId, updateStream) {
  const fsPath = `${
    Settings.path.dumpFolder
  }/${projectId}_${crypto.randomUUID()}_update-merger`
  const writeStream = fs.createWriteStream(fsPath)
  try {
    await pipeline(updateStream, writeStream)
  } catch (err) {
    try {
      await fsPromises.unlink(fsPath)
    } catch (err) {
      logger.error({ err, projectId, fsPath }, 'error deleting file')
    }
    throw err
  }
  return fsPath
}

async function _findExistingFileType(projectId, path) {
  const { docs, files } =
    await ProjectEntityHandler.promises.getAllEntities(projectId)
  if (_.some(docs, d => d.path === path)) {
    return 'doc'
  }
  if (_.some(files, f => f.path === path)) {
    return 'file'
  }
  return null
}

async function _determineFileType(path, fsPath, existingFileType) {
  // determine whether the update should create a doc or binary file
  const { binary, encoding } = await FileTypeManager.promises.getType(
    path,
    fsPath,
    existingFileType
  )

  // If we receive a non-utf8 encoding, we won't be able to keep things in
  // sync, so we'll treat non-utf8 files as binary
  const isBinary = binary || encoding !== 'utf-8'

  // Existing | Update    | Resulting file type
  // ---------|-----------|--------------------
  // file     | isBinary  | file
  // file     | !isBinary | file
  // doc      | isBinary  | file
  // doc      | !isBinary | doc
  // null     | isBinary  | file
  // null     | !isBinary | doc

  // if a binary file already exists, always keep it as a binary file
  // even if the update looks like a text file
  if (existingFileType === 'file') {
    return 'file'
  } else {
    return isBinary ? 'file' : 'doc'
  }
}

/** @typedef {{docId: string, version: number}} ExpectedDocument */
/** @typedef {{fileId: string, rev: number | undefined}} ExpectedFile */
/** @typedef {ExpectedDocument | ExpectedFile | null} ExpectedEntity */

/**
 * @param {string} userId
 * @param {string} projectId
 * @param {string} path
 * @param {string} fsPath
 * @param {string} source
 * @param {ExpectedEntity} [expectedEntity] null requires an unused path
 */
async function _mergeUpdate(
  userId,
  projectId,
  path,
  fsPath,
  source,
  expectedEntity
) {
  const expectedDocument = expectedEntity && 'docId' in expectedEntity
  let existingFileType
  if (expectedEntity === undefined) {
    existingFileType = await _findExistingFileType(projectId, path)
  } else if (expectedEntity === null) {
    existingFileType = null
  } else {
    existingFileType = expectedDocument ? 'doc' : 'file'
  }
  const fileType = await _determineFileType(path, fsPath, existingFileType)

  if (fileType === 'file') {
    if (expectedDocument) {
      throw new OError(
        'GitHub sync cannot replace a guarded editable document with a binary file.',
        {
          status: 409,
        }
      )
    }
    const { file, folder } = await _processFile(
      projectId,
      fsPath,
      path,
      source,
      userId,
      expectedEntity
    )
    return {
      projectId,
      entityType: 'file',
      entityId: file._id,
      rev: file.rev,
      folderId: folder._id,
    }
  } else if (fileType === 'doc') {
    const { doc, folder, contentHash } = await _processDoc(
      projectId,
      userId,
      fsPath,
      path,
      source,
      expectedEntity
    )
    return {
      projectId,
      entityType: 'doc',
      entityId: doc._id,
      rev: doc.rev,
      folderId: folder._id,
      ...(contentHash === undefined ? {} : { contentHash }),
    }
  } else {
    throw new Error('unrecognized file')
  }
}

/**
 * @param {string} userId
 * @param {string} projectId
 * @param {string} path
 * @param {string} source
 * @param {NonNullable<ExpectedEntity>} [expectedEntity]
 */
async function deleteUpdate(userId, projectId, path, source, expectedEntity) {
  try {
    return await EditorController.promises.deleteEntityWithPath(
      projectId,
      path,
      source,
      userId,
      ...(expectedEntity !== undefined ? [expectedEntity] : [])
    )
  } catch (err) {
    if (expectedEntity !== undefined) throw err
    logger.warn(
      { err, userId, projectId, path, source },
      'failed to delete entity'
    )
  }
}

async function _processDoc(
  projectId,
  userId,
  fsPath,
  path,
  source,
  expectedDocument
) {
  const docLines = await _readFileIntoTextArray(fsPath)
  logger.debug({ docLines }, 'processing doc update from tpds')
  const result = await EditorController.promises.upsertDocWithPath(
    projectId,
    path,
    docLines,
    source,
    userId,
    ...(expectedDocument !== undefined ? [expectedDocument] : [])
  )
  if (expectedDocument === undefined) return result
  return { ...result, contentHash: blobHashFromString(docLines.join('\n')) }
}

async function _processFile(
  projectId,
  fsPath,
  path,
  source,
  userId,
  expectedFile
) {
  const { file, folder } = await EditorController.promises.upsertFileWithPath(
    projectId,
    path,
    fsPath,
    null,
    source,
    userId,
    ...(expectedFile !== undefined ? [expectedFile] : [])
  )
  return { file, folder }
}

async function _readFileIntoTextArray(path) {
  let content = await fsPromises.readFile(path, 'utf8')
  if (content == null) {
    content = ''
  }
  const lines = content.split(/\r\n|\n|\r/)
  return lines
}

async function createFolder(projectId, path, userId) {
  const { lastFolder: folder } = await EditorController.promises.mkdirp(
    projectId,
    path,
    userId
  )
  return folder
}

export default {
  mergeUpdate: callbackify(mergeUpdate),
  _mergeUpdate: callbackify(_mergeUpdate),
  deleteUpdate: callbackify(deleteUpdate),
  createFolder: callbackify(createFolder),
  promises: {
    mergeUpdate,
    _mergeUpdate, // applies a previously staged update
    writeUpdateToDisk,
    deleteUpdate,
    createFolder,
  },
}
