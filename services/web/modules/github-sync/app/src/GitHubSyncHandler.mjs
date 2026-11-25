// @ts-check
import Path from 'path'
import fs from 'fs'
import { pipeline } from 'node:stream/promises'
import crypto from 'crypto'
import pLimit from 'p-limit'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectUploadManager from '../../../../app/src/Features/Uploads/ProjectUploadManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import api from './GitHubApiClient.mjs'
import SyncStateManager from './SyncStateManager.mjs'
import HistoryManager from './HistoryManager.mjs'
import TokenManager from './TokenManager.mjs'
import {
  GitHubExportIncompleteError,
  GitNotLinkedError,
  InvalidTokenError,
  NotFoundError,
  PermissionDeniedError,
} from './GitSyncErrors.mjs'

const syncLockManager = LockManager.withTimeout(300)

/** @param {string} userId */
async function getGitConnState(userId) {
  try {
    const token = await TokenManager.getUserToken(userId)
    await api.getUser(token)
    return true
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      logger.debug({ err, userId }, 'token invalid, treating as not connected')
      return false
    }
    throw OError.tag(err, 'failed to validate token', { userId })
  }
}

/**
 * @param {string} userId
 * @param {string} projectId
 */
async function getProjectState(userId, projectId) {
  const projection = {
    _id: 0,
    mergeStatus: 1,
    repoFullName: 1,
    unmergedBranchName: 1,
  }
  const projectState = await SyncStateManager.getProjectState(
    projectId,
    projection
  )
  if (!projectState) {
    /** @type {{ mergeStatus: 'need-export', ownerEmail?: string }} */
    const state = { mergeStatus: 'need-export' }
    try {
      const { owner_ref } = await ProjectGetter.promises.getProject(projectId, {
        owner_ref: 1,
      })
      if (owner_ref.toString() !== userId) {
        state.ownerEmail = await UserGetter.promises.getUserEmail(owner_ref)
      }
    } catch (err) {
      state.ownerEmail = 'nobody@nowhere'
      logger.error({ err }, 'failed get user email')
    }
    return state
  }
  let canPush
  try {
    const token = await TokenManager.getUserToken(userId)
    canPush = await api.getPushPermission(token, projectState.repoFullName)
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof PermissionDeniedError)
      canPush = false
    else throw err
  }
  if (!canPush) {
    /** @type {{ mergeStatus: 'need-permission', ownerEmail?: string }} */
    const state = { mergeStatus: 'need-permission' }
    // send owner's email to collaborator
    // send nothing to the owner
    try {
      const { owner_ref } = await ProjectGetter.promises.getProject(projectId, {
        owner_ref: 1,
      })
      if (owner_ref.toString() !== userId) {
        state.ownerEmail = await UserGetter.promises.getUserEmail(owner_ref)
      }
    } catch (err) {
      logger.error({ err, userId }, 'failed get user email')
      state.ownerEmail = 'nobody@nowhere'
    }
    return { ...projectState, ...state }
  }
  return projectState
}

/**
 * @param {string} userId
 * @param {string} projectId
 */
async function unlinkRepo(userId, projectId) {
  const { owner_ref } = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  })
  if (owner_ref.toString() !== userId) {
    let ownerEmail
    try {
      ownerEmail = await UserGetter.promises.getUserEmail(owner_ref)
    } catch (err) {
      logger.error({ err, userId }, 'failed get user email')
      ownerEmail = 'nobody@nowhere'
    }
    return ownerEmail
  }
  await SyncStateManager.removeProjectState(projectId)
  return null
}

/** @param {string} userId */
async function listUserRepos(userId) {
  const token = await TokenManager.getUserToken(userId)
  return await api.listUserRepos(token)
}

/** @param {string} userId */
async function getUserAndOrgs(userId) {
  const token = await TokenManager.getUserToken(userId)
  return await api.getUserAndOrgs(token)
}

/**
 * @param {string} userId
 * @param {string} projectId
 */
