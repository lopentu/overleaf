import fsPromises from 'node:fs/promises'
import { normalize } from 'node:path/posix'
import pLimit from 'p-limit'
import { createHash, randomUUID } from 'node:crypto'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import SyncStateManager from './SyncStateManager.mjs'
import api from './GitHubApiClient.mjs'
import HistoryManager from './HistoryManager.mjs'
import { GitConflictError, GitNotLinkedError } from './GitSyncErrors.mjs'
import TokenManager from './TokenManager.mjs'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import UpdateMerger from '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'

const SyncLockManager = LockManager.withTimeout(300) // 5 min

/**
 * @param {string} userId
 * @param {string} projectId
 * @param {string} message
 * @param {boolean} [claimConflictIsResolved]
 */
export async function doGitMerge(
  userId,
  projectId,
  message,
  claimConflictIsResolved
) {
  return await SyncLockManager.promises.runWithLock('gitSync', projectId, () =>
    doGitMergeWithoutLock(userId, projectId, message, claimConflictIsResolved)
  )
}

async function doGitMergeWithoutLock(
  userId,
  projectId,
  message,
  claimConflictIsResolved
) {
  const projectSyncState = await SyncStateManager.getProjectState(projectId)
  if (!projectSyncState) throw new GitNotLinkedError(projectId)
  const { repoFullName, defaultBranchName, mergeStatus, unmergedBranchName } =
    projectSyncState

  // do nothing if conflict is not yet resolved and 'Sync' button is pushed
  // do nothing if conflict is already resolved and 'I have manually merged' button is pushed
  if (
    (!claimConflictIsResolved && mergeStatus === 'conflict') ||
    (claimConflictIsResolved && mergeStatus !== 'conflict')
  )
    return { mergeStatus, repoFullName, unmergedBranchName }

  const token = await TokenManager.getUserToken(userId)

  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)

  const currentVersion = await HistoryManager.latestVersion(projectId)
  const defaultBranchHead = await api.getBranchHead(
    token,
    repoFullName,
    defaultBranchName
  )

  let newUnmergedBranchName

  switch (mergeStatus) {
    case 'clean':
      newUnmergedBranchName = await resolveCleanSyncState(
        token,
        userId,
        projectSyncState,
        currentVersion,
        defaultBranchHead,
        message
      )
      break

    case 'conflict':
      newUnmergedBranchName = await resolveConflictSyncState(
        token,
        userId,
        projectSyncState,
        currentVersion,
        defaultBranchHead
      )
      break

    case 'diverged':
      newUnmergedBranchName = await resolveDetachedSyncState(
        token,
        userId,
        projectSyncState,
        currentVersion,
        defaultBranchHead,
        message
      )
      break

    default:
      throw new Error('Bad mergeStatus')
  }

  const newMergeStatus = newUnmergedBranchName ? 'conflict' : 'clean'
  return {
    mergeStatus: newMergeStatus,
    repoFullName,
    unmergedBranchName: newUnmergedBranchName,
  }
}

