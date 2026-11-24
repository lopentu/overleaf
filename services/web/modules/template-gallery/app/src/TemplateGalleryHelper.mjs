import { marked } from 'marked'
import request from 'request'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'
import ProjectZipStreamManager from '../../../../app/src/Features/Downloads/ProjectZipStreamManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import AdminAuthorizationHelper from '../../../../app/src/Features/Helpers/AdminAuthorizationHelper.mjs'
import { fetchStreamWithResponse } from '@overleaf/fetch-utils'
import { RecompileRequiredError } from './TemplateErrors.mjs'
import { cleanHtml } from './CleanHtml.mjs'

const TIMEOUT = 30000

const MAX_PROJECT_NAME_LENGTH = 150
const MAX_FORM_INPUT_LENGTH = 512
const MAX_TEMPLATE_DESCRIPTION_LENGTH = 4096

// Configure marked for CommonMark-only parsing
marked.setOptions({
  gfm: false,
  breaks: false,
  headerIds: false,
  mangle: false,
})

marked.use({
  renderer: {
    html: () => '', // strips any HTML tags
  },
})

function _createZipStreamForProjectAsync(projectId) {
  return new Promise((resolve, reject) => {
    ProjectZipStreamManager.createZipStreamForProject(
      projectId,
      false,
      null,
      (err, archive) => {
        if (err) {
          return reject(err)
        }
        archive.on('error', err => reject(err))
        resolve(archive)
      }
    )
  })
}

export function validateTemplateInput({
  name,
  descriptionMD,
  authorMD,
  license,
}) {
  if (name?.length > MAX_PROJECT_NAME_LENGTH) {
    throw new Errors.InvalidNameError(
      `Template title exceeds the maximum length of ${MAX_PROJECT_NAME_LENGTH} characters.`
    )
  }
  if (descriptionMD?.length > MAX_TEMPLATE_DESCRIPTION_LENGTH) {
    throw new Errors.InvalidNameError(
      `Template description exceeds the maximum length of ${MAX_TEMPLATE_DESCRIPTION_LENGTH} characters.`
    )
  }
  if (authorMD?.length > MAX_FORM_INPUT_LENGTH) {
    throw new Errors.InvalidNameError('Author name is too long.')
  }
  if (license?.length > MAX_FORM_INPUT_LENGTH) {
    throw new Errors.InvalidNameError('License name is too long.')
  }
}

export async function canUserOverrideTemplate(template, userId) {
  let templateOwnerId = template.owner
  let templateOwnerName = 'you'
  let userIsOwner = true
  let userIsAdmin
  if (templateOwnerId != userId) {
    userIsOwner = false
    try {
      const user = await UserGetter.promises.getUser(userId, { isAdmin: 1 })
      userIsAdmin = AdminAuthorizationHelper.hasAdminAccess(user)
    } catch (error) {
      logger.error(
        { error, userId },
        'Logged in user does not exist, strange...'
      )
      userIsAdmin = false
    }
    templateOwnerName = (await getUserName(templateOwnerId)) || 'unknown'
  }
  const canOverride =
    userIsOwner || userIsAdmin || settings.templates?.user_id === userId
  return { canOverride, templateOwnerName }
}

export async function getUserName(userId) {
  try {
    const user = await UserGetter.promises.getUser(userId, {
      first_name: 1,
      last_name: 1,
    })
    return ((user?.first_name || '') + ' ' + (user?.last_name || '')).trim()
  } catch (error) {
    return 'unknown'
  }
}

export async function generateTemplateData(
  projectId,
  { descriptionMD, authorMD, category, license, name }
) {
  try {
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)

    const project = await ProjectGetter.promises.getProject(projectId, {
      imageName: true,
      compiler: true,
      spellCheckLanguage: true,
      rootDoc_id: true,
      rootFolder: true,
    })

    const { path } = await ProjectLocator.promises.findRootDoc({ project })
    const mainFile = path.fileSystem.replace(/^\/+/, '')
    const template = {
      name,
      category,
      authorMD,
      descriptionMD,
      license,
      mainFile,
      compiler: project.compiler,
      imageName: project.imageName,
      language: project.spellCheckLanguage,
      lastUpdated: new Date(),
    }

    await renderTemplateHtmlFields(template)
    return template
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to retrieve project data')
    throw error
  }
}

export async function uploadTemplateAssets(projectId, userId, build, template) {
  let zipStream, pdfStream
  try {
    ;[zipStream, pdfStream] = await Promise.all([
      _createZipStreamForProjectAsync(projectId),
      ClsiManager.promises.getOutputFileStream(
        projectId,
        userId,
        undefined,
        build,
        'output.pdf'
      ),
    ])
  } catch (error) {
    logger.error({ error, projectId }, 'No output.pdf?')
    throw new RecompileRequiredError()
  }
  const templateUrl = `${settings.apis.filestore.url}/template/${template._id}/v/${template.version}`
  const [zip, pdf] = await Promise.allSettled([
    fetchStreamWithResponse(`${templateUrl}/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: zipStream,
      signal: AbortSignal.timeout(TIMEOUT),
    }),
    fetchStreamWithResponse(`${templateUrl}/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfStream,
      signal: AbortSignal.timeout(TIMEOUT),
    }),
  ])
  const zipStatus =
    zip.status === 'fulfilled' ? zip.value.response.status : null
  const pdfStatus =
    pdf.status === 'fulfilled' ? pdf.value.response.status : null
  if (zipStatus !== 200 || pdfStatus !== 200) {
    logger.error({ zipStatus, pdfStatus }, 'Template upload failed')
    throw new RecompileRequiredError()
  }
}

/**
 * @param {{ toString(): string } | string} templateId
 * @param {number} version
 */
export async function deleteTemplateAssets(templateId, version) {
  const baseUrl = settings.apis.filestore.url
  await Promise.all(
    ['zip', 'pdf'].map(
      file =>
        new Promise(resolve => {
          request(
            {
              method: 'DELETE',
              uri: `${baseUrl}/template/${templateId}/v/${version}/${file}`,
              timeout: TIMEOUT,
            },
            (err, response) => {
              const statusCode = response?.statusCode
              if (
                err ||
                !statusCode ||
                (statusCode >= 300 && statusCode !== 404)
              ) {
                logger.warn(
                  { err, templateId, version, file, statusCode },
                  'Failed to delete template asset'
                )
              }
              resolve(undefined)
            }
          )
        })
    )
  )
}

export function renderTemplateHtmlFields(updates) {
  if (updates.descriptionMD !== undefined) {
    const descriptionRawHTML = marked.parse(updates.descriptionMD)
    updates.description = cleanHtml(descriptionRawHTML, 'reachText')
  }
  if (updates.authorMD !== undefined) {
    const authorRawHTML = marked.parse(updates.authorMD)
    updates.author = cleanHtml(authorRawHTML, 'linksOnly')
  }
}
