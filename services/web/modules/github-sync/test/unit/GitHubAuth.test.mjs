// @ts-check
import assert from 'node:assert/strict'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OError from '@overleaf/o-error'

const userId = '507f1f77bcf86cd799439011'
const token = 'synthetic-test-token'
const encryptedToken = 'synthetic-encrypted-token'

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    sendStatus: vi.fn(),
    redirect: vi.fn(),
  }
}

function makeRequest() {
  return {
    session: { user: { _id: userId } },
    query: { code: 'synthetic-code', state: 'synthetic-state' },
    accepts: vi.fn().mockReturnValue('json'),
    logger: { addFields: vi.fn(), setLevel: vi.fn() },
    i18n: { translate: vi.fn().mockReturnValue('Linked') },
  }
}

async function setup() {
  const credentials = {
    findOne: vi.fn().mockResolvedValue({ userId, github: encryptedToken }),
    findOneAndUpdate: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  }
  const encryptor = {
    encryptJson: vi.fn().mockResolvedValue(encryptedToken),
    decryptToJson: vi.fn().mockResolvedValue(token),
  }
  const fetchNothing = vi.fn().mockResolvedValue(undefined)
  const fetchJson = vi.fn().mockResolvedValue({ access_token: token })
  const validateToken = vi.fn().mockResolvedValue(undefined)
  const { RequestFailedError } =
    /** @type {typeof import('@overleaf/fetch-utils')} */ (
      await vi.importActual('@overleaf/fetch-utils')
    )
  /** @type {Promise<unknown>} */
  let queuedJob = Promise.resolve()
  const lock = vi.fn(
    (_namespace, _id, /** @type {() => Promise<unknown>} */ job) => {
      const result = queuedJob.then(job)
      queuedJob = result.catch(() => {})
      return result
    }
  )
  vi.doMock('../../../../app/src/infrastructure/LockManager.mjs', () => ({
    default: { withTimeout: () => ({ promises: { runWithLock: lock } }) },
  }))
  vi.doMock('../../app/models/githubSyncUserCredentials.mjs', () => ({
    GitHubSyncUserCredentials: credentials,
  }))
  vi.doMock('../../app/src/AccessTokenEncryptorHelper.mjs', () => ({
    AccessTokenEncryptor: encryptor,
  }))
  vi.doMock('@overleaf/settings', () => ({
    default: {
      githubSync: {
        clientID: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        callbackURL: 'https://example.invalid/oauth/callback',
      },
    },
  }))
  vi.doMock('@overleaf/fetch-utils', () => ({
    fetchJson,
    fetchNothing,
    fetchJsonWithResponse: vi.fn(),
    fetchStreamWithResponse: vi.fn(),
    fetchStream: vi.fn(),
    RequestFailedError,
  }))
  vi.doMock('../../../../app/src/infrastructure/Csrf.mjs', () => ({
    default: { promises: { validateToken } },
  }))
  vi.doMock('../../app/src/GitHubSyncHandler.mjs', () => ({ default: {} }))
  vi.doMock('../../app/src/GitMerge.mjs', () => ({ doGitMerge: vi.fn() }))
  const TokenManager = (await import('../../app/src/TokenManager.mjs')).default
  const api = (await import('../../app/src/GitHubApiClient.mjs')).default
  const controller = (await import('../../app/src/GitHubSyncController.mjs'))
    .default
  const logger = (await import('@overleaf/logger')).default
  return {
    credentials,
    encryptor,
    fetchNothing,
    fetchJson,
    validateToken,
    RequestFailedError,
    TokenManager,
    api,
    controller,
    logger,
  }
}

/** @type {Awaited<ReturnType<typeof setup>>} */
let app
beforeEach(async () => {
  app = await setup()
})

/**
 * @param {string} url
 * @param {string} method
 * @param {number} status
 * @param {string} body
 */
function providerError(url, method, status, body) {
  // The error constructor and its consumers inspect only the status and
  // headers here. The built-in Response supplies that part of node-fetch's API.
  const response =
    /** @type {ConstructorParameters<typeof app.RequestFailedError>[2]} */ (
      /** @type {unknown} */ (new Response(body, { status }))
    )
  return new app.RequestFailedError(url, { method }, response, body)
}