async function getMergeOverview(userId, projectId) {
  const projectSyncState = await SyncStateManager.getProjectState(projectId)
  if (!projectSyncState) throw new GitNotLinkedError(projectId)
  const {
    repoFullName,
    defaultBranchName,
    lastSyncCommit,
    lastSyncVersion,
    mergeStatus,
  } = projectSyncState

  if (mergeStatus === 'conflict') return null

  const token = await TokenManager.getUserToken(userId)
  const currentVersion = await HistoryManager.latestVersion(
    projectId.toString()
  )
  const isProjectUpdated = currentVersion !== lastSyncVersion
  try {
    const commitsAndStatus = await api.listNewCommitsWithStatus(
      token,
      repoFullName,
      defaultBranchName,
      lastSyncCommit
    )
    if (commitsAndStatus.diverged) {
      await SyncStateManager.updateProjectState(projectId, {
        mergeStatus: 'diverged',
      })
    }
    return { ...commitsAndStatus, isProjectUpdated }
  } catch (err) {
    if (err instanceof NotFoundError) {
      // what is the reason of NotFoundError? is it a missing commit or not?
      let canPush
      try {
        canPush = await api.getPushPermission(token, repoFullName)
      } catch (e) {
        logger.error({ error: e }, 'failed to check push permission')
        canPush = false
      }
      if (!canPush) throw err
      await SyncStateManager.updateProjectState(projectId, {
        mergeStatus: 'diverged',
      })
      return { commits: [], diverged: true, isProjectUpdated }
    } else {
      throw err
    }
  }
}

/**
 * @param {string} userId
 * @param {string} projectName
 * @param {string} repoFullName
 * @param {string} defaultBranchName
 */
async function importRepo(
  userId,
  projectName,
  repoFullName,
  defaultBranchName
) {
  const token = await TokenManager.getUserToken(userId)
  const defaultBranchHead = await api.getBranchHead(
    token,
    repoFullName,
    defaultBranchName
  )
  const fsPath = Path.join(
    Settings.path.dumpFolder,
    `github_import_${crypto.randomUUID()}`
  )

  let project_id

  try {
    const stream = await api.getRepoZipball(
      token,
      repoFullName,
      defaultBranchHead
    )
    await pipeline(stream, fs.createWriteStream(fsPath))

    const { project } =
      await ProjectUploadManager.promises.createProjectFromZipArchiveWithName(
        userId,
        projectName,
        fsPath
      )

    project_id = project?._id
  } catch (err) {
    throw OError.tag(err, 'failed importing git repo', {
      userId,
      projectName,
      repoFullName,
      defaultBranchName,
      fsPath,
    })
  } finally {
    fs.promises.rm(fsPath, { force: true }).catch(() => {})
  }

  try {
    const projectVersion = await HistoryManager.latestVersion(
      project_id.toString()
    )
    await SyncStateManager.createProjectState(project_id, {
      repoFullName,
      mergeStatus: 'clean',
      lastSyncCommit: defaultBranchHead,
      defaultBranchName,
      lastSyncVersion: projectVersion,
    })
  } catch (err) {
    // don't throw up
    logger.error(
      { err, userId, projectId: project_id.toString(), repoFullName },
      'Failed to create state of imported repo'
    )
  }

  return project_id
}

/** @param {string} projectId */
async function ensureProjectIsNotLinked(projectId) {
  if (await SyncStateManager.getProjectState(projectId)) {
    throw new OError('Project is already linked to Git server', { projectId })
  }
}

/**
 * @param {string} userId
 * @param {string} projectId
 * @param {{ name: string, description?: string, isPublic?: boolean, org?: string }} repoOptions
 */
