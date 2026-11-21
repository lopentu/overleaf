import { withProviderHttpsAgent } from '../../../../app/src/Features/Integrations/ProviderHttpsAgent.mjs'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'

import {
  fetchJson,
  fetchJsonWithResponse,
  fetchNothing,
  fetchStream,
  fetchStringWithResponse,
  RequestFailedError,
} from '@overleaf/fetch-utils'

import {
  InvalidTokenError,
  NotFoundError,
  GitConflictError,
  RateLimitError,
  ProviderRequestError,
  PermissionDeniedError,
  AlreadyExistsError,
} from './GitSyncErrors.mjs'

const GITHUB_URL = 'https://github.com'
const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_GRAPHQL = 'https://api.github.com/graphql'
const MAX_PER_PAGE = 100 // GitHub REST API limit

const REQUEST_TIMEOUT_MS = 60 * 1000
const REQUEST_LONG_TIMEOUT_MS = 600 * 1000

const configuredConcurrency = Number(process.env.GITHUB_API_MAX_CONCURRENCY)
const maxConcurrency =
  Number.isSafeInteger(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : 5

function buildHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Overleaf-CEP-GitHub-Sync',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// Error handling
function isRateLimitError(response) {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const retryAfter = response.headers.get('retry-after')

  return remaining === '0' || retryAfter != null
}

function isRepositoryAlreadyExistsError(err) {
  if (err.response?.status !== 422) {
    return false
  }

  let body = err.body

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return false
    }
  }

  const errors = body?.errors

  if (!Array.isArray(errors)) {
    return false
  }

  return errors.some(
    error =>
      error?.resource === 'Repository' &&
      error?.field === 'name' &&
      typeof error?.message === 'string' &&
      error.message.toLowerCase().includes('already exists')
  )
}

/**
 * @param {unknown} err
 * @param {string} operation
 * @returns {never}
 */
function normalizeGitHubError(err, operation) {
  logger.error({ operation }, 'GitHub API request failed')

  if (err instanceof Error && err.name === 'AbortError') {
    throw new ProviderRequestError('GitHub request timed out', { status: 504 })
  }

  if (!(err instanceof RequestFailedError)) {
    throw new ProviderRequestError('Something wrong with GitHub request', {
      status: 500,
    })
  }

  // A fetch error can contain raw provider response text. Classify it here
  // and pass only an operation-independent message and status to callers.
  const status = err.response?.status || 500

  if (status === 401) {
    throw new InvalidTokenError('Invalid token', { status })
  }

  if (status === 404) {
    throw new NotFoundError('Not found', { status })
  }

  if (status === 409) {
    throw new GitConflictError('GitHub reported a conflict', { status })
  }

  if (status === 403 || status === 429) {
    if (isRateLimitError(err.response))
      throw new RateLimitError('Rate limit exceeded', { status: 429 })
    throw new PermissionDeniedError('Permission denied', { status: 403 })
  }

  if (status === 422) {
    if (isRepositoryAlreadyExistsError(err)) {
      throw new AlreadyExistsError('Repository already exists', { status })
    }
  }

  throw new ProviderRequestError('GitHub request failed', { status })
}

// wrappers
function fetchGitHubJson(url, options, operation) {
  return fetchJson(url, withProviderHttpsAgent('github', url, options)).catch(
    err => {
      return normalizeGitHubError(err, operation)
    }
  )
}

function fetchGitHubJsonWithResponse(url, options, operation) {
  return fetchJsonWithResponse(
    url,
    withProviderHttpsAgent('github', url, options)
  ).catch(err => {
    return normalizeGitHubError(err, operation)
  })
}

function fetchGitHubNothing(url, options, operation) {
  return fetchNothing(
    url,
    withProviderHttpsAgent('github', url, options)
  ).catch(err => {
    return normalizeGitHubError(err, operation)
  })
}

function fetchGitHubStream(url, options, operation) {
  return fetchStream(url, withProviderHttpsAgent('github', url, options)).catch(
    err => {
      return normalizeGitHubError(err, operation)
    }
  )
}

// ---------------------- exports ------------------------------- //

// OAuth
function getOAuth2Url() {
  const oAuthUrl = new URL(`${GITHUB_URL}/login/oauth/authorize`)
  oAuthUrl.searchParams.append('client_id', Settings.githubSync.clientID)
  oAuthUrl.searchParams.append('redirect_uri', Settings.githubSync.callbackURL)
  oAuthUrl.searchParams.append('scope', 'read:org,repo,workflow')
  return oAuthUrl
}

