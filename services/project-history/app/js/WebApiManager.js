import { callbackify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import logger from '@overleaf/logger'
import Metrics from '@overleaf/metrics'
import Settings from '@overleaf/settings'
import {
  fetchNothing,
  fetchJson,
  RequestFailedError,
} from '@overleaf/fetch-utils'
import { z } from '@overleaf/validation-tools'
import * as Errors from './Errors.js'
import * as RedisManager from './RedisManager.js'

let RETRY_TIMEOUT_MS = 5000

async function getHistoryId(projectId) {
  Metrics.inc('history_id_cache_requests_total')
  const cachedHistoryId =
    await RedisManager.promises.getCachedHistoryId(projectId)
  if (cachedHistoryId) {
    Metrics.inc('history_id_cache_hits_total')
    return cachedHistoryId
  } else {
    const historyId = await getFreshHistoryId(projectId)
    if (historyId != null) {
      await RedisManager.promises.setCachedHistoryId(projectId, historyId)
    }
    return historyId
  }
}

export async function getFreshHistoryId(projectId) {
  const project = await _getProjectDetails(projectId)
  return project.overleaf?.history?.id
}

export async function getDocumentRetirement({
  projectId,
  docId,
  operationId,
  version,
}) {
  return await fetchJson(
    `${Settings.apis.web.url}/project/${projectId}/doc/${docId}/retirement/${operationId}/lookup`,
    {
      method: 'POST',
      json: { version },
      basicAuth: {
        user: Settings.apis.web.user,
        password: Settings.apis.web.pass,
      },
      signal: AbortSignal.timeout(5000),
    }
  )
}

const resyncReservationClaim = z.object({
  status: z.enum(['claimed', 'blocked', 'held']),
})
const resyncReservationRelease = z.object({
  status: z.enum(['released', 'missing', 'conflict']),
})

async function claimResyncReservation(projectId, token) {
  return resyncReservationClaim.parse(
    await requestResyncReservation(projectId, 'claim', { token })
  )
}

async function releaseResyncReservation(projectId, token) {
  return resyncReservationRelease.parse(
    await requestResyncReservation(projectId, 'release', { token })
  )
}

async function requestResyncReservation(projectId, action, json) {
  return await fetchJson(
    `${Settings.apis.web.url}/project/${projectId}/history/resync-reservation/${action}`,
    {
      method: 'POST',
      json,
      signal: AbortSignal.timeout(5000),
      basicAuth: {
        user: Settings.apis.web.user,
        password: Settings.apis.web.pass,
      },
    }
  )
}

async function requestResync(projectId, opts = {}) {
  try {
    const body = {}
    if (opts.historyRangesMigration) {
      body.historyRangesMigration = opts.historyRangesMigration
    }
    if (opts.resyncProjectStructureOnly) {
      body.resyncProjectStructureOnly = opts.resyncProjectStructureOnly
    }
    if (opts.resyncReservationToken) {
      body.resyncReservationToken = opts.resyncReservationToken
    }
    await fetchNothing(
      `${Settings.apis.web.url}/project/${projectId}/history/resync`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(
          (opts.resyncReservationToken ? 5 : 6) * 60_000
        ),
        basicAuth: {
          user: Settings.apis.web.user,
          password: Settings.apis.web.pass,
        },
        json: body,
      }
    )
  } catch (err) {
    if (err instanceof RequestFailedError && err.response.status === 404) {
      throw new Errors.NotFoundError('got a 404 from web api').withCause(err)
    } else {
      throw err
    }
  }
}

async function _getProjectDetails(projectId, callback) {
  logger.debug({ projectId }, 'getting project details from web')
  let attempts = 0
  while (true) {
    attempts += 1
    try {
      return await fetchJson(
        `${Settings.apis.web.url}/project/${projectId}/details`,
        {
          signal: AbortSignal.timeout(16000),
          basicAuth: {
            user: Settings.apis.web.user,
            password: Settings.apis.web.pass,
          },
        }
      )
    } catch (err) {
      if (err instanceof RequestFailedError && err.response.status === 404) {
        throw new Errors.NotFoundError('got a 404 from web api').withCause(err)
      } else if (attempts < 2) {
        // retry after 5 seconds
        await setTimeout(RETRY_TIMEOUT_MS)
      } else {
        throw err
      }
    }
  }
}

/**
 * Adjust the retry timeout in tests
 */
export async function setRetryTimeoutMs(timeoutMs) {
  RETRY_TIMEOUT_MS = timeoutMs
}

// EXPORTS

const getHistoryIdCb = callbackify(getHistoryId)
const requestResyncCb = callbackify(requestResync)

export { getHistoryIdCb as getHistoryId, requestResyncCb as requestResync }

export const promises = {
  getHistoryId,
  requestResync,
  claimResyncReservation,
  releaseResyncReservation,
}
