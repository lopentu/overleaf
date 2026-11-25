// @ts-check
import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'

const USER = '111111111111111111111111'
const PROJECT = '222222222222222222222222'
const FOLDER = '333333333333333333333333'
const FILE = '444444444444444444444444'
const REFRESHER = '555555555555555555555555'
const REFRESHED_AT = '2026-11-21T00:01:00.000Z'
const KEY = 'synthetic-zotero-workflow-key'
const INITIAL = '@article{lopeInitial2026,\n  title = {Initial reference}\n}\n'
const UPDATED = '@article{lopeInitial2026,\n  title = {Updated reference}\n}\n'
const STABLE = '@book{lopeStable2026,\n  title = {Unchanged reference}\n}\n'

/** @typedef {{provider: string, group_id: null, collection_key: string, importedAt: string, format: string, importer_id?: string, importer_name?: string}} LinkData */
/** @typedef {{content: string, metadata: LinkData}} StoredBibliography */
/** @typedef {{body: string, total: string | null} | Error} ExportPage */

async function setup() {
  /** @type {typeof import('@overleaf/fetch-utils')} */
  const actual = await vi.importActual('@overleaf/fetch-utils')
  /** @type {{Response: new (body: string | null, options?: {status?: number, headers?: Record<string, string>}) => ConstructorParameters<typeof actual.RequestFailedError>[2]}} */
  const { Response } = await vi.importActual('node-fetch')
  /** @type {ExportPage[]} */
  const pages = []
  /** @type {StoredBibliography | undefined} */
  let stored
  const fetchStringWithResponse = vi.fn(
    /** @param {string} url @param {{headers: Record<string, string>, signal: AbortSignal}} options */
    async (url, options) => {
      const target = new URL(url)
      assert.equal(target.origin, 'https://api.zotero.org')
      assert.equal(target.pathname, '/users/123/collections/ABC12345/items')
      assert.equal(target.searchParams.get('format'), 'bibtex')
      assert.equal(target.searchParams.get('limit'), '100')
      assert.equal(target.searchParams.get('includeTrashed'), '0')
      assert.equal(options.headers['Zotero-API-Key'], KEY)
      assert.equal(options.headers['Zotero-API-Version'], '3')
      assert.ok(
        options.signal instanceof AbortSignal && !options.signal.aborted
      )
      const page = pages.shift()
      assert.ok(page, 'Unexpected export request; fixture response exhausted')
      if (page instanceof Error) throw page
      /** @type {Record<string, string>} */
      const headers = {}
      if (page.total !== null) headers['Total-Results'] = page.total
      return { body: page.body, response: new Response(page.body, { headers }) }
    }
  )
  const importContent = vi.fn(
    /** @param {string} project @param {string} content @param {LinkData} metadata @param {string} name @param {string} folder @param {string} user */
    async (project, content, metadata, name, folder, user) => {
      assert.equal(project, PROJECT)
      assert.equal(name, 'references.bib')
      assert.equal(folder, FOLDER)
      assert.equal(user, stored ? REFRESHER : USER)
      stored = structuredClone({ content, metadata })
      return { _id: FILE }
    }
  )
  vi.doMock('@overleaf/fetch-utils', () => ({
    ...actual,
    fetchStringWithResponse,
    fetchJson: vi.fn(() => {
      throw new Error('Unexpected JSON transport')
    }),
    fetchString: vi.fn(() => {
      throw new Error('Unexpected text transport')
    }),
    fetchNothing: vi.fn(() => {
      throw new Error('Unexpected write transport')
    }),
  }))
  vi.doMock('../../app/src/TokenManager.mjs', () => ({
    default: {
      getCredentials: async (/** @type {string} */ userId) => {
        assert.equal(userId, USER)
        return { apiKey: KEY, zoteroUserId: '123' }
      },
    },
  }))
  vi.doMock('../../../../app/src/models/User.mjs', () => ({ User: {} }))
  vi.doMock('../../../../app/src/Features/User/UserGetter.mjs', () => ({
    default: {
      promises: {
        getUser: async (/** @type {string} */ userId) => {
          assert.equal(userId, USER)
          return { first_name: 'Synthetic', last_name: 'Importer' }
        },
      },
    },
  }))
  vi.doMock(
    '../../../../app/src/Features/LinkedFiles/LinkedFilesHandler.mjs',
    () => ({
      default: { promises: { importContent } },
    })
  )
  const agent = (await import('../../app/src/ZoteroLinkedFileAgent.mjs'))
    .default
  const errors = (
    await import('../../../../app/src/Features/LinkedFiles/LinkedFilesErrors.mjs')
  ).default
  /** @type {LinkData} */
  const metadata = {
    provider: 'zotero',
    group_id: null,
    collection_key: 'ABC12345',
    importedAt: '2026-11-21T00:00:00.000Z',
    format: 'bibtex',
  }
  return {
    pages,
    agent,
    errors,
    metadata,
    importContent,
    fetchStringWithResponse,
    stored: () => {
      assert.ok(stored, 'The real agent has not persisted a bibliography')
      return structuredClone(stored)
    },
    /** @param {number} status */
    failure: status =>
      new actual.RequestFailedError(
        'https://api.zotero.org/users/123/items',
        {},
        new Response(null, { status }),
        null
      ),
  }
}

