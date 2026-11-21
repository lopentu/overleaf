// @ts-check
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OError from '@overleaf/o-error'
import {
  GitNotLinkedError,
  PermissionDeniedError,
} from '../../app/src/GitSyncErrors.mjs'
import GitHubSyncHandler from '../../app/src/GitHubSyncHandler.mjs'
import GitHubSyncController from '../../app/src/GitHubSyncController.mjs'

const projectId = '507f1f77bcf86cd799439011'
const userId = '507f1f77bcf86cd799439012'
const token = 'synthetic-token'
const repoOptions = {
  name: 'synthetic-project',
  org: 'test-org',
  isPublic: false,
}
const repository = {
  full_name: 'test-org/synthetic-project',
  default_branch: 'trunk',
}
const seedCommit = 'synthetic-seed'
const exportCommit = 'synthetic-export'

/** @typedef {{ repoFullName: string, defaultBranchName: string, mergeStatus: string, lastSyncCommit: string, lastSyncVersion: number }} SyncState */
/** @typedef {{ _id: {toString: () => string}, claimId: string }} ClaimKey */

const mocks = vi.hoisted(() => ({
  getUserToken: vi.fn(),
  flushProjectToMongo: vi.fn(),
  latestVersion: vi.fn(),
  getPathsAtVersion: vi.fn(),
  getProjectFileBuffer: vi.fn(),
  getProjectState: vi.fn(),
  createProjectState: vi.fn(),
  insertExportClaim: vi.fn(),
  deleteExportClaim: vi.fn(),
  getProject: vi.fn(),
  getPushPermission: vi.fn(),
  getUserEmail: vi.fn(),
  createRepo: vi.fn(),
  getBranchHead: vi.fn(),
  uploadBlob: vi.fn(),
  createTree: vi.fn(),
  createCommit: vi.fn(),
  updateBranch: vi.fn(),
  runWithLock: vi.fn(),
}))

vi.mock('../../app/src/TokenManager.mjs', () => ({
  default: { getUserToken: mocks.getUserToken },
}))
vi.mock('../../app/src/HistoryManager.mjs', () => ({ default: mocks }))
vi.mock('../../app/models/githubSyncProjectStates.mjs', () => ({
  GitHubSyncProjectStates: {
    findOne: () => ({
      read: () => ({ lean: () => mocks.getProjectState() }),
    }),
    create: (/** @type {SyncState & {projectId: unknown}} */ record) => {
      const { projectId, ...state } = record
      return mocks.createProjectState(projectId, state)
    },
  },
  GitHubSyncExportClaims: {
    create: mocks.insertExportClaim,
    deleteOne: mocks.deleteExportClaim,
  },
}))
vi.mock('../../app/src/GitMerge.mjs', () => ({ doGitMerge: vi.fn() }))
vi.mock('../../app/src/GitHubApiClient.mjs', () => ({
  default: { ...mocks, maxConcurrency: 2 },
}))
vi.mock(
  '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
  () => ({
    default: { promises: { flushProjectToMongo: mocks.flushProjectToMongo } },
  })
)
vi.mock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: { promises: { getProject: mocks.getProject } },
}))
vi.mock('../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: { promises: { getUserEmail: mocks.getUserEmail } },
}))
vi.mock(
  '../../../../app/src/Features/Uploads/ProjectUploadManager.mjs',
  () => ({
    default: {},
  })
)
vi.mock('../../../../app/src/infrastructure/LockManager.mjs', () => ({
  default: {
    withTimeout: () => ({ promises: { runWithLock: mocks.runWithLock } }),
  },
}))
vi.mock('../../../../app/src/infrastructure/Csrf.mjs', () => ({ default: {} }))

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()

  mocks.getUserToken.mockResolvedValue(token)
  mocks.latestVersion.mockResolvedValue(12)
  mocks.getPathsAtVersion.mockResolvedValue({ paths: ['main.tex'] })
  mocks.getProjectFileBuffer.mockResolvedValue('aGVsbG8=')
  mocks.createRepo.mockResolvedValue(repository)
  mocks.getBranchHead.mockResolvedValue(seedCommit)
  mocks.uploadBlob.mockResolvedValue('synthetic-blob')
  mocks.createTree.mockResolvedValue('synthetic-tree')
  mocks.createCommit.mockResolvedValue(exportCommit)
  mocks.getProject.mockResolvedValue({ owner_ref: userId })

  /** @type {SyncState | null} */
  let state = null
  mocks.getProjectState.mockImplementation(async () => state)
  mocks.createProjectState.mockImplementation(
    async (/** @type {string} */ _id, /** @type {SyncState} */ data) => {
      state = data
      return state
    }
  )

  /** @type {Map<string, string>} */
  const exportClaims = new Map()
  mocks.insertExportClaim.mockImplementation(
    async (/** @type {ClaimKey} */ claim) => {
      const project = claim._id.toString()
      if (exportClaims.has(project)) {
        throw Object.assign(new Error('synthetic duplicate Mongo key'), {
          code: 11000,
        })
      }
      exportClaims.set(project, claim.claimId)
    }
  )
  mocks.deleteExportClaim.mockImplementation(
    async (/** @type {ClaimKey} */ claim) => {
      const project = claim._id.toString()
      if (exportClaims.get(project) !== claim.claimId)
        return { deletedCount: 0 }
      exportClaims.delete(project)
      return { deletedCount: 1 }
    }
  )

  /** @type {Map<string, Promise<unknown>>} */
  const lockQueue = new Map()
  mocks.runWithLock.mockImplementation(
    async (
      /** @type {string} */ namespace,
      /** @type {string} */ id,
      /** @type {() => Promise<unknown>} */ run
    ) => {
      const key = `${namespace}:${id}`
      const previous = lockQueue.get(key) ?? Promise.resolve()
      const current = previous.then(run, run)
      lockQueue.set(key, current)
      return current
    }
  )
})