// ----------- clean flow
async function resolveCleanSyncState(
  token,
  userId,
  projectSyncState,
  currentVersion,
  defaultBranchHead,
  message
) {
  const { projectId, repoFullName, defaultBranchName } = projectSyncState

  // No changes in OL
  if (currentVersion === projectSyncState.lastSyncVersion) {
    // No changes in GH too: everything is up to date
    if (projectSyncState.lastSyncCommit === defaultBranchHead) return null

    // Need to apply only GH changes
    const lastSyncCommit = defaultBranchHead
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })

    await SyncStateManager.updateProjectState(projectId, {
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }

  // Possible changes in OL
  const olBranchHead = await exportChangesToGit({
    token,
    projectId,
    repoFullName,
    lastSyncVersion: projectSyncState.lastSyncVersion,
    currentVersion,
    message,
    baseCommit: projectSyncState.lastSyncCommit,
  })

  if (!olBranchHead) {
    if (defaultBranchHead === projectSyncState.lastSyncCommit) {
      await SyncStateManager.updateProjectState(projectId, {
        lastSyncVersion: currentVersion,
      })
      return null
    }

    const lastSyncCommit = defaultBranchHead
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }

  let conflictBase = defaultBranchHead
  if (defaultBranchHead === projectSyncState.lastSyncCommit) {
    let fastForwarded = false
    try {
      await api.updateBranch(
        token,
        repoFullName,
        defaultBranchName,
        olBranchHead
      )
      fastForwarded = true
    } catch (err) {
      const isConflict = err instanceof GitConflictError
      const isValidationError = OError.getFullInfo(err)?.status === 422
      if (!isConflict && !isValidationError) throw err
      conflictBase = await api.getBranchHead(
        token,
        repoFullName,
        defaultBranchName
      )
      if (!isConflict && conflictBase === defaultBranchHead) throw err
    }
    if (fastForwarded) {
      const lastSyncCommit = olBranchHead
      const lastSyncVersion = await applyGitSnapshotToProject({
        token,
        userId,
        projectId,
        repoFullName,
        lastSyncCommit,
        expectedVersion: currentVersion,
      })
      await SyncStateManager.updateProjectState(projectId, {
        lastSyncVersion,
        lastSyncCommit,
      })
      return null
    }
  }

  // FF failed, fallback to merge
  const { mergeCommit, tempBranchName, conflict } = await mergeWithTempBranch(
    token,
    repoFullName,
    defaultBranchName,
    olBranchHead
  )

  if (conflict) {
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'conflict',
      lastSyncCommit: conflictBase,
      unmergedBranchName: tempBranchName,
      unmergedBranchHead: olBranchHead,
      conflictVersion: currentVersion,
    })
    return tempBranchName
  } else {
    const lastSyncCommit = mergeCommit
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }
}

// ----------- conflict flow
async function resolveConflictSyncState(
  token,
  userId,
  projectSyncState,
  currentVersion,
  defaultBranchHead
) {
  const {
    projectId,
    repoFullName,
    defaultBranchName,
    conflictVersion,
    unmergedBranchHead,
    unmergedBranchName,
  } = projectSyncState
  if (!unmergedBranchHead || !unmergedBranchName) {
    throw new GitConflictError('GitHub conflict details are missing', {
      status: 409,
    })
  }
  if (
    !(await api.isCommitIncluded(
      token,
      repoFullName,
      unmergedBranchHead,
      defaultBranchHead
    ))
  ) {
    // The button is an intent to continue. The Git history is the evidence
    // that the incoming snapshot includes the saved Overleaf changes.
    return unmergedBranchName
  }

  // No OL changes after manual conflict resolving: pull GH changes only
  if (currentVersion === conflictVersion) {
    const lastSyncCommit = defaultBranchHead
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })

    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
      conflictVersion: null,
      unmergedBranchName: null,
      unmergedBranchHead: null,
    })
    return null
  }

  // OL was changed after manual conflict resolution: need to merge
  const prevOlBranchHead = projectSyncState.unmergedBranchHead

  const newOlBranchHead = await exportChangesToGit({
    token,
    projectId,
    repoFullName,
    lastSyncVersion: conflictVersion,
    currentVersion,
    message: '[Updates in Overleaf during conflict resolution]',
    baseCommit: prevOlBranchHead,
  })

  // Are there really were changes? (e.g.: file created, then removedi: no changes)
  if (!newOlBranchHead) {
    // nothing to push to GH
    const lastSyncCommit = defaultBranchHead
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })

    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
      conflictVersion: null,
      unmergedBranchName: null,
      unmergedBranchHead: null,
    })
    return null
  }

  // merge
  const { mergeCommit, tempBranchName, conflict } = await mergeWithTempBranch(
    token,
    repoFullName,
    defaultBranchName,
    newOlBranchHead
  )

  if (conflict) {
    // conflict must be resolved manually
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'conflict',
      lastSyncCommit: defaultBranchHead,
      unmergedBranchName: tempBranchName,
      unmergedBranchHead: newOlBranchHead,
      conflictVersion: currentVersion,
    })
    return tempBranchName
  } else {
    // merge succeeded
    const lastSyncCommit = mergeCommit
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
      conflictVersion: null,
      unmergedBranchName: null,
      unmergedBranchHead: null,
    })
    return null
  }
}

