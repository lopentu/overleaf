const OError = require('@overleaf/o-error')

class NotFoundError extends OError {}
// A 404 returned by the authoritative Web API when loading a document.
class WebDocumentNotFoundError extends NotFoundError {}
class OpRangeNotAvailableError extends OError {}
class ProjectStateChangedError extends OError {}
class ProjectUpdateQueueGuardedError extends OError {}
class DocumentVersionMismatchError extends OError {}
class DeleteMismatchError extends OError {}
class FileTooLargeError extends OError {}
class OTTypeMismatchError extends OError {
  /**
   * @param {OTType} got
   * @param {OTType} want
   */
  constructor(got, want) {
    super('ot type mismatch', { got, want })
  }
}
// when the doc returned by web/API fails validation (e.g. missing/invalid fields)
class DocumentValidationError extends OError {}
class WebApiServerError extends OError {}

module.exports = {
  NotFoundError,
  WebDocumentNotFoundError,
  OpRangeNotAvailableError,
  ProjectStateChangedError,
  ProjectUpdateQueueGuardedError,
  DocumentVersionMismatchError,
  DeleteMismatchError,
  FileTooLargeError,
  OTTypeMismatchError,
  DocumentValidationError,
  WebApiServerError,
}
