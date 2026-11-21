// @ts-check

import { Project } from '../../models/Project.mjs'
import OError from '@overleaf/o-error'

const fields = { activeDocumentRetirement: 1, historyResyncReservation: 1 }
const majority = /** @type {const} */ ({
  readPreference: 'primary',
  readConcern: { level: 'majority' },
})

/** @param {string} projectId */
async function read(projectId) {
  return /** @type {{activeDocumentRetirement?: string, historyResyncReservation?: string} | null} */ (
    await Project.findById(projectId, fields, majority).lean().exec()
  )
}

/**
 * @param {string} projectId
 * @param {string} token
 * @param {string} [expectedToken] Previously observed reservation, while holding the history lock.
 */
export async function claim(projectId, token, expectedToken) {
  await Project.updateOne(
    {
      _id: projectId,
      activeDocumentRetirement: { $exists: false },
      $or: [
        { historyResyncReservation: expectedToken ?? { $exists: false } },
        { historyResyncReservation: token },
      ],
    },
    { $set: { historyResyncReservation: token } },
    { writeConcern: { w: 'majority' } }
  ).exec()
  const project = await read(projectId)
  if (!project || project.activeDocumentRetirement) return { status: 'blocked' }
  if (project.historyResyncReservation === token) return { status: 'claimed' }
  if (project.historyResyncReservation) {
    return { status: 'held', token: project.historyResyncReservation }
  }
  throw new Error('History resync reservation could not be confirmed')
}

/** @param {string} projectId @param {string} token */
export async function release(projectId, token) {
  const result = await Project.updateOne(
    { _id: projectId, historyResyncReservation: token },
    { $unset: { historyResyncReservation: 1 } },
    { writeConcern: { w: 'majority' } }
  ).exec()
  if (result.acknowledged && result.matchedCount === 1)
    return { status: 'released' }
  const project = await read(projectId)
  return { status: project?.historyResyncReservation ? 'conflict' : 'missing' }
}

/** @param {string} projectId @param {string | undefined} token */
export async function requireCurrent(projectId, token) {
  const project = token ? await read(projectId) : null
  if (
    !project ||
    project.activeDocumentRetirement ||
    project.historyResyncReservation !== token
  ) {
    throw new OError('History resync reservation changed', { status: 409 })
  }
}