/** @type {Awaited<ReturnType<typeof setup>>} */
let fixture
beforeEach(async () => {
  fixture = await setup()
})

async function initialImport() {
  fixture.pages.push({ body: INITIAL, total: '1' })
  assert.equal(
    await fixture.agent.promises.createLinkedFile(
      PROJECT,
      fixture.metadata,
      'references.bib',
      FOLDER,
      USER
    ),
    FILE
  )
  assert.equal(fixture.stored().content, INITIAL)
}

function refresh() {
  const { metadata } = fixture.stored()
  metadata.importedAt = REFRESHED_AT
  return fixture.agent.promises.refreshLinkedFile(
    PROJECT,
    metadata,
    'references.bib',
    FOLDER,
    REFRESHER
  )
}

describe('Zotero bibliography import and refresh workflow (offline boundaries)', () => {
  it('persists exact citation keys and complete paginated content across two imports', async () => {
    fixture.pages.push(
      { body: INITIAL, total: '101' },
      { body: STABLE, total: '101' }
    )
    assert.equal(
      await fixture.agent.promises.createLinkedFile(
        PROJECT,
        fixture.metadata,
        'references.bib',
        FOLDER,
        USER
      ),
      FILE
    )
    assert.equal(fixture.stored().content, INITIAL + STABLE)
    assert.deepEqual(
      [...fixture.stored().content.matchAll(/@\w+\{([^,]+),/g)].map(
        match => match[1]
      ),
      ['lopeInitial2026', 'lopeStable2026']
    )

    fixture.pages.push(
      { body: UPDATED, total: '101' },
      { body: STABLE, total: '101' }
    )
    assert.equal(await refresh(), FILE)
    assert.equal(fixture.stored().content, UPDATED + STABLE)
    assert.deepEqual(
      [...fixture.stored().content.matchAll(/@\w+\{([^,]+),/g)].map(
        match => match[1]
      ),
      ['lopeInitial2026', 'lopeStable2026']
    )
    assert.deepEqual(fixture.stored().metadata, {
      ...fixture.metadata,
      importedAt: REFRESHED_AT,
      importer_id: USER,
      importer_name: 'Synthetic Importer',
    })
    assert.equal(fixture.importContent.mock.calls.length, 2)
    assert.deepEqual(
      fixture.fetchStringWithResponse.mock.calls.map(([url]) =>
        new URL(url).searchParams.get('start')
      ),
      ['0', '100', '0', '100']
    )
    assert.equal(fixture.pages.length, 0)
  })

  it('preserves the existing bibliography when the provider denies refresh', async () => {
    await initialImport()
    const before = fixture.stored()
    fixture.pages.push(fixture.failure(403))
    await assert.rejects(refresh(), fixture.errors.AccessDeniedError)
    assert.deepEqual(fixture.stored(), before)
    assert.equal(fixture.importContent.mock.calls.length, 1)
    assert.equal(fixture.fetchStringWithResponse.mock.calls.length, 2)
    assert.equal(fixture.pages.length, 0)
  })

  it('does not publish a partial bibliography when a later export page fails', async () => {
    await initialImport()
    const before = fixture.stored()
    fixture.pages.push({ body: UPDATED, total: '101' }, fixture.failure(503))
    await assert.rejects(refresh(), fixture.errors.RemoteServiceError)
    assert.deepEqual(fixture.stored(), before)
    assert.equal(fixture.importContent.mock.calls.length, 1)
    assert.equal(fixture.fetchStringWithResponse.mock.calls.length, 3)
    assert.equal(fixture.pages.length, 0)
  })

  it.each([null, 'invalid', '-1'])(
    'preserves the bibliography for invalid Total-Results=%s',
    async total => {
      await initialImport()
      const before = fixture.stored()
      fixture.pages.push({ body: UPDATED, total })
      await assert.rejects(refresh(), fixture.errors.RemoteServiceError)
      assert.deepEqual(fixture.stored(), before)
      assert.equal(fixture.importContent.mock.calls.length, 1)
      assert.equal(fixture.fetchStringWithResponse.mock.calls.length, 2)
      assert.equal(fixture.pages.length, 0)
    }
  )
})