// ----------- detached flow
// GH repo was force pushed, lastSybc commit possibly anavailable
async function resolveDetachedSyncState(
  token,
  userId,
  projectSyncState,
  currentVersion,
  defaultBranchHead,
  message
) {
  const { projectId, repoFullName, defaultBranchName } = projectSyncState

  // No changes in OL: re-anchor
  if (currentVersion === projectSyncState.lastSyncVersion) {
    const lastSyncCommit = defaultBranchHead
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }

  // Need to compare lastSync OL version (base), current OL version (local) and GH version (remote)
  const baseSnapshot = await HistoryManager.getProjectSnapshot(
    projectId,
    projectSyncState.lastSyncVersion
  )
  const localSnapshot = await HistoryManager.getProjectSnapshot(
    projectId,
    currentVersion
  )
  const remoteBlobMap = await getGitBlobMap(
    token,
    repoFullName,
    defaultBranchHead
  )

  const {
    cleanLocalEntries,
    conflictRemoteEntries,
    conflictLocalEntries,
    conflictBaseEntries,
    hasConflicts,
    hasChanges,
  } = await buildDetachedSyncPlan({
    token,
    repoFullName,
    projectId,
    currentVersion,
    baseSnapshot,
    localSnapshot,
    remoteBlobMap,
  })

  // were any changes introduced in GH?
  if (!hasChanges) {
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion: currentVersion,
      lastSyncCommit: defaultBranchHead,
    })
    return null
  }

  if (!hasConflicts) {
    let lastSyncCommit = defaultBranchHead
    if (cleanLocalEntries.length !== 0) {
      lastSyncCommit = await createCommitFromEntries({
        token,
        repoFullName,
        parentCommit: defaultBranchHead,
        entries: cleanLocalEntries,
        message,
      })
      await api.updateBranch(
        token,
        repoFullName,
        defaultBranchName,
        lastSyncCommit
      )
    }
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }

  // Resolve potential conflict.
  // Build synthetic merge topology:
  //
  //              GH
  //             /
  // H --- B ---
  //             \
  //              OL
  //
  // merge(GH <- OL)
  //
  // B: conflicted files are restored to lastSyncVersion (merge base)
  // GH: in conflicted files remote changes after lastSyncVersion are replayed
  // OL: all changes done in Overleaf after lastSyncVersion are applied

  // Blobs referenced in conflictBaseEntries in theory could be lost, but for GitHub,
  // GitLab and Gitea, blobs from historical commits are normally retained for a
  // very long time so the practical probability of failure is likely close to zero.
  // TODO: anyway, if error is thrown by api.createTree, upload all blobs
  // referenced in conflictBaseEntries and try again

  // H --- B
  const baseCommit = await createCommitFromEntries({
    token,
    repoFullName,
    parentCommit: defaultBranchHead,
    entries: conflictBaseEntries,
    message: '[Overleaf GitSync conflict resolution: restore last sync]',
  })

  // H --- B --- GH
  const remoteChangesCommit = await createCommitFromEntries({
    token,
    repoFullName,
    parentCommit: baseCommit,
    entries: conflictRemoteEntries,
    message: '[Overleaf GitSync conflict resolution: replay repo changes]',
  })

  // H --- B --- OL
  const olChangesCommit = await createCommitFromEntries({
    token,
    repoFullName,
    parentCommit: baseCommit,
    entries: [...cleanLocalEntries, ...conflictLocalEntries],
    message,
  })

  // default branch: --- H --- B --- GH
  await api.updateBranch(
    token,
    repoFullName,
    defaultBranchName,
    remoteChangesCommit
  )

  // temp branch: --- H --- B --- OL
  // merge: default <- temp (GH <- OL)
  const { mergeCommit, tempBranchName, conflict } = await mergeWithTempBranch(
    token,
    repoFullName,
    defaultBranchName,
    olChangesCommit
  )

  // auto-merge succeeded, conflicts in editable files were resolved?
  if (!conflict) {
    const lastSyncCommit = mergeCommit
    const lastSyncVersion = await applyGitSnapshotToProject({
      token,
      userId,
      projectId,
      repoFullName,
      lastSyncCommit,
      expectedVersion: currentVersion,
    })
    await SyncStateManager.updateProjectState(projectId, {
      mergeStatus: 'clean',
      lastSyncVersion,
      lastSyncCommit,
    })
    return null
  }

  // merge failed: must manually resolve conflicts
  await SyncStateManager.updateProjectState(projectId, {
    mergeStatus: 'conflict',
    lastSyncCommit: remoteChangesCommit,
    unmergedBranchName: tempBranchName,
    unmergedBranchHead: olChangesCommit,
    conflictVersion: currentVersion,
  })
  return tempBranchName
}

