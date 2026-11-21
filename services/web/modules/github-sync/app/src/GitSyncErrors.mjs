import OError from '@overleaf/o-error'

class GitNotLinkedError extends OError {
  constructor(projectId) {
    super('git server is not linked to project', { projectId })
  }
}

class GitHubExportIncompleteError extends OError {
  /**
   * @param {string} projectId
   * @param {string} repoFullName
   * @param {unknown} cause
   */
  constructor(projectId, repoFullName, cause) {
    super(
      `Export to GitHub could not be completed. Check the new repository ${repoFullName} on GitHub before retrying.`,
      { projectId, repoFullName },
      cause
    )
    this.repoFullName = repoFullName
  }
}

class AlreadyExistsError extends OError {}
class GitConflictError extends OError {}
class InvalidTokenError extends OError {}
class NotFoundError extends OError {}
class PermissionDeniedError extends OError {}
class RateLimitError extends OError {}
class ProviderRequestError extends OError {}

export {
  AlreadyExistsError,
  GitHubExportIncompleteError,
  GitNotLinkedError,
  GitConflictError,
  InvalidTokenError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ProviderRequestError,
}