describe('exporting a project to a new GitHub repository', () => {
  it('checks project ownership before accessing a provider grant or project history', async () => {
    mocks.getProject.mockResolvedValue({ owner_ref: projectId })
    mocks.getUserToken.mockRejectedValue(
      new Error('provider access is disabled in this authorization test')
    )

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      error =>
        error instanceof PermissionDeniedError &&
        /** @type {{ status?: unknown }} */ (OError.getFullInfo(error))
          .status === 403
    )
    expect(mocks.getProject).toHaveBeenCalledExactlyOnceWith(projectId, {
      owner_ref: 1,
    })
    expect(mocks.getUserToken).not.toHaveBeenCalled()
    expect(mocks.flushProjectToMongo).not.toHaveBeenCalled()
    expect(mocks.insertExportClaim).not.toHaveBeenCalled()
    expect(mocks.createRepo).not.toHaveBeenCalled()
  })

  it('leaves GitHub untouched when a project history snapshot cannot be read', async () => {
    const error = new Error('synthetic history lookup failure')
    mocks.getPathsAtVersion.mockRejectedValue(error)

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      received => received === error
    )
    expect(mocks.flushProjectToMongo).toHaveBeenCalledExactlyOnceWith(projectId)
    expect(mocks.getPathsAtVersion).toHaveBeenCalledExactlyOnceWith(
      projectId,
      12
    )
    expect(mocks.createRepo).not.toHaveBeenCalled()
  })

  it('rejects a malformed history path list before creating a GitHub repository', async () => {
    mocks.getPathsAtVersion.mockResolvedValue({ paths: [42] })

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      /Invalid project snapshot/
    )
    expect(mocks.createRepo).not.toHaveBeenCalled()
  })

  it('rejects an invalid history version before creating a GitHub repository', async () => {
    mocks.latestVersion.mockResolvedValue(null)

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      /Invalid project history version/
    )
    expect(mocks.createRepo).not.toHaveBeenCalled()
  })

  it('fast-forwards the seeded branch to the pinned project snapshot', async () => {
    const state = await GitHubSyncHandler.exportProject(
      userId,
      projectId,
      repoOptions
    )

    expect(mocks.createRepo).toHaveBeenCalledExactlyOnceWith(token, repoOptions)
    expect(mocks.getBranchHead).toHaveBeenCalledExactlyOnceWith(
      token,
      repository.full_name,
      'trunk'
    )
    expect(mocks.getProjectFileBuffer).toHaveBeenCalledExactlyOnceWith(
      projectId,
      12,
      'main.tex'
    )
    expect(mocks.createTree).toHaveBeenCalledExactlyOnceWith(
      token,
      repository.full_name,
      [{ path: 'main.tex', sha: 'synthetic-blob' }]
    )
    expect(mocks.createCommit).toHaveBeenCalledExactlyOnceWith(
      token,
      repository.full_name,
      {
        tree: 'synthetic-tree',
        message: 'Initial Overleaf import',
        parents: [seedCommit],
      }
    )
    expect(mocks.updateBranch).toHaveBeenCalledExactlyOnceWith(
      token,
      repository.full_name,
      'trunk',
      exportCommit
    )
    expect(state).toEqual({
      mergeStatus: 'clean',
      repoFullName: repository.full_name,
      defaultBranchName: 'trunk',
      lastSyncCommit: exportCommit,
      lastSyncVersion: 12,
    })
  })

  it('creates at most one repository for simultaneous exports of the same project', async () => {
    const created = Promise.withResolvers()
    const release = Promise.withResolvers()
    mocks.createRepo.mockImplementationOnce(async () => {
      created.resolve(undefined)
      await release.promise
      return repository
    })

    const first = GitHubSyncHandler.exportProject(
      userId,
      projectId,
      repoOptions
    )
    await created.promise
    const second = GitHubSyncHandler.exportProject(userId, projectId, {
      name: 'different-project',
    })
    const results = Promise.allSettled([first, second])
    release.resolve(undefined)

    const [firstResult, secondResult] = await results
    expect(firstResult.status).toBe('fulfilled')
    expect(secondResult).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'Project is already linked to Git server',
      }),
    })
    expect(mocks.createRepo).toHaveBeenCalledTimes(1)
    expect(mocks.runWithLock).toHaveBeenCalledWith(
      'gitSync',
      projectId,
      expect.any(Function)
    )
  })

  it('blocks a second repository creation after the project Redis lease expires', async () => {
    mocks.runWithLock.mockImplementation(
      async (_namespace, _project, /** @type {() => Promise<unknown>} */ run) =>
        run()
    )
    const created = Promise.withResolvers()
    const release = Promise.withResolvers()
    mocks.createRepo.mockImplementationOnce(async () => {
      created.resolve(undefined)
      await release.promise
      return repository
    })

    const first = GitHubSyncHandler.exportProject(
      userId,
      projectId,
      repoOptions
    )
    await created.promise
    try {
      await assert.rejects(
        GitHubSyncHandler.exportProject(userId, projectId, {
          name: 'other-repo',
        }),
        /GitHub export is already in progress/
      )
      expect(mocks.createRepo).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
      await first
    }

    const claim = mocks.insertExportClaim.mock.calls[0][0]
    expect(claim._id.toString()).toBe(projectId)
    expect(mocks.deleteExportClaim).toHaveBeenCalledExactlyOnceWith({
      _id: claim._id,
      claimId: claim.claimId,
    })
  })

  it('rechecks linkage after winning a claim if an earlier export finished during preflight', async () => {
    mocks.getProjectState.mockResolvedValueOnce(null).mockResolvedValueOnce({
      repoFullName: repository.full_name,
    })

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      /Project is already linked/
    )
    expect(mocks.createRepo).not.toHaveBeenCalled()
    expect(mocks.deleteExportClaim).toHaveBeenCalledTimes(1)
  })

  it('releases the claim after a definitive GitHub creation rejection so the user can retry', async () => {
    const rejected = new OError('synthetic provider validation failure', {
      status: 422,
    })
    mocks.createRepo.mockRejectedValueOnce(rejected)

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      error => error === rejected
    )
    expect(mocks.deleteExportClaim).toHaveBeenCalledTimes(1)

    await GitHubSyncHandler.exportProject(userId, projectId, repoOptions)
    expect(mocks.createRepo).toHaveBeenCalledTimes(2)
  })

  it('retains the claim when GitHub may have created the repository before a timeout', async () => {
    const timeout = new OError('synthetic provider timeout', { status: 504 })
    mocks.createRepo.mockRejectedValueOnce(timeout)

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      error => error === timeout
    )
    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, {
        name: 'other-repo',
      }),
      /GitHub export is already in progress/
    )
    expect(mocks.createRepo).toHaveBeenCalledTimes(1)
    expect(mocks.deleteExportClaim).not.toHaveBeenCalled()
  })

  it('retains the claim when the saved link could not be confirmed', async () => {
    const failure = new Error('synthetic link persistence timeout')
    mocks.createProjectState.mockRejectedValueOnce(failure)

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      (/** @type {unknown} */ error) =>
        error instanceof Error && error.cause === failure
    )
    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, {
        name: 'other-repo',
      }),
      /GitHub export is already in progress/
    )
    expect(mocks.createRepo).toHaveBeenCalledTimes(1)
    expect(mocks.deleteExportClaim).not.toHaveBeenCalled()
  })

  it('leaves a concurrently advanced GitHub branch intact and identifies the created repository', async () => {
    const conflict = new Error('synthetic non-fast-forward update')
    mocks.updateBranch.mockImplementation(
      async (
        /** @type {string} */ _token,
        /** @type {string} */ _repo,
        /** @type {string} */ _branch,
        /** @type {string} */ _commit,
        force = false
      ) => {
        if (!force) throw conflict
      }
    )

    await assert.rejects(
      GitHubSyncHandler.exportProject(userId, projectId, repoOptions),
      error => {
        assert.ok(error instanceof Error)
        assert.equal(error.cause, conflict)
        assert.ok(error.message.includes(repository.full_name))
        return true
      }
    )
    expect(mocks.createProjectState).not.toHaveBeenCalled()
    expect(mocks.deleteExportClaim).toHaveBeenCalledTimes(1)
  })

  it('holds the project lock until outstanding blob uploads finish after a failure', async () => {
    const pending = Promise.withResolvers()
    const failed = Promise.withResolvers()
    mocks.getPathsAtVersion.mockResolvedValue({
      paths: ['main.tex', 'other.tex'],
    })
    mocks.uploadBlob
      .mockReturnValueOnce(pending.promise)
      .mockImplementationOnce(async () => {
        failed.resolve(undefined)
        throw new Error('synthetic blob upload failure')
      })
    let exportFinished = false
    const result = GitHubSyncHandler.exportProject(
      userId,
      projectId,
      repoOptions
    )
    const observed = result.catch(() => {
      exportFinished = true
    })

    await failed.promise
    await setImmediate()
    const finishedWhileUploadPending = exportFinished
    pending.resolve('synthetic-blob')
    await observed

    expect(finishedWhileUploadPending).toBe(false)
    expect(mocks.createTree).not.toHaveBeenCalled()
  })

  it('includes the created repository in the export endpoint response after an incomplete export', async () => {
    mocks.updateBranch.mockRejectedValue(new Error('synthetic ref failure'))
    const req = {
      session: { user: { _id: userId } },
      params: { project_id: projectId },
      body: repoOptions,
    }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await GitHubSyncController.exportProject(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledExactlyOnceWith(500)
    expect(res.json).toHaveBeenCalledExactlyOnceWith({
      key: 'github_export_incomplete',
      repoFullName: repository.full_name,
      message: expect.stringContaining(repository.full_name),
    })
  })
})

describe('reading GitHub project state', () => {
  it('reports missing push permission when GitHub denies access', async () => {
    mocks.getProjectState.mockResolvedValue({
      mergeStatus: 'clean',
      repoFullName: repository.full_name,
    })
    mocks.getPushPermission.mockRejectedValue(
      new PermissionDeniedError('Denied')
    )

    const state = await GitHubSyncHandler.getProjectState(userId, projectId)
    expect(state).toMatchObject({ mergeStatus: 'need-permission' })
  })

  it('reports that an unlinked project has no merge overview', async () => {
    await assert.rejects(
      GitHubSyncHandler.getMergeOverview(userId, projectId),
      GitNotLinkedError
    )
  })
})