describe('GitHub credential removal', () => {
  it('preserves an encryption failure without storing a credential', async () => {
    const error = new Error('synthetic encryption failure')
    app.encryptor.encryptJson.mockRejectedValue(error)
    await assert.rejects(
      app.TokenManager.saveUserToken(userId, token),
      received => received === error
    )
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('revokes the stored token exactly once at the provider and deletes local credentials', async () => {
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/applications/synthetic-client/token',
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Overleaf-CEP-GitHub-Sync',
        },
        basicAuth: { user: 'synthetic-client', password: 'synthetic-secret' },
        json: { access_token: token },
        signal: expect.any(AbortSignal),
      }
    )
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
      github: encryptedToken,
      githubRefresh: { $exists: false },
    })
  })

  it('does not issue a blind delete when there is no credential', async () => {
    app.credentials.findOne.mockResolvedValue(null)
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).not.toHaveBeenCalled()
  })

  it('surfaces a storage read failure without deleting an unknown credential', async () => {
    const error = new Error('synthetic read failure')
    app.credentials.findOne.mockRejectedValue(error)
    await assert.rejects(
      app.TokenManager.removeUserToken(userId),
      received => received === error
    )
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).not.toHaveBeenCalled()
  })

  it('does not send an undecryptable credential to the provider', async () => {
    app.encryptor.decryptToJson.mockRejectedValue(
      new Error('synthetic cipher failure')
    )
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
      github: encryptedToken,
      githubRefresh: { $exists: false },
    })
  })

  it('keeps local removal independent of a pending remote revoke', async () => {
    const pending = Promise.withResolvers()
    app.fetchNothing.mockReturnValue(pending.promise)
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
      github: encryptedToken,
      githubRefresh: { $exists: false },
    })
    pending.resolve(undefined)
  })

  it('removes local credentials without logging the raw revoke response', async () => {
    const message = JSON.stringify({ token })
    const error = providerError(
      'https://api.github.com/applications/synthetic-client/token',
      'DELETE',
      422,
      message
    )
    app.fetchNothing.mockRejectedValue(error)
    await app.TokenManager.removeUserToken(userId)
    await vi.waitFor(() => {
      expect(app.logger.warn).toHaveBeenCalledWith(
        { userId },
        'failed to revoke user token'
      )
    })
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
      github: encryptedToken,
      githubRefresh: { $exists: false },
    })
  })

  it('preserves a local delete failure after starting remote revocation', async () => {
    const error = new Error('synthetic delete failure')
    app.credentials.deleteOne.mockRejectedValue(error)
    await assert.rejects(
      app.TokenManager.removeUserToken(userId),
      received => received === error
    )
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
  })
})

