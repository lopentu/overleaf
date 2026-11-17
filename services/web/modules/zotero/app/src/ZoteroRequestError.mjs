// @ts-check
import { RequestFailedError } from '@overleaf/fetch-utils'

/**
 * @typedef {'getRequestToken' | 'exchangeRequestTokenForAccessToken' |
 *   'getConnectionStatus' | 'getGroupsForUser' | 'getCollectionsForLibrary' |
 *   '_fetchBibtex' | 'unlinkAccount'} ZoteroOperation
 */

/**
 * External errors may contain key URLs, OAuth headers and response bodies.
 * Copy only closed class/status metadata; never retain the original as a cause.
 * @param {unknown} error
 * @param {ZoteroOperation} operation
 * @returns {{ operation: ZoteroOperation, errorClass: 'AbortError' | 'TimeoutError' | 'RequestFailedError' | 'UnknownError', status: number }}
 */
export function getRequestErrorInfo(error, operation) {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return { operation, errorClass: error.name, status: 504 }
  }
  if (error instanceof RequestFailedError) {
    const status = error.response?.status
    return {
      operation,
      errorClass: 'RequestFailedError',
      status:
        Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : 500,
    }
  }
  return { operation, errorClass: 'UnknownError', status: 500 }
}