// ----------- Helpers
async function applyGitSnapshotToProject({
  token,
  userId,
  projectId,
  repoFullName,
  lastSyncCommit,
  expectedVersion,
}) {
  const invalidFiles = []
  const updates = []
  const deletions = []

  const historySnapshot = await HistoryManager.getProjectSnapshot(
    projectId,
    expectedVersion
  )
  const blobMap = await getGitBlobMap(token, repoFullName, lastSyncCommit)
  const blobPaths = new Set()

  for (const [path, sha] of Object.entries(blobMap)) {
    const invalid = validateFileName(path)

    if (invalid) {
      invalidFiles.push(invalid.name)
      continue
    }

    blobPaths.add(path)

    const hstSha = historySnapshot[path]?.data?.hash
    // File at path is not changed, do not touch it
    if (hstSha === sha) continue

    updates.push(path)
  }

  for (const path of Object.keys(historySnapshot)) {
    if (blobPaths.has(path)) continue
    deletions.push(path)
  }

  // TODO: do not silently ignore invalidFiles, inform user about them
  if (invalidFiles.length > 0) {
    logger.warn(
      { projectId, invalidFiles },
      'Invalid file paths detected at Git server'
    )
  }
  const limit = pLimit(api.maxConcurrency)
  /** @type {Map<string, string>} */
  const stagedFiles = new Map()
  try {
    await settleUpdates(
      updates.map(path =>
        limit(async () => {
          const stream = await api.getBlobStream(
            token,
            repoFullName,
            lastSyncCommit,
            path
          )
          const fsPath = await UpdateMerger.promises.writeUpdateToDisk(
            projectId,
            stream
          )
          stagedFiles.set(path, fsPath)
        })
      )
    )

    // Complete provider reads before checking the editor version and mutating files.
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
    if ((await HistoryManager.latestVersion(projectId)) !== expectedVersion) {
      throw projectChangedDuringSync()
    }
    if (updates.length === 0 && deletions.length === 0) return expectedVersion

    const localLimit = pLimit(5)
    await settleUpdates(
      [...stagedFiles].map(([path, fsPath]) =>
        localLimit(() =>
          UpdateMerger.promises._mergeUpdate(
            userId,
            projectId,
            '/' + path,
            fsPath,
            'github'
          )
        )
      )
    )
    await settleUpdates(
      deletions.map(path =>
        localLimit(() =>
          UpdateMerger.promises.deleteUpdate(
            userId,
            projectId,
            '/' + path,
            'github'
          )
        )
      )
    )
  } finally {
    const cleanup = await Promise.allSettled(
      [...stagedFiles.values()].map(fsPath => fsPromises.unlink(fsPath))
    )
    const failed = cleanup.filter(result => result.status === 'rejected').length
    if (failed)
      logger.warn({ projectId, failed }, 'GitHub staged file cleanup failed')
  }

  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  const resultVersion = await HistoryManager.latestVersion(projectId)
  const result = await HistoryManager.getProjectSnapshot(
    projectId,
    resultVersion
  )
  // The shared deletion helper logs editor failures. Require the file to be gone.
  if (deletions.some(path => Object.hasOwn(result, path))) {
    throw new GitConflictError(
      'GitHub deletions were not applied. Retry the sync.',
      {
        status: 409,
      }
    )
  }
  const applied = new Set([...updates, ...deletions])
  const paths = new Set([
    ...Object.keys(historySnapshot),
    ...Object.keys(result),
  ])

  // Do not include unrelated local changes in the recorded GitHub sync point.
  for (const path of paths) {
    if (
      !applied.has(path) &&
      (Object.hasOwn(historySnapshot, path) !== Object.hasOwn(result, path) ||
        getEntryHash(historySnapshot[path]) !== getEntryHash(result[path]))
    ) {
      throw projectChangedDuringSync()
    }
  }
  return resultVersion
}

