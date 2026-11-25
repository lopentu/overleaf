// @ts-check
const Settings = require('@overleaf/settings')
const { fetchJson, fetchNothing } = require('@overleaf/fetch-utils')
const { z } = require('@overleaf/validation-tools')

const MAX_HTTP_REQUEST_LENGTH = 5000
const retirementDecision = z.object({
  status: z.enum([
    'prepared',
    'committed',
    'aborted',
    'missing',
    'conflict',
    'unknown',
  ]),
})

/** @param {import('./DocumentWriterSeal').SealOwner} owner */
async function getRetirementDecision({
  projectId,
  docId,
  operationId,
  version,
}) {
  const url = new URL(
    `/project/${projectId}/doc/${docId}/retirement/${operationId}/lookup`,
    Settings.apis.web.url
  )
  return retirementDecision.parse(
    await fetchJson(url, {
      method: 'POST',
      json: { version },
      basicAuth: {
        user: Settings.apis.web.user,
        password: Settings.apis.web.pass,
      },
      signal: AbortSignal.timeout(MAX_HTTP_REQUEST_LENGTH),
    })
  ).status
}

/**
 * @param {string} projectId
 * @param {string} docId
 * @param {string[]} rejectedChangeAuthorIds
 * @param {string | undefined} userId
 * @param {object[]} [previews] sparse change previews from TrackedChangePreview.buildSparseChangePreviews
 */
async function notifyTrackChangesRejected(
  projectId,
  docId,
  rejectedChangeAuthorIds,
  userId,
  previews
) {
  const url = new URL(
    `/project/${projectId}/doc/${docId}/changes/reject`,
    Settings.apis.web.url
  )

  await fetchNothing(url, {
    method: 'POST',
    json: {
      rejectedChangeAuthorIds,
      userId,
      previews,
    },
    basicAuth: {
      user: Settings.apis.web.user,
      password: Settings.apis.web.pass,
    },
    signal: AbortSignal.timeout(MAX_HTTP_REQUEST_LENGTH),
  })
}

module.exports = {
  promises: {
    getRetirementDecision,
    notifyTrackChangesRejected,
  },
}