describe('GitHub OAuth access token renewal', () => {
  const replacementToken = 'synthetic-replacement-access'
  const originalRefresh = 'synthetic-original-refresh'
  const replacementRefresh = 'synthetic-replacement-refresh'

  function mockExpiredGrant() {
    const record = {
      userId,
      github: encryptedToken,
      githubRefresh: 'encrypted-refresh-record',
    }
    app.credentials.findOne.mockResolvedValue(record)
    app.encryptor.decryptToJson.mockImplementation(async value => {
      if (value === encryptedToken) return token
      return {
        accessToken: token,
        refreshToken: originalRefresh,
        accessExpiresAt: Date.now() - 1000,
        refreshExpiresAt: Date.now() + 3600_000,
      }
    })
    return record
  }

  it('requests an expiring grant when starting browser authorization', () => {
    const scope = app.api.getOAuth2Url().searchParams.get('scope')
    expect(scope?.split(' ')).toEqual([
      'read:org',
      'repo',
      'workflow',
      'offline_access',
    ])
  })

  it('encrypts the access token and the refresh metadata together in a single update', async () => {
    app.fetchJson.mockResolvedValue({
      access_token: token,
      refresh_token: originalRefresh,
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    })
    app.encryptor.encryptJson
      .mockResolvedValueOnce(encryptedToken)
      .mockResolvedValueOnce('encrypted-refresh-record')
    const res = makeResponse()
    await app.controller.oauth2Callback(makeRequest(), res, vi.fn())
    expect(app.encryptor.encryptJson).toHaveBeenNthCalledWith(1, token)
    expect(app.encryptor.encryptJson).toHaveBeenNthCalledWith(2, {
      accessToken: token,
      refreshToken: originalRefresh,
      accessExpiresAt: expect.any(Number),
      refreshExpiresAt: expect.any(Number),
    })
    expect(app.credentials.findOneAndUpdate).toHaveBeenCalledExactlyOnceWith(
      { userId },
      {
        $set: {
          github: encryptedToken,
          githubRefresh: 'encrypted-refresh-record',
        },
      },
      { upsert: true }
    )
    expect(res.redirect).toHaveBeenCalledTimes(1)
  })

  it('renews exactly once for concurrent requests and stores the rotated grant', async () => {
    const original = mockExpiredGrant()
    const readOriginal = app.encryptor.decryptToJson.getMockImplementation()
    const refreshed = {
      accessToken: replacementToken,
      refreshToken: replacementRefresh,
      accessExpiresAt: Date.now() + 28_800_000,
      refreshExpiresAt: Date.now() + 15_897_600_000,
    }
    app.fetchJson.mockResolvedValue({
      access_token: replacementToken,
      refresh_token: replacementRefresh,
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    })
    app.encryptor.encryptJson
      .mockResolvedValueOnce('encrypted-replacement-access')
      .mockResolvedValueOnce('encrypted-replacement-refresh')
    app.credentials.findOneAndUpdate.mockImplementation(async () => {
      const updated = {
        ...original,
        github: 'encrypted-replacement-access',
        githubRefresh: 'encrypted-replacement-refresh',
      }
      app.credentials.findOne.mockResolvedValue(updated)
      app.encryptor.decryptToJson.mockImplementation(async value => {
        if (value === updated.github) return replacementToken
        if (value === updated.githubRefresh) return refreshed
        return readOriginal?.(value)
      })
      return updated
    })

    const tokens = await Promise.all([
      app.TokenManager.getUserToken(userId),
      app.TokenManager.getUserToken(userId),
    ])
    expect(tokens).toEqual([replacementToken, replacementToken])
    expect(app.fetchJson).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        json: {
          client_id: 'synthetic-client',
          client_secret: 'synthetic-secret',
          grant_type: 'refresh_token',
          refresh_token: originalRefresh,
        },
      })
    )
    expect(app.credentials.findOneAndUpdate).toHaveBeenCalledTimes(1)
  })

  it('asks for reconnection when GitHub rejects a refresh token', async () => {
    mockExpiredGrant()
    app.fetchJson.mockResolvedValue({ error: 'bad_refresh_token' })
    await assert.rejects(app.TokenManager.getUserToken(userId), {
      name: 'InvalidTokenError',
      message: 'GitHub authorization must be renewed',
    })
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('recognizes a rejected grant returned as an HTTP error with a text body', async () => {
    mockExpiredGrant()
    const payload = JSON.stringify({
      error: 'bad_refresh_token',
      error_description: originalRefresh,
    })
    app.fetchJson.mockRejectedValue(
      providerError(
        'https://github.com/login/oauth/access_token',
        'POST',
        400,
        payload
      )
    )
    await assert.rejects(app.TokenManager.getUserToken(userId), {
      name: 'InvalidTokenError',
      message: 'GitHub authorization must be renewed',
    })
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('revokes the rotated token if the credential changes before it can be saved', async () => {
    mockExpiredGrant()
    app.fetchJson.mockResolvedValue({
      access_token: replacementToken,
      refresh_token: replacementRefresh,
      expires_in: 28_800,
      refresh_token_expires_in: 15_897_600,
    })
    app.credentials.findOneAndUpdate.mockResolvedValue(null)
    await assert.rejects(app.TokenManager.getUserToken(userId), {
      name: 'InvalidTokenError',
      message: 'GitHub credentials changed during renewal',
    })
    expect(app.fetchNothing).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/applications/synthetic-client/token',
      expect.objectContaining({ json: { access_token: replacementToken } })
    )
  })

  it('does not delete a newly saved grant when an older disconnect finishes', async () => {
    const original = mockExpiredGrant()
    const replacement = {
      ...original,
      github: 'replacement-access-ciphertext',
      githubRefresh: 'replacement-refresh-ciphertext',
    }
    app.credentials.deleteOne.mockImplementation(async query => {
      app.credentials.findOne.mockResolvedValue(replacement)
      expect(query).toEqual({
        userId,
        github: original.github,
        githubRefresh: original.githubRefresh,
      })
      return { deletedCount: 0 }
    })
    await app.TokenManager.removeUserToken(userId)
    expect(await app.credentials.findOne({ userId })).toEqual(replacement)
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
  })

  it('does not save a partial refresh response or include it in the error', async () => {
    mockExpiredGrant()
    app.fetchJson.mockResolvedValue({
      access_token: replacementToken,
      refresh_token: replacementRefresh,
    })
    await assert.rejects(app.TokenManager.getUserToken(userId), {
      message: 'GitHub returned an incomplete refresh grant',
    })
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('never refreshes the grant as part of disconnect', async () => {
    mockExpiredGrant()
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchJson).not.toHaveBeenCalled()
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
    expect(app.credentials.deleteOne).toHaveBeenCalledTimes(1)
  })
})

describe('GitHub OAuth callback and unlink error responses', () => {
  it('responds to the original OAuth provider error without forwarding a ReferenceError', async () => {
    const error = new Error('synthetic provider rejection')
    vi.spyOn(app.api, 'exchangeCodeForToken').mockRejectedValue(error)
    const req = makeRequest()
    const res = makeResponse()
    const next = vi.fn()
    await app.controller.oauth2Callback(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledExactlyOnceWith(400)
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ message: error.message })
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
    expect(res.redirect).not.toHaveBeenCalled()
    expect(app.validateToken).toHaveBeenCalledExactlyOnceWith(
      req.query.state,
      req.session
    )
  })

  it('rejects invalid callback state before contacting the provider', async () => {
    app.validateToken.mockRejectedValue(new Error('synthetic invalid state'))
    const res = makeResponse()
    await app.controller.oauth2Callback(makeRequest(), res, vi.fn())
    expect(res.status).toHaveBeenCalledExactlyOnceWith(403)
    expect(app.fetchJson).not.toHaveBeenCalled()
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('returns a bad request when the provider response has no access token', async () => {
    app.fetchJson.mockResolvedValue({})
    const res = makeResponse()
    await app.controller.oauth2Callback(makeRequest(), res, vi.fn())
    expect(res.status).toHaveBeenCalledExactlyOnceWith(400)
    expect(app.credentials.findOneAndUpdate).not.toHaveBeenCalled()
    expect(res.redirect).not.toHaveBeenCalled()
  })

  it('preserves a credential update failure and its status without redirecting', async () => {
    const error = new OError('synthetic update failure', { status: 503 })
    app.credentials.findOneAndUpdate.mockRejectedValue(error)
    const req = makeRequest()
    const res = makeResponse()
    const next = vi.fn()
    await app.controller.oauth2Callback(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(req.logger.addFields).toHaveBeenCalledExactlyOnceWith({ err: error })
    expect(res.status).toHaveBeenCalledExactlyOnceWith(503)
    expect(res.redirect).not.toHaveBeenCalled()
  })

  it('saves the encrypted callback token and redirects after success', async () => {
    const req = makeRequest()
    const res = makeResponse()
    await app.controller.oauth2Callback(req, res, vi.fn())
    expect(app.encryptor.encryptJson).toHaveBeenCalledExactlyOnceWith(token)
    expect(app.credentials.findOneAndUpdate).toHaveBeenCalledExactlyOnceWith(
      { userId },
      { $set: { github: encryptedToken }, $unset: { githubRefresh: '' } },
      { upsert: true }
    )
    expect(res.redirect).toHaveBeenCalledExactlyOnceWith(
      '/user/settings?oauth-complete=github#project-sync'
    )
  })

  it('returns the original unlink storage error and status without forwarding a ReferenceError', async () => {
    const error = new OError('synthetic removal failure', { status: 503 })
    app.credentials.deleteOne.mockRejectedValue(error)
    const res = makeResponse()
    const next = vi.fn()
    await app.controller.unlink(makeRequest(), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledExactlyOnceWith(503)
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ message: error.message })
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(app.logger.error).toHaveBeenCalledWith(
      { info: { status: 503 }, userId },
      'Error removing user credentials'
    )
  })

  it('defaults an unlink storage failure to status 500', async () => {
    const error = new Error('synthetic removal failure')
    app.credentials.deleteOne.mockRejectedValue(error)
    const res = makeResponse()
    const next = vi.fn()
    await app.controller.unlink(makeRequest(), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledExactlyOnceWith(500)
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ message: error.message })
  })
})
