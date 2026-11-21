// @ts-check
import assert from 'node:assert/strict'
import OError from '@overleaf/o-error'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const provider = 'https://api.github.com/repos/test-account/disposable'
const repo = 'test-account/disposable'
const token = 'synthetic-provider-token'
const source = 'a'.repeat(40)
const head = 'b'.repeat(40)

/** @type {Awaited<ReturnType<typeof setup>>} */
let test

async function setup() {
  const fetchJson = vi.fn()
  const fetchStringWithResponse = vi.fn()
  class RequestFailedError extends OError {
    /** @param {number} status @param {string} body */
    constructor(status, body) {
      super('synthetic provider error', { status, body })
      this.response = { status }
      this.body = body
    }
  }
  vi.doMock('@overleaf/fetch-utils', () => ({
    fetchJson,
    fetchJsonWithResponse: vi.fn(),
    fetchNothing: vi.fn(),
    fetchStream: vi.fn(),
    fetchStringWithResponse,
    RequestFailedError,
  }))
  const api = (await import('../../app/src/GitHubApiClient.mjs')).default
  return { api, fetchJson, fetchStringWithResponse, RequestFailedError }
}

beforeEach(async () => {
  test = await setup()
})

describe('GitHub merge response and export visibility', () => {
  it('reads the current base after a successful empty response', async () => {
    test.fetchStringWithResponse.mockResolvedValue({
      response: { status: 204 },
      body: '',
    })
    test.fetchJson
      .mockResolvedValueOnce({ object: { sha: head } })
      .mockResolvedValueOnce({ status: 'ahead' })
    expect(await test.api.mergeBranch(token, repo, 'main', source)).toBe(head)
    expect(test.fetchStringWithResponse).toHaveBeenCalledExactlyOnceWith(
      provider + '/merges',
      expect.objectContaining({ json: { base: 'main', head: source } })
    )
    expect(test.fetchJson).toHaveBeenNthCalledWith(
      1,
      provider + '/git/ref/heads/main',
      expect.any(Object)
    )
    expect(test.fetchJson).toHaveBeenNthCalledWith(
      2,
      provider + '/compare/' + source + '...' + head,
      expect.any(Object)
    )
  })

  it('reads the resulting SHA from a successful merge', async () => {
    test.fetchStringWithResponse.mockResolvedValue({
      response: { status: 201 },
      body: JSON.stringify({ sha: head }),
    })
    expect(await test.api.mergeBranch(token, repo, 'main', source)).toBe(head)
    expect(test.fetchJson).not.toHaveBeenCalled()
  })

  it('retains the provider status without passing raw response text to callers', async () => {
    const error = new test.RequestFailedError(
      422,
      'synthetic private response text'
    )
    test.fetchStringWithResponse.mockRejectedValue(error)
    await assert.rejects(
      test.api.mergeBranch(token, repo, 'main', source),
      received => {
        assert.deepEqual(OError.getFullInfo(received), { status: 422 })
        return true
      }
    )
  })

  it('rejects truncated GitHub trees before comparing project files', async () => {
    test.fetchJson.mockResolvedValue({ truncated: true, tree: [] })
    await assert.rejects(test.api.listBlobsAtCommit(token, repo, head), {
      name: 'ProviderRequestError',
    })
  })

  it('only makes a new repository public for a literal boolean true', async () => {
    test.fetchJson.mockResolvedValue({
      full_name: repo,
      default_branch: 'main',
    })
    const opts = { name: 'example', description: '', org: '' }
    const invalidFlag = /** @type {boolean} */ (
      /** @type {unknown} */ ('false')
    )
    await test.api.createRepo(token, { ...opts, isPublic: invalidFlag })
    await test.api.createRepo(token, { ...opts, isPublic: true })
    expect(test.fetchJson).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user/repos',
      expect.objectContaining({
        json: expect.objectContaining({ private: true }),
      })
    )
    expect(test.fetchJson).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/repos',
      expect.objectContaining({
        json: expect.objectContaining({ private: false }),
      })
    )
  })
})
