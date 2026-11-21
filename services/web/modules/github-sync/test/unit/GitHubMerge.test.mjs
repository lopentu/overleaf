// @ts-check
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const projectId = '507f1f77bcf86cd799439011'
const userId = '507f1f77bcf86cd799439012'
const docId = '507f1f77bcf86cd799439013'
const token = 'synthetic-provider-token'
const repo = 'test-account/disposable'
const branch = 'main'
const prior = 'a'.repeat(40)
const remote = 'b'.repeat(40)
const local = 'c'.repeat(40)
const integrated = 'd'.repeat(40)

const state = {
  projectId,
  repoFullName: repo,
  defaultBranchName: branch,
  lastSyncVersion: 1,
  lastSyncCommit: prior,
  mergeStatus: 'clean',
}
const conflict = {
  ...state,
  lastSyncCommit: remote,
  mergeStatus: 'conflict',
  unmergedBranchName: 'overleaf-recovery-branch',
  unmergedBranchHead: local,
  conflictVersion: 2,
}

/** @type {Awaited<ReturnType<typeof setup>>} */
let test

async function setup() {
  const settings = {
    documentupdater: {
      enableRetirementQueue: true,
      enableRetirementWriterSeal: true,
      enableRetirementBinaryConversion: false,
    },
  }
  vi.doMock('@overleaf/settings', () => ({ default: settings }))
  const store = {
    getProjectState: vi.fn().mockResolvedValue(state),
    updateProjectState: vi.fn().mockResolvedValue(undefined),
  }
  const provider = {
    maxConcurrency: 2,
    getBranchHead: vi.fn().mockResolvedValue(remote),
    isCommitIncluded: vi.fn().mockResolvedValue(false),
    getCommitTree: vi.fn().mockResolvedValue('base-tree'),
    createTree: vi.fn().mockResolvedValue('updated-tree'),
    createCommit: vi.fn().mockResolvedValue(local),
    uploadBlob: vi.fn().mockResolvedValue('local-blob'),
    updateBranch: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue(undefined),
    mergeBranch: vi.fn().mockResolvedValue(integrated),
    listBlobsAtCommit: vi
      .fn()
      .mockResolvedValue([{ path: 'main.tex', sha: 'merged-blob' }]),
    getBlobStream: vi
      .fn()
      .mockImplementation(() => Readable.from('merged source')),
  }
  const history = {
    latestVersion: vi.fn().mockResolvedValue(2),
    getProjectSnapshot: vi
      .fn()
      .mockResolvedValue({ 'main.tex': { data: { hash: 'old-blob' } } }),
    getProjectFileTreeDiff: vi
      .fn()
      .mockResolvedValue([{ operation: 'edited', pathname: 'main.tex' }]),
    getPathsAtVersion: vi.fn().mockResolvedValue({ paths: ['main.tex'] }),
    getProjectFileBuffer: vi
      .fn()
      .mockResolvedValue(Buffer.from('local').toString('base64')),
  }
  const localBlob = '/tmp/synthetic-github-update'
  const unlink = vi.fn().mockResolvedValue(undefined)
  const editor = {
    _mergeUpdate: vi.fn().mockImplementation(async () => {
      history.getProjectSnapshot.mockResolvedValue({
        'main.tex': { data: { hash: 'merged-blob' } },
      })
      return { entityType: 'file' }
    }),
    writeUpdateToDisk: vi.fn().mockResolvedValue(localBlob),
    deleteUpdate: vi.fn(),
  }
  vi.doMock('node:fs/promises', () => ({ default: { unlink } }))
  vi.doMock('../../app/src/SyncStateManager.mjs', () => ({ default: store }))
  vi.doMock('../../app/src/GitHubApiClient.mjs', () => ({ default: provider }))
  vi.doMock('../../app/src/HistoryManager.mjs', () => ({ default: history }))
  vi.doMock('../../app/src/TokenManager.mjs', () => ({
    default: { getUserToken: vi.fn().mockResolvedValue(token) },
  }))
  vi.doMock('../../../../app/src/infrastructure/LockManager.mjs', () => ({
    default: {
      withTimeout: () => ({
        promises: {
          runWithLock: (
            /** @type {string} */ namespace,
            /** @type {string} */ id,
            /** @type {() => Promise<unknown>} */ job
          ) => {
            assert.equal(namespace, 'gitSync')
            assert.equal(id, projectId)
            return job()
          },
        },
      }),
    },
  }))
  const docUpdater = {
    flushProjectToMongo: vi.fn(),
    getDocument: vi.fn().mockResolvedValue({ version: 0 }),
  }
  const entities = {
    getAllEntities: vi.fn().mockResolvedValue({ docs: [], files: [] }),
  }
  vi.doMock(
    '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
    () => ({ default: { promises: docUpdater } })
  )
  vi.doMock(
    '../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
    () => ({ default: { promises: entities } })
  )
  const resumeActiveDocumentRetirement = vi.fn().mockResolvedValue(undefined)
  vi.doMock(
    '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs',
    () => ({ default: { promises: { resumeActiveDocumentRetirement } } })
  )
  vi.doMock(
    '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
    () => ({ default: { promises: editor } })
  )
  const { doGitMerge } = await import('../../app/src/GitMerge.mjs')
  const { GitConflictError, ProviderRequestError } =
    await import('../../app/src/GitSyncErrors.mjs')
  return {
    settings,
    store,
    provider,
    history,
    editor,
    docUpdater,
    entities,
    resumeActiveDocumentRetirement,
    localBlob,
    unlink,
    doGitMerge,
    GitConflictError,
    ProviderRequestError,
  }
}