function projectChangedDuringSync() {
  return new GitConflictError(
    'Overleaf changed during GitHub sync. Retry the sync.',
    {
      status: 409,
    }
  )
}

/** @param {Promise<unknown>[]} work */
async function settleUpdates(work) {
  const results = await Promise.allSettled(work)
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

async function buildDetachedSyncPlan({
  token,
  repoFullName,
  projectId,
  currentVersion,
  baseSnapshot,
  localSnapshot,
  remoteBlobMap,
}) {
  const cleanLocalEntries = []
  const conflictRemoteEntries = []
  const conflictLocalEntries = []
  const conflictBaseEntries = []

  let hasConflicts = false
  let hasChanges = false

  const allPaths = new Set([
    ...Object.keys(baseSnapshot || {}),
    ...Object.keys(localSnapshot || {}),
    ...Object.keys(remoteBlobMap || {}),
  ])

  for (const path of allPaths) {
    const baseHash = getEntryHash(baseSnapshot[path])
    const localHash = getEntryHash(localSnapshot[path])
    const remoteHash = remoteBlobMap[path] || null

    // currentVesion of the file is not known to git server, uploading blob
    if (localHash && localHash !== baseHash && localHash !== remoteHash) {
      let buffer
      if (localSnapshot[path].data?.content) {
        buffer = Buffer.from(localSnapshot[path].data.content, 'utf8').toString(
          'base64'
        )
      } else {
        buffer = await HistoryManager.getProjectFileBuffer(
          projectId,
          currentVersion,
          path
        )
      }
      await api.uploadBlob(token, repoFullName, buffer)
    }

    // OL == GH, do nothing
    if (localHash === remoteHash) continue

    if (baseHash === remoteHash) {
      // changed in OL
      hasChanges = true
      cleanLocalEntries.push({ path, sha: localHash })
      continue
    }

    if (baseHash === localHash) {
      // changed in GH
      hasChanges = true
      continue
    }
    // conflict: changed both in GH and OL
    hasChanges = true
    hasConflicts = true

    conflictRemoteEntries.push({ path, sha: remoteHash })
    conflictLocalEntries.push({ path, sha: localHash })
    conflictBaseEntries.push({ path, sha: baseHash })
  }
  return {
    cleanLocalEntries,
    conflictRemoteEntries,
    conflictLocalEntries,
    conflictBaseEntries,
    hasConflicts,
    hasChanges,
  }
}

async function createCommitFromEntries({
  token,
  repoFullName,
  parentCommit,
  entries,
  message,
}) {
  const baseTree = await api.getCommitTree(token, repoFullName, parentCommit)
  const newTree = await api.createTree(token, repoFullName, entries, baseTree)
  return api.createCommit(token, repoFullName, {
    tree: newTree,
    parents: [parentCommit],
    message,
  })
}

/**
 * @param {string} token
 * @param {string} repoFullName
 * @param {string} branchName
 * @param {string} updateCommit
 */
async function mergeWithTempBranch(
  token,
  repoFullName,
  branchName,
  updateCommit
) {
  try {
    // GitHub accepts a commit SHA. Only a conflict needs a durable ref for the
    // user's merge, so success and unrelated failures leave no extra branch.
    const mergeCommit = await api.mergeBranch(
      token,
      repoFullName,
      branchName,
      updateCommit
    )
    return { conflict: false, mergeCommit }
  } catch (err) {
    if (!(err instanceof GitConflictError)) throw err
    const tempBranchName = generateBranchName()
    await api.createBranch(token, repoFullName, tempBranchName, updateCommit)
    return { conflict: true, tempBranchName }
  }
}

async function exportChangesToGit({
  token,
  projectId,
  repoFullName,
  lastSyncVersion,
  currentVersion,
  message,
  baseCommit,
}) {
  const diff = await HistoryManager.getProjectFileTreeDiff(
    projectId,
    lastSyncVersion,
    currentVersion
  )

  const changed = new Set()
  for (const item of diff) {
    if (['added', 'edited', 'removed', 'renamed'].includes(item.operation)) {
      changed.add(item.pathname)
      if (item.operation === 'renamed') changed.add(item.newPathname)
    }
  }
  if (changed.size === 0) return null

  const [base, current] = await Promise.all([
    HistoryManager.getPathsAtVersion(projectId, lastSyncVersion),
    HistoryManager.getPathsAtVersion(projectId, currentVersion),
  ])
  const basePaths = new Set(base.paths)
  const currentPaths = new Set(current.paths)
  const upsertPaths = [...changed].filter(path => currentPaths.has(path))
  const deletePaths = [...changed].filter(
    path => basePaths.has(path) && !currentPaths.has(path)
  )
  if (deletePaths.length === 0 && upsertPaths.length === 0) return null

  const limit = pLimit(api.maxConcurrency)
  const upsertEntries = await Promise.all(
    upsertPaths.map(path =>
      limit(async () => {
        const buffer = await HistoryManager.getProjectFileBuffer(
          projectId,
          currentVersion,
          path
        )
        const sha = await api.uploadBlob(token, repoFullName, buffer)
        return { path, sha }
      })
    )
  )

  const deleteEntries = deletePaths.map(path => ({ path, sha: null }))
  const entries = [...deleteEntries, ...upsertEntries]

  const newCommit = await createCommitFromEntries({
    token,
    repoFullName,
    parentCommit: baseCommit,
    entries,
    message,
  })

  return newCommit
}

function generateBranchName() {
  const date = new Date().toISOString().slice(0, 10)
  return `overleaf-${date}-${randomUUID()}`
}

async function getGitBlobMap(token, repoFullName, commit) {
  const blobEntries = await api.listBlobsAtCommit(token, repoFullName, commit)
  return Object.fromEntries(blobEntries.map(({ path, sha }) => [path, sha]))
}

function getEntryHash(entry) {
  if (!entry?.data) return null
  return entry.data.hash || gitBlobShaFromString(entry.data.content)
}

function gitBlobShaFromString(str) {
  if (!str) return null
  const content = Buffer.from(str, 'utf8')
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  const store = Buffer.concat([header, content])

  return createHash('sha1').update(store).digest('hex')
}

function validateFileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0'))
    return { name }

  const normalized = normalize(name)

  if (
    normalized !== name ||
    normalized.startsWith('/') ||
    normalized.startsWith('../')
  )
    return { name }

  return null
}
