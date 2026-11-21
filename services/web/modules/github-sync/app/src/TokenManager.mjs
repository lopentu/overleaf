// @ts-check
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import Mongo from '../../../../app/src/Features/Helpers/Mongo.mjs'
import { GitHubSyncUserCredentials } from '../models/githubSyncUserCredentials.mjs'
import { AccessTokenEncryptor } from './AccessTokenEncryptorHelper.mjs'
import { InvalidTokenError } from './GitSyncErrors.mjs'
import GitHubApiClient from './GitHubApiClient.mjs'
import { storedGrant } from './GitHubOAuthGrant.mjs'

/** @typedef {string | import('mongodb-legacy').ObjectId} UserId */
/** @typedef {import('./GitHubOAuthGrant.mjs').OAuthGrant} OAuthGrant */

const { normalizeQuery } = Mongo
const TokenLock = LockManager.withTimeout(120)
const REFRESH_WINDOW_MS = 60_000

/** @param {string | OAuthGrant} value */
async function encryptCredential(value) {
  try {
    return await AccessTokenEncryptor.encryptJson(value)
  } catch (error) {
    throw OError.tag(error, 'failed to encrypt token')
  }
}

/** @param {string} encrypted */
async function decryptCredential(encrypted) {
  try {
    return await AccessTokenEncryptor.decryptToJson(encrypted)
  } catch {
    throw new InvalidTokenError('failed to decrypt token', { status: 401 })
  }
}

/** @param {string} encrypted */
async function readAccessToken(encrypted) {
  const accessToken = await decryptCredential(encrypted)
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new InvalidTokenError('invalid stored token', { status: 401 })
  }
  return accessToken
}

/** @param {UserId} userId */
async function readCredential(userId) {
  const record = await GitHubSyncUserCredentials.findOne(
    normalizeQuery({ userId })
  )
  if (!record) {
    throw new InvalidTokenError('no user token', { userId, status: 400 })
  }
  return { record, accessToken: await readAccessToken(record.github) }
}

/** @param {Awaited<ReturnType<typeof readCredential>>['record']} record */
function credentialRevision(record) {
  return {
    github: record.github,
    githubRefresh:
      record.githubRefresh === undefined
        ? { $exists: false }
        : record.githubRefresh,
  }
}

/**
 * @param {string} token
 * @param {UserId} userId
 */
async function revokeUserToken(token, userId) {
  try {
    await GitHubApiClient.revokeToken(token)
  } catch {
    // The provider's response body can include a submitted credential.
    logger.warn({ userId }, 'failed to revoke user token')
  }
}

/** @param {Awaited<ReturnType<typeof readCredential>>} credential */
async function grantToRefresh({ record, accessToken }) {
  if (!record.githubRefresh) return null
  const parsed = storedGrant.safeParse(
    await decryptCredential(record.githubRefresh)
  )
  if (!parsed.success) {
    throw new InvalidTokenError('invalid stored refresh grant', { status: 401 })
  }
  const grant = parsed.data
  // A rolling rollback can replace the legacy access token without touching
  // the optional refresh field. Never refresh that superseded account grant.
  if (
    grant.accessToken !== accessToken ||
    grant.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
  ) {
    return null
  }
  return grant
}

/**
 * @template T
 * @param {UserId} userId
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function withCredentialLock(userId, job) {
  return TokenLock.promises.runWithLock(
    'githubSyncCredentials',
    userId.toString(),
    job
  )
}

/** @param {UserId} userId */
async function getUserToken(userId) {
  const original = await readCredential(userId)
  if (!(await grantToRefresh(original))) return original.accessToken

  return withCredentialLock(userId, async () => {
    const current = await readCredential(userId)
    const grant = await grantToRefresh(current)
    if (!grant) return current.accessToken
    if (grant.refreshExpiresAt <= Date.now()) {
      if (grant.accessExpiresAt > Date.now()) return current.accessToken
      throw new InvalidTokenError('GitHub authorization must be renewed', {
        status: 401,
      })
    }

    const rotated = await GitHubApiClient.refreshAccessToken(grant.refreshToken)
    const github = await encryptCredential(rotated.accessToken)
    const githubRefresh = await encryptCredential(rotated)
    const updated = await GitHubSyncUserCredentials.findOneAndUpdate(
      normalizeQuery({
        userId,
        ...credentialRevision(current.record),
      }),
      { $set: { github, githubRefresh } }
    )
    if (!updated) {
      void revokeUserToken(rotated.accessToken, userId)
      throw new InvalidTokenError('GitHub credentials changed during renewal', {
        status: 401,
      })
    }
    return rotated.accessToken
  })
}

/**
 * @param {UserId} userId
 * @param {string | OAuthGrant} grant
 */
async function saveUserToken(userId, grant) {
  return withCredentialLock(userId, async () => {
    const github = await encryptCredential(
      typeof grant === 'string' ? grant : grant.accessToken
    )
    const update =
      typeof grant === 'string'
        ? { $set: { github }, $unset: { githubRefresh: '' } }
        : { $set: { github, githubRefresh: await encryptCredential(grant) } }
    await GitHubSyncUserCredentials.findOneAndUpdate(
      normalizeQuery({ userId }),
      update,
      { upsert: true }
    )
  })
}

/** @param {UserId} userId */
async function removeUserToken(userId) {
  return withCredentialLock(userId, async () => {
    const filter = normalizeQuery({ userId })
    const record = await GitHubSyncUserCredentials.findOne(filter)
    if (!record) return

    try {
      const token = await readAccessToken(record.github)
      // Revoke the stored token without renewing the grant on disconnect.
      void revokeUserToken(token, userId)
    } catch {
      logger.warn({ userId }, 'failed to get user token')
    }
    await GitHubSyncUserCredentials.deleteOne({
      ...filter,
      ...credentialRevision(record),
    })
  })
}

export default { saveUserToken, getUserToken, removeUserToken }
