// @ts-check
import { randomUUID } from 'node:crypto'
import OError from '@overleaf/o-error'
import {
  GitHubSyncExportClaims,
  GitHubSyncProjectStates,
} from '../models/githubSyncProjectStates.mjs'
import Mongo from '../../../../app/src/Features/Helpers/Mongo.mjs'
const { normalizeQuery } = Mongo

/** @typedef {string | import('mongoose').Types.ObjectId | import('mongodb-legacy').ObjectId} ProjectId */
/** @typedef {import('mongoose').InferSchemaType<typeof import('../models/githubSyncProjectStates.mjs').GitHubSyncProjectStatesSchema>} ProjectState */

/**
 * @param {ProjectId} projectId
 * @param {Record<string, number>} [projection]
 */
function getProjectState(projectId, projection = {}) {
  return GitHubSyncProjectStates.findOne(
    normalizeQuery({ projectId }),
    projection
  )
    .read('primary')
    .lean()
}

/**
 * @param {ProjectId} projectId
 * @param {Partial<ProjectState>} data
 */
function createProjectState(projectId, data) {
  return GitHubSyncProjectStates.create({
    projectId: normalizeQuery(projectId),
    ...data,
  })
}

/**
 * @param {ProjectId} projectId
 * @param {Partial<ProjectState>} data
 */
function updateProjectState(projectId, data) {
  return GitHubSyncProjectStates.updateOne(normalizeQuery({ projectId }), {
    $set: data,
  })
}

/** @param {ProjectId} projectId */
function removeProjectState(projectId) {
  return GitHubSyncProjectStates.deleteMany(normalizeQuery({ projectId }))
}

/**
 * @param {string} projectId
 * @param {string} userId
 * @param {{name: string, org?: string}} repoOptions
 */
async function claimProjectExport(projectId, userId, repoOptions) {
  const { _id } = normalizeQuery(projectId)
  const claimId = randomUUID()
  try {
    await GitHubSyncExportClaims.create({
      _id,
      claimId,
      userId,
      repositoryName: repoOptions.name,
      organization: repoOptions.org,
      startedAt: new Date(),
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 11000) {
      throw new OError(
        'GitHub export is already in progress or awaits recovery for this project',
        { status: 409, projectId }
      )
    }
    throw error
  }
  return claimId
}

/**
 * @param {string} projectId
 * @param {string} claimId
 */
function releaseProjectExport(projectId, claimId) {
  const { _id } = normalizeQuery(projectId)
  return GitHubSyncExportClaims.deleteOne({ _id, claimId })
}

export default {
  getProjectState,
  createProjectState,
  updateProjectState,
  removeProjectState,
  claimProjectExport,
  releaseProjectExport,
}