function exchangeCodeForToken(code) {
  return fetchGitHubJson(
    `${GITHUB_URL}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: buildHeaders(),
      json: {
        code,
        client_id: Settings.githubSync.clientID,
        client_secret: Settings.githubSync.clientSecret,
        redirect_uri: Settings.githubSync.callbackURL,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'exchangeCodeForToken'
  ).then(r => r.access_token)
}

function revokeToken(token) {
  const { clientID, clientSecret } = Settings.githubSync
  return fetchGitHubNothing(
    `${GITHUB_API_BASE}/applications/${clientID}/token`,
    {
      method: 'DELETE',
      headers: buildHeaders(),
      basicAuth: {
        user: clientID,
        password: clientSecret,
      },
      json: { access_token: token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'revokeToken'
  )
}

// user, orgs, permissions
function getUser(token) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/user`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'getUser'
  ).then(({ id, login, name }) => ({ id, login, name }))
}

/*
async function getUserAndOrgsREST(token) {
  const user = await fetchGitHubJson(`${GITHUB_API_BASE}/user`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'getUserAndOrgs:user')

  const page = 1
  const params = new URLSearchParams({
    page: page.toString(),
    per_page: MAX_PER_PAGE.toString(),
  })
  const orgs = await fetchGitHubJson(`${GITHUB_API_BASE}/user/orgs?${params}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'getUserAndOrgs:orgs')

  return {
    user: user.login,
    orgs: orgs.map(o => o.login)
  }
}
*/

async function getUserAndOrgs(token) {
  const query = `
    query {
      viewer {
        login
        organizations(first: 100) {
          nodes {
            login
            viewerCanCreateRepositories
          }
        }
      }
    }
  `
  const json = await fetchGitHubJson(
    GITHUB_GRAPHQL,
    {
      method: 'POST',
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      json: { query },
    },
    'getUserAndOrgs'
  )

  const viewer = json.data.viewer

  return {
    user: viewer.login,
    orgs: viewer.organizations.nodes.map(o => o.login),
  }
}

function getPushPermission(token, repoFullName) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'getPushPrmission'
  ).then(repo => repo.permissions?.push === true)
}

// repos
/**
 * @param {string} token
 * @param {{name: string, description?: string, isPublic?: boolean, org?: string}} options
 */
function createRepo(token, { name, description, isPublic, org }) {
  const url = org
    ? `${GITHUB_API_BASE}/orgs/${org}/repos`
    : `${GITHUB_API_BASE}/user/repos`
  return fetchGitHubJson(
    url,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        name,
        description,
        private: isPublic !== true,
        auto_init: true,
      },
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'createRepo'
  )
}

async function _listUserReposPage(token, page) {
  const params = new URLSearchParams({
    page: page.toString(),
    per_page: MAX_PER_PAGE.toString(),
  })

  const { json, response } = await fetchGitHubJsonWithResponse(
    `${GITHUB_API_BASE}/user/repos?${params}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    '_listUserReposPage'
  )

  const link = response.headers.get('link') || ''
  const hasNext = link.includes('rel="next"')

  return {
    repos: json.map(r => ({
      name: r.name,
      fullName: r.full_name,
      defaultBranchName: r.default_branch,
    })),
    hasNext,
  }
}

async function listUserRepos(token) {
  let all = []
  let page = 1

  while (true) {
    const { repos, hasNext } = await _listUserReposPage(token, page)
    all = all.concat(repos)
    if (!hasNext) break
    page++
  }

  return all
}

// Git (blobs / trees / commits)
function uploadBlob(token, repoFullName, buffer) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/blobs`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        content: buffer,
        encoding: 'base64',
      },
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'uploadBlob'
  ).then(r => r.sha)
}

function getBlobStream(token, repoFullName, ref, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/')

  return fetchGitHubStream(
    `${GITHUB_API_BASE}/repos/${repoFullName}/contents/${encodedPath}?ref=${ref}`,
    {
      headers: {
        ...buildHeaders(token),
        Accept: 'application/vnd.github.raw',
      },
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'getBlobStream'
  )
}

function createTree(token, repoFullName, entries, base_tree) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/trees`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        tree: entries.map(e => ({
          path: e.path,
          sha: e.sha,
          mode: '100644',
          type: 'blob',
        })),
        ...(base_tree && { base_tree }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'createTree'
  ).then(r => r.sha)
}

/**
 * @param {string} token
 * @param {string} repoFullName
 * @param {{tree: string, message: string, parents?: string[]}} commit
 */
function createCommit(token, repoFullName, { tree, message, parents = [] }) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/commits`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        tree,
        message,
        parents,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'createCommit'
  ).then(r => r.sha)
}

function getCommitTree(token, repoFullName, commit) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/commits/${commit}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'getCommitTree'
  ).then(r => r.tree.sha)
}

