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
    RequestFailedError: class extends Error {},
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
    })
  })

  it('removes local credentials without a provider call when no token is stored', async () => {
    app.credentials.findOne.mockResolvedValue(null)
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
    })
  })

  it('still removes local credentials when reading storage fails', async () => {
    const error = new Error('synthetic read failure')
    app.credentials.findOne.mockRejectedValue(error)
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
    })
    expect(app.logger.warn).toHaveBeenCalledWith(
      { err: error, userId },
      'failed to get user token'
    )
  })

  it('does not send an undecryptable credential to the provider', async () => {
    app.encryptor.decryptToJson.mockRejectedValue(
      new Error('synthetic cipher failure')
    )
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).not.toHaveBeenCalled()
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
    })
  })

  it('keeps local removal independent of a pending remote revoke', async () => {
    const pending = Promise.withResolvers()
    app.fetchNothing.mockReturnValue(pending.promise)
    await app.TokenManager.removeUserToken(userId)
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
    })
    pending.resolve(undefined)
  })

  it('handles a remote revoke rejection while still removing local credentials', async () => {
    app.fetchNothing.mockRejectedValue(new Error('synthetic revoke failure'))
    await app.TokenManager.removeUserToken(userId)
    await vi.waitFor(() => {
      expect(app.logger.warn).toHaveBeenCalledWith(
        {
          err: expect.objectContaining({
            message: 'Something wrong with GitHub request',
          }),
          userId,
        },
        'failed to revoke user token'
      )
    })
    expect(app.fetchNothing).toHaveBeenCalledTimes(1)
    expect(app.credentials.deleteOne).toHaveBeenCalledExactlyOnceWith({
      userId,
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
      { $set: { github: encryptedToken } },
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
