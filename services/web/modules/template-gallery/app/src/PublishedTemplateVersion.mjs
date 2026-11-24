import Errors from '../../../../app/src/Features/Errors/Errors.js'
import { Template } from './models/Template.mjs'

/**
 * Keep reserved but unpublished filestore versions out of the Web read paths.
 * @param {unknown} templateId
 * @param {unknown} requestedVersion
 * @returns {Promise<number>}
 */
export async function requirePublishedTemplateVersion(
  templateId,
  requestedVersion
) {
  if (
    typeof templateId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(templateId) ||
    typeof requestedVersion !== 'string' ||
    !/^[1-9][0-9]*$/.test(requestedVersion)
  ) {
    throw new Errors.NotFoundError('Invalid template version', { status: 404 })
  }
  const version = Number(requestedVersion)
  if (!Number.isSafeInteger(version)) {
    throw new Errors.NotFoundError('Invalid template version', { status: 404 })
  }

  const published = await Template.findOne(
    { _id: templateId, version },
    { version: 1 }
  )
    .lean()
    .exec()
  if (!published) {
    throw new Errors.NotFoundError('Template version is not published', {
      status: 404,
    })
  }
  return version
}