beforeEach(async () => {
  test = await setup()
})

describe('GitHub merge and recovery', () => {
  it('reports an unlinked project through the domain error', async () => {
    test.store.getProjectState.mockResolvedValue(null)
    await assert.rejects(test.doGitMerge(userId, projectId, '', false), {
      name: 'GitNotLinkedError',
    })
    expect(test.provider.getBranchHead).not.toHaveBeenCalled()
  })

  it('keeps divergent edits in a separate branch after a confirmed conflict', async () => {
    test.provider.mergeBranch.mockRejectedValue(
      new test.GitConflictError('GitHub reported a conflict')
    )
    const result = await test.doGitMerge(
      userId,
      projectId,
      'local edits',
      false
    )
    expect(result.mergeStatus).toBe('conflict')
    expect(result.unmergedBranchName).toMatch(/^overleaf-/)
    expect(test.provider.mergeBranch).toHaveBeenCalledExactlyOnceWith(
      token,
      repo,
      branch,
      local
    )
    expect(test.provider.createBranch).toHaveBeenCalledExactlyOnceWith(
      token,
      repo,
      result.unmergedBranchName,
      local
    )
    expect(
      test.provider.createBranch.mock.invocationCallOrder[0]
    ).toBeGreaterThan(test.provider.mergeBranch.mock.invocationCallOrder[0])
    expect(test.store.updateProjectState).toHaveBeenCalledWith(projectId, {
      mergeStatus: 'conflict',
      lastSyncCommit: remote,
      unmergedBranchName: result.unmergedBranchName,
      unmergedBranchHead: local,
      conflictVersion: 2,
    })
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
  })

  it('rechecks a default branch that advances during a fast-forward attempt', async () => {
    test.provider.getBranchHead
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(remote)
    test.provider.updateBranch.mockRejectedValue(
      new test.ProviderRequestError('GitHub request failed', { status: 422 })
    )
    test.provider.mergeBranch.mockRejectedValue(
      new test.GitConflictError('GitHub reported a conflict')
    )
    const result = await test.doGitMerge(userId, projectId, '', false)
    expect(result.mergeStatus).toBe('conflict')
    expect(test.provider.getBranchHead).toHaveBeenCalledTimes(2)
    expect(test.store.updateProjectState).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        mergeStatus: 'conflict',
        lastSyncCommit: remote,
      })
    )
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
  })

  it('keeps a validation failure when the default branch did not move', async () => {
    test.provider.getBranchHead.mockResolvedValue(prior)
    const error = new test.ProviderRequestError('GitHub request failed', {
      status: 422,
    })
    test.provider.updateBranch.mockRejectedValue(error)
    await assert.rejects(
      test.doGitMerge(userId, projectId, '', false),
      received => received === error
    )
    expect(test.provider.getBranchHead).toHaveBeenCalledTimes(2)
    expect(test.provider.mergeBranch).not.toHaveBeenCalled()
    expect(test.provider.createBranch).not.toHaveBeenCalled()
  })

  it('separates a snapshot failure from a branch update race', async () => {
    test.provider.getBranchHead
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(local)
    const error = new test.ProviderRequestError('Cannot load snapshot', {
      status: 422,
    })
    test.provider.listBlobsAtCommit.mockRejectedValue(error)
    await assert.rejects(
      test.doGitMerge(userId, projectId, '', false),
      received => received === error
    )
    expect(test.provider.getBranchHead).toHaveBeenCalledTimes(1)
    expect(test.provider.mergeBranch).not.toHaveBeenCalled()
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('leaves the project untouched when the conflict branch is still unmerged', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    const result = await test.doGitMerge(userId, projectId, '', true)
    expect(result).toEqual({
      mergeStatus: 'conflict',
      repoFullName: repo,
      unmergedBranchName: conflict.unmergedBranchName,
    })
    expect(test.provider.isCommitIncluded).toHaveBeenCalledExactlyOnceWith(
      token,
      repo,
      local,
      integrated
    )
    expect(test.provider.listBlobsAtCommit).not.toHaveBeenCalled()
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
  })

  it('imports the verified merge and clears conflict state', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    const result = await test.doGitMerge(userId, projectId, '', true)
    expect(result.mergeStatus).toBe('clean')
    expect(test.provider.listBlobsAtCommit).toHaveBeenCalledWith(
      token,
      repo,
      integrated
    )
    expect(test.editor.writeUpdateToDisk).toHaveBeenCalledExactlyOnceWith(
      projectId,
      expect.any(Readable)
    )
    expect(test.editor._mergeUpdate).toHaveBeenCalledWith(
      userId,
      projectId,
      '/main.tex',
      test.localBlob,
      'github',
      null
    )
    expect(test.store.updateProjectState).toHaveBeenCalledWith(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion: 2,
      lastSyncCommit: integrated,
      conflictVersion: null,
      unmergedBranchName: null,
      unmergedBranchHead: null,
    })
  })

  it('preserves edits made while the remote conflict resolution was being checked', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.history.latestVersion.mockResolvedValueOnce(2).mockResolvedValue(3)
    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      name: 'GitConflictError',
      message: 'Overleaf changed during GitHub sync. Retry the sync.',
    })
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
    expect(test.editor.deleteUpdate).not.toHaveBeenCalled()
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('checks the editor version after downloading remote files', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.provider.getBlobStream.mockImplementation(async () => {
      test.history.latestVersion.mockResolvedValue(3)
      return Readable.from('merged source')
    })
    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      name: 'GitConflictError',
      message: 'Overleaf changed during GitHub sync. Retry the sync.',
    })
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
    expect(test.editor.deleteUpdate).not.toHaveBeenCalled()
    expect(test.unlink).toHaveBeenCalledExactlyOnceWith(test.localBlob)
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('cleans downloaded files when a later download fails before application', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.provider.listBlobsAtCommit.mockResolvedValue([
      { path: 'main.tex', sha: 'new-main' },
      { path: 'extra.tex', sha: 'new-extra' },
    ])
    const error = new Error('synthetic provider download failure')
    test.provider.getBlobStream
      .mockResolvedValueOnce(Readable.from('merged source'))
      .mockRejectedValueOnce(error)
    await assert.rejects(
      test.doGitMerge(userId, projectId, '', true),
      received => received === error
    )
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
    expect(test.editor.deleteUpdate).not.toHaveBeenCalled()
    expect(test.unlink).toHaveBeenCalledExactlyOnceWith(test.localBlob)
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('does not advance sync when a requested deletion is still present', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.provider.listBlobsAtCommit.mockResolvedValue([])
    const fileId = '507f1f77bcf86cd799439014'
    test.entities.getAllEntities.mockResolvedValue({
      docs: [],
      files: [{ path: '/main.tex', file: { _id: fileId, rev: 1 } }],
    })
    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      name: 'GitConflictError',
      message: 'GitHub deletions were not applied. Retry the sync.',
    })
    expect(test.editor.deleteUpdate).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      '/main.tex',
      'github',
      { fileId, rev: 1 }
    )
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('recovers terminal retirement before planning and reuses the editable deletion identity on retry', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.provider.listBlobsAtCommit.mockResolvedValue([])
    test.entities.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: docId } }],
      files: [],
    })

    for (const [commit, version] of /** @type {const} */ ([
      [integrated, 4],
      [integrated, 4],
      [remote, 4],
      [integrated, 5],
    ])) {
      test.provider.getBranchHead.mockResolvedValue(commit)
      test.docUpdater.getDocument.mockResolvedValue({ version })
      await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
        name: 'GitConflictError',
        message: 'GitHub deletions were not applied. Retry the sync.',
      })
    }

    const targets = test.editor.deleteUpdate.mock.calls.map(call => call[4])
    expect(targets[0]).toEqual({
      docId,
      version: 4,
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
      ),
    })
    expect(targets[1].operationId).toBe(targets[0].operationId)
    expect(new Set(targets.map(target => target.operationId)).size).toBe(3)
    expect(test.resumeActiveDocumentRetirement).toHaveBeenCalledTimes(4)
    expect(test.resumeActiveDocumentRetirement).toHaveBeenCalledWith(projectId)
    expect(
      test.resumeActiveDocumentRetirement.mock.invocationCallOrder[0]
    ).toBeLessThan(test.history.latestVersion.mock.invocationCallOrder[0])
  })

  it('does not mark an unrelated edit during import as published to GitHub', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    const write = async () => {
      test.history.latestVersion.mockResolvedValue(3)
      test.history.getProjectSnapshot.mockResolvedValue({
        'main.tex': { data: { hash: 'merged-blob' } },
        'unrelated.tex': { data: { hash: 'new-local-blob' } },
      })
      return { entityType: 'file' }
    }
    test.editor._mergeUpdate.mockImplementation(write)
    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      name: 'GitConflictError',
      message: 'Overleaf changed during GitHub sync. Retry the sync.',
    })
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it('does not advance sync over an edit to a document that was just imported', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.editor._mergeUpdate.mockImplementation(async () => {
      test.history.latestVersion.mockResolvedValue(3)
      test.history.getProjectSnapshot.mockResolvedValue({
        'main.tex': {
          data: { content: 'merged source plus an editor change' },
        },
      })
      return {
        entityType: 'doc',
        contentHash: '624c80da096860220d6f7d2f9fa221805d9344cf',
      }
    })

    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      name: 'GitConflictError',
      message: 'Overleaf changed during GitHub sync. Retry the sync.',
    })
    expect(test.store.updateProjectState).not.toHaveBeenCalled()
  })

  it.each([
    ['café\nnext\n', '7c195403d8c23b25aee6cc4ac1348dbc9184b32b'],
    ['', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
  ])(
    'accepts normalized editable contents %j',
    async (content, contentHash) => {
      test.store.getProjectState.mockResolvedValue(conflict)
      test.provider.getBranchHead.mockResolvedValue(integrated)
      test.provider.isCommitIncluded.mockResolvedValue(true)
      test.editor._mergeUpdate.mockImplementation(async () => {
        test.history.latestVersion.mockResolvedValue(3)
        test.history.getProjectSnapshot.mockResolvedValue({
          'main.tex': { data: { content } },
        })
        return { entityType: 'doc', contentHash }
      })

      await test.doGitMerge(userId, projectId, '', true)
      expect(test.store.updateProjectState).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          lastSyncVersion: 3,
          lastSyncCommit: integrated,
        })
      )
    }
  )

  it('does not stage text already identical to the GitHub blob', async () => {
    const content = 'unchanged editable text'
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.history.getProjectSnapshot.mockResolvedValue({
      'main.tex': { data: { content } },
    })
    test.provider.listBlobsAtCommit.mockResolvedValue([
      { path: 'main.tex', sha: '8daf811db443a968194266dd534e80a86b3960b5' },
    ])

    await test.doGitMerge(userId, projectId, '', true)
    expect(test.provider.getBlobStream).not.toHaveBeenCalled()
    expect(test.editor._mergeUpdate).not.toHaveBeenCalled()
    expect(test.store.updateProjectState).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ lastSyncCommit: integrated })
    )
  })

  it('captures the editable document version before the final history check', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.entities.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: docId } }],
      files: [],
    })
    await test.doGitMerge(userId, projectId, '', true)
    expect(test.docUpdater.getDocument).toHaveBeenCalledExactlyOnceWith(
      projectId,
      docId,
      -1
    )
    expect(
      test.docUpdater.getDocument.mock.invocationCallOrder[0]
    ).toBeLessThan(test.history.latestVersion.mock.invocationCallOrder[1])
    expect(test.editor._mergeUpdate).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      '/main.tex',
      test.localBlob,
      'github',
      { docId, version: 0 }
    )
  })

  it('forwards the immutable Git blob to guarded binary conversion and reuses the action on retry', async () => {
    const blobHash = 'b'.repeat(40)
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    test.provider.listBlobsAtCommit.mockResolvedValue([
      { path: 'main.tex', sha: blobHash },
    ])
    test.entities.getAllEntities.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: docId } }],
      files: [],
    })
    const upsertFileWithPath = vi.fn().mockResolvedValue({
      file: { _id: '507f1f77bcf86cd799439014', hash: blobHash, rev: 0 },
      folder: { _id: '507f1f77bcf86cd799439015' },
    })
    vi.doMock(
      '../../../../app/src/Features/Editor/EditorController.mjs',
      () => ({
        default: { promises: { upsertFileWithPath } },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Uploads/FileTypeManager.mjs',
      () => ({
        default: { promises: { getType: async () => ({ binary: true }) } },
      })
    )
    const { default: merger } =
      /** @type {typeof import('../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs')} */ (
        await vi.importActual(
          '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs'
        )
      )
    /** @type {typeof merger.promises._mergeUpdate} */
    const apply = async (...args) => {
      const result = await merger.promises._mergeUpdate(...args)
      test.history.getProjectSnapshot.mockResolvedValue({
        'main.tex': { data: { hash: blobHash } },
      })
      return result
    }
    test.editor._mergeUpdate.mockImplementation(apply)

    await assert.rejects(test.doGitMerge(userId, projectId, '', true), {
      message:
        'GitHub sync cannot replace a guarded editable document with a binary file.',
    })
    expect(upsertFileWithPath).not.toHaveBeenCalled()

    test.settings.documentupdater.enableRetirementBinaryConversion = true
    const lostReply = new Error('synthetic lost conversion reply')
    upsertFileWithPath.mockRejectedValueOnce(lostReply)
    await assert.rejects(
      test.doGitMerge(userId, projectId, '', true),
      error => error === lostReply
    )
    expect(
      (await test.doGitMerge(userId, projectId, '', true)).mergeStatus
    ).toBe('clean')

    expect(upsertFileWithPath).toHaveBeenCalledTimes(2)
    const action = upsertFileWithPath.mock.calls[0][6]
    expect(action).toEqual({
      docId,
      version: 0,
      sourceCommit: integrated,
      blobHash,
      operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })
    expect(upsertFileWithPath.mock.calls[1][6]).toEqual(action)
  })

  it('passes the captured identity and revision of an existing binary file', async () => {
    test.store.getProjectState.mockResolvedValue(conflict)
    test.provider.getBranchHead.mockResolvedValue(integrated)
    test.provider.isCommitIncluded.mockResolvedValue(true)
    const fileId = '507f1f77bcf86cd799439014'
    test.entities.getAllEntities.mockResolvedValue({
      docs: [],
      files: [{ path: '/main.tex', file: { _id: fileId, rev: 0 } }],
    })

    await test.doGitMerge(userId, projectId, '', true)

    expect(test.editor._mergeUpdate).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      '/main.tex',
      test.localBlob,
      'github',
      { fileId, rev: 0 }
    )
    expect(test.docUpdater.getDocument).not.toHaveBeenCalled()
  })

  it('does not upload a path created and removed before the next sync', async () => {
    test.provider.getBranchHead.mockResolvedValue(prior)
    test.history.getProjectFileTreeDiff.mockResolvedValue([
      { operation: 'added', pathname: 'temporary.tex' },
      { operation: 'removed', pathname: 'temporary.tex' },
    ])
    const result = await test.doGitMerge(userId, projectId, '', false)
    expect(result.mergeStatus).toBe('clean')
    expect(test.history.getProjectFileBuffer).not.toHaveBeenCalled()
    expect(test.provider.updateBranch).not.toHaveBeenCalled()
    expect(test.provider.mergeBranch).not.toHaveBeenCalled()
    expect(test.store.updateProjectState).toHaveBeenCalledWith(projectId, {
      lastSyncVersion: 2,
    })
  })

  it('leaves the remote branch list alone when the merge succeeds', async () => {
    const result = await test.doGitMerge(userId, projectId, '', false)
    expect(result.mergeStatus).toBe('clean')
    expect(test.provider.mergeBranch).toHaveBeenCalledWith(
      token,
      repo,
      branch,
      local
    )
    expect(test.provider.createBranch).not.toHaveBeenCalled()
  })
})