function listBlobsAtCommit(token, repoFullName, commit) {
  // can use commit sha here instead of tree sha
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/trees/${commit}?recursive=1`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'listBlobsAtCommit'
  ).then(r => {
    if (r.truncated || !Array.isArray(r.tree)) {
      throw new ProviderRequestError(
        'GitHub returned an incomplete file tree',
        {
          status: 502,
        }
      )
    }
    return r.tree
      .filter(entry => entry.type === 'blob')
      .map(({ sha, path }) => ({ sha, path }))
  })
}

async function listNewCommitsWithStatus(
  token,
  fullName,
  branchName,
  fromCommit
) {
  const url = `${GITHUB_API_BASE}/repos/${fullName}/compare/${fromCommit}...${encodeURIComponent(branchName)}`
  const data = await fetchGitHubJson(
    url,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'listNewCommitsWithStatus'
  )

  const commits = (data.commits || []).map(c => ({
    message: c.commit?.message || '',
    author: {
      name: c.commit?.author?.name || '',
      email: c.commit?.author?.email || '',
      date: c.commit?.author?.date || '',
    },
    sha: c.sha,
  }))
  const diverged = data.status === 'diverged' || data.status === 'behind'
  return { commits, diverged }
}

// branches
function getBranchHead(token, repoFullName, branchName) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(branchName)}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'getBranchHead'
  ).then(r => r.object.sha)
}

function createBranch(token, repoFullName, branchName, sha) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/refs`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        ref: `refs/heads/${branchName}`,
        sha,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'createBranch'
  )
}

function updateBranch(token, repoFullName, branchName, sha, force = false) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(branchName)}`,
    {
      method: 'PATCH',
      headers: buildHeaders(token),
      json: { sha, force },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'updateBranch'
  )
}

function deleteBranch(token, repoFullName, branchName) {
  return fetchGitHubNothing(
    `${GITHUB_API_BASE}/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(branchName)}`,
    {
      method: 'DELETE',
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'deleteBranch'
  )
}

// merge / compare
/**
 * @param {string} token
 * @param {string} repoFullName
 * @param {string} base
 * @param {string} head Commit SHA to merge
 */
async function mergeBranch(token, repoFullName, base, head) {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/merges`
  const options = {
    method: 'POST',
    headers: buildHeaders(token),
    json: { base, head },
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
  }
  const { body, response } = await fetchStringWithResponse(
    url,
    withProviderHttpsAgent('github', url, options)
  ).catch(err => normalizeGitHubError(err, 'mergeBranch'))

  if (response.status === 204) {
    const current = await getBranchHead(token, repoFullName, base)
    if (await isCommitIncluded(token, repoFullName, head, current))
      return current
    throw new GitConflictError(
      'GitHub moved the default branch during the merge'
    )
  }

  if (response.status === 201) {
    try {
      const sha = JSON.parse(body)?.sha
      if (typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)) return sha
    } catch {
      // Keep malformed provider bodies out of user-facing errors and logs.
    }
  }
  throw new ProviderRequestError('GitHub did not return a merge commit', {
    status: 502,
  })
}

/**
 * Whether tip is a descendant of the required commit (or the same commit).
 * @param {string} token
 * @param {string} repoFullName
 * @param {string} required
 * @param {string} tip
 */
async function isCommitIncluded(token, repoFullName, required, tip) {
  if (required === tip) return true
  const result = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/compare/${encodeURIComponent(required)}...${encodeURIComponent(tip)}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'isCommitIncluded'
  )
  return result.status === 'ahead' || result.status === 'identical'
}

function compareCommits(token, repoFullName, from, to) {
  return fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${repoFullName}/compare/${from}...${to}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'compareCommits'
  ).then(r => {
    r.files || []
  })
}

// zip
function getRepoZipball(token, repoFullName, sha) {
  return fetchGitHubStream(
    `${GITHUB_API_BASE}/repos/${repoFullName}/zipball/${sha}`,
    {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
    },
    'getRepoZipball'
  )
}

export default {
  maxConcurrency,
  getOAuth2Url,
  exchangeCodeForToken,
  revokeToken,
  getUser,
  getUserAndOrgs,
  getPushPermission,
  createRepo,
  listUserRepos,
  uploadBlob,
  getBlobStream,
  createTree,
  createCommit,
  getCommitTree,
  listBlobsAtCommit,
  listNewCommitsWithStatus,
  getBranchHead,
  createBranch,
  updateBranch,
  deleteBranch,
  mergeBranch,
  isCommitIncluded,
  compareCommits,
  getRepoZipball,
}
