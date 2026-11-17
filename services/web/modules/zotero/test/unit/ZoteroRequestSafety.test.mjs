// @ts-check
import assert from 'node:assert/strict'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OError from '@overleaf/o-error'
import logger from '@overleaf/logger'

const secret = 'synthetic-zotero-credential-sentinel'

async function setup() {
  /** @type {typeof import('@overleaf/fetch-utils')} */
  const actual = await vi.importActual('@overleaf/fetch-utils')
  const fetchString = vi
    .fn()
    .mockResolvedValue(
      'oauth_token=synthetic-token&oauth_token_secret=synthetic-token-secret&userID=123'
    )
  const fetchJson = vi.fn().mockResolvedValue({})
  const fetchNothing = vi.fn().mockResolvedValue(undefined)
  const getCredentials = vi.fn().mockResolvedValue({
    apiKey: secret,
    zoteroUserId: '123',
  })
  const update = { exec: vi.fn().mockResolvedValue(undefined) }
  const updateOne = vi.fn().mockReturnValue(update)
  vi.doMock('@overleaf/settings', () => ({
    default: {
      zotero: {
        clientKey: 'synthetic-client',
        clientSecret: secret,
        callbackURL: 'https://example.invalid/zotero/callback',
      },
    },
  }))
  vi.doMock('@overleaf/fetch-utils', () => ({
    ...actual,
    fetchString,
    fetchJson,
    fetchNothing,
  }))
  vi.doMock('../../app/src/TokenManager.mjs', () => ({
    default: { getCredentials },
  }))
  vi.doMock('../../../../app/src/models/User.mjs', () => ({
    User: { updateOne },
  }))
  return {
    actual,
    fetchString,
    fetchJson,
    fetchNothing,
    updateOne,
    oauth: (await import('../../app/src/ZoteroOAuth.mjs')).default,
    api: (await import('../../app/src/ZoteroApiClient.mjs')).default,
  }
}

/** @type {Awaited<ReturnType<typeof setup>>} */
let app
beforeEach(async () => {
  app = await setup()
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** @param {unknown} error */
function assertSafe(error) {
  const rendered = JSON.stringify({
    stack: OError.getFullStack(error),
    info: OError.getFullInfo(error),
    logs: vi.mocked(logger.error).mock.calls,
  })
  assert.equal(rendered.includes(secret), false)
  assert.equal(rendered.includes('/keys/'), false)
}

/** @param {unknown} error */
function statusOf(error) {
  const info = OError.getFullInfo(error)
  assert.ok('status' in info)
  return info.status
}

/** @param {import('node:http').Server} server */
async function listen(server) {
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

/** @param {import('node:http').Server} server */
async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve(undefined)))
  )
}

/** @param {number} status */
async function requestFailure(status) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status)
    response.end(secret)
  })
  const port = await listen(server)
  try {
    await app.actual.fetchJson(`http://127.0.0.1:${port}/keys/${secret}`)
    throw new Error('Expected synthetic HTTP failure')
  } catch (error) {
    assert.ok(error instanceof app.actual.RequestFailedError)
    return error
  } finally {
    await close(server)
  }
}

describe('Zotero closed credential-safe failures', () => {
  it.each(['getRequestToken', 'exchangeRequestTokenForAccessToken'])(
    'does not propagate raw provider error chains from %s',
    async operation => {
      const error = Object.assign(new Error(secret), {
        name: secret,
        url: `https://example.invalid/${secret}`,
        cause: new Error(secret),
        info: { Authorization: secret },
      })
      app.fetchString.mockRejectedValue(error)
      const promise =
        operation === 'getRequestToken'
          ? app.oauth.getRequestToken()
          : app.oauth.exchangeRequestTokenForAccessToken(secret, secret, secret)
      await assert.rejects(promise, received => {
        assertSafe(received)
        assert.notEqual(received, error)
        return true
      })
    }
  )

  it.each([403, 404, 429, 503])(
    'preserves HTTP %i classification without key URL/body/cause exposure',
    async status => {
      app.fetchJson.mockRejectedValue(await requestFailure(status))
      await assert.rejects(
        app.api.getConnectionStatus('synthetic-user'),
        error => {
          assert.equal(statusOf(error), status)
          assertSafe(error)
          return true
        }
      )
    }
  )

  it('normalizes an invalid remote HTTP status to a safe server failure', async () => {
    app.fetchJson.mockRejectedValue(await requestFailure(999))
    await assert.rejects(
      app.api.getConnectionStatus('synthetic-user'),
      error => {
        assert.equal(statusOf(error), 500)
        assertSafe(error)
        return true
      }
    )
  })

  it('keeps unlink best-effort while hiding a failed remote revocation', async () => {
    app.fetchNothing.mockRejectedValue(await requestFailure(403))
    await app.api.unlinkAccount('synthetic-user')
    expect(app.updateOne).toHaveBeenCalledExactlyOnceWith(
      { _id: 'synthetic-user' },
      { $unset: { 'refProviders.zotero': 1 } }
    )
    assertSafe(undefined)
  })
})

describe('Zotero OAuth success and validation', () => {
  it('preserves request-token fields and signs the bounded POST', async () => {
    const result = await app.oauth.getRequestToken()
    assert.equal(result.oauth_token, 'synthetic-token')
    assert.equal(result.oauth_token_secret, 'synthetic-token-secret')
    const [url, options] = app.fetchString.mock.calls[0]
    assert.equal(url, 'https://www.zotero.org/oauth/request')
    assert.equal(options.method, 'POST')
    assert.match(options.headers.Authorization, /^OAuth /)
    assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted)
  })

  it('preserves the access-token DTO with a validated numeric Zotero user ID', async () => {
    assert.deepEqual(
      await app.oauth.exchangeRequestTokenForAccessToken(
        secret,
        secret,
        secret
      ),
      {
        accessToken: 'synthetic-token',
        zoteroUserId: '123',
      }
    )
  })

  it.each([
    'oauth_token=synthetic-token',
    'oauth_token=synthetic-token&userID=invalid',
  ])('refuses incomplete or invalid access-token responses', async body => {
    app.fetchString.mockResolvedValue(body)
    await assert.rejects(
      app.oauth.exchangeRequestTokenForAccessToken(secret, secret, secret),
      error => {
        assertSafe(error)
        return true
      }
    )
    expect(app.fetchString).toHaveBeenCalledTimes(1)
  })
})

describe('Zotero bounded OAuth exchanges', () => {
  it.each(['getRequestToken', 'exchangeRequestTokenForAccessToken'])(
    'cancels a stalled response body in %s without retry',
    async operation => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/x-www-form-urlencoded',
        })
        response.write('oauth_token=')
      })
      const port = await listen(server)
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(ms => {
          assert.equal(ms, 60_000)
          return originalTimeout(50)
        })
      app.fetchString.mockImplementation((_url, options) => {
        assert.ok(options.signal instanceof AbortSignal)
        return app.actual.fetchString(`http://127.0.0.1:${port}/`, options)
      })
      try {
        const promise =
          operation === 'getRequestToken'
            ? app.oauth.getRequestToken()
            : app.oauth.exchangeRequestTokenForAccessToken(
                secret,
                secret,
                secret
              )
        await assert.rejects(promise, error => {
          assert.equal(statusOf(error), 504)
          assertSafe(error)
          return true
        })
        expect(timeout).toHaveBeenCalledTimes(1)
        expect(app.fetchString).toHaveBeenCalledTimes(1)
      } finally {
        await close(server)
      }
    }
  )
})