async function exportProject(userId, projectId, repoOptions) {
  if (typeof repoOptions?.name !== 'string' || !repoOptions.name) {
    throw new OError('A GitHub repository name is required', { status: 400 })
  }
  return syncLockManager.promises.runWithLock(
    'gitSync',
    projectId,
    async () => {
      const project = await ProjectGetter.promises.getProject(projectId, {
        owner_ref: 1,
      })
      const ownerId = project?.owner_ref
      if (!ownerId || ownerId.toString() !== userId) {
        throw new PermissionDeniedError(
          'Only the project owner can export to GitHub',
          { status: 403 }
        )
      }
      await ensureProjectIsNotLinked(projectId)

      const token = await TokenManager.getUserToken(userId)
      await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)

      /** @type {unknown} */
      const currentVersion = await HistoryManager.latestVersion(projectId)
      if (
        typeof currentVersion !== 'number' ||
        !Number.isSafeInteger(currentVersion) ||
        currentVersion < 0
      ) {
        throw new OError('Invalid project history version', { projectId })
      }

      /** @type {{ paths?: unknown } | null | undefined} */
      const snapshot = await HistoryManager.getPathsAtVersion(
        projectId,
        currentVersion
      )
      const paths = snapshot?.paths
      if (
        !Array.isArray(paths) ||
        !paths.every(path => typeof path === 'string')
      ) {
        throw new OError('Invalid project snapshot', {
          projectId,
          currentVersion,
        })
      }

      const limit = pLimit(api.maxConcurrency)
      const claimId = await SyncStateManager.claimProjectExport(
        projectId,
        userId,
        repoOptions
      )
      let outcomeUnconfirmed = false
      try {
        // Another export may have finished while this request loaded history.
        await ensureProjectIsNotLinked(projectId)
        outcomeUnconfirmed = true
        const repository = await api
          .createRepo(token, repoOptions)
          .catch(error => {
            const { status } = /** @type {{status?: unknown}} */ (
              OError.getFullInfo(error)
            )
            outcomeUnconfirmed = !(
              typeof status === 'number' &&
              status >= 400 &&
              status < 500 &&
              status !== 408
            )
            throw error
          })
        const { full_name: repoFullName, default_branch: defaultBranchName } =
          repository ?? {}
        if (typeof repoFullName !== 'string' || !repoFullName) {
          throw new OError(
            'GitHub repository creation could not be confirmed',
            {
              projectId,
              claimId,
            }
          )
        }
        outcomeUnconfirmed = false

        try {
          if (typeof defaultBranchName !== 'string' || !defaultBranchName) {
            throw new OError('GitHub did not report a default branch')
          }
          const seedCommit = await api.getBranchHead(
            token,
            repoFullName,
            defaultBranchName
          )
          // Hold the claim until every upload has settled, even when one fails.
          const uploads = await Promise.allSettled(
            paths.map(path =>
              limit(async () => {
                const buffer = await HistoryManager.getProjectFileBuffer(
                  projectId,
                  currentVersion,
                  path
                )
                const sha = await api.uploadBlob(token, repoFullName, buffer)
                return { path, sha }
              })
            )
          )
          const blobData = uploads.map(upload => {
            if (upload.status === 'rejected') throw upload.reason
            return upload.value
          })

          const tree = await api.createTree(token, repoFullName, blobData)
          const initialCommit = await api.createCommit(token, repoFullName, {
            tree,
            message: 'Initial Overleaf import',
            parents: [seedCommit],
          })
          await api.updateBranch(
            token,
            repoFullName,
            defaultBranchName,
            initialCommit
          )

          outcomeUnconfirmed = true
          const state = await SyncStateManager.createProjectState(projectId, {
            mergeStatus: 'clean',
            defaultBranchName,
            lastSyncCommit: initialCommit,
            lastSyncVersion: currentVersion,
            repoFullName,
          })
          outcomeUnconfirmed = false
          return state
        } catch (error) {
          throw new GitHubExportIncompleteError(projectId, repoFullName, error)
        }
      } finally {
        if (outcomeUnconfirmed) {
          logger.warn(
            { projectId, claimId },
            'Retaining GitHub export claim after an unconfirmed write'
          )
        } else {
          await SyncStateManager.releaseProjectExport(projectId, claimId).catch(
            error => {
              logger.warn(
                { error, projectId, claimId },
                'Failed to release GitHub export claim'
              )
            }
          )
        }
      }
    }
  )
}

export default {
  exportProject,
  getProjectState,
  unlinkRepo,
  importRepo,
  getGitConnState,
  listUserRepos,
  getUserAndOrgs,
  getMergeOverview,
}
