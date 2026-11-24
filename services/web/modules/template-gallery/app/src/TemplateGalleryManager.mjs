import _ from 'lodash'
import logger from '@overleaf/logger'
import { Readable } from 'stream'
import settings from '@overleaf/settings'
import mongoose from 'mongoose'
import {
  ForbiddenError,
  OError,
} from '../../../../app/src/Features/Errors/Errors.js'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import { Template } from './models/Template.mjs'
import {
  validateTemplateInput,
  renderTemplateHtmlFields,
  uploadTemplateAssets,
  deleteTemplateAssets,
  canUserOverrideTemplate,
  generateTemplateData,
} from './TemplateGalleryHelper.mjs'
import { cleanHtml } from './CleanHtml.mjs'
import { TemplateNameConflictError } from './TemplateErrors.mjs'
import { requirePublishedTemplateVersion } from './PublishedTemplateVersion.mjs'
import { fetchStreamWithResponse } from '@overleaf/fetch-utils'
const TIMEOUT = 30000

async function editTemplate({ templateId, updates }) {
  const editableFields = [
    'name',
    'license',
    'category',
    'language',
    'authorMD',
    'descriptionMD',
  ]
  updates = _.pick(updates, editableFields)
  validateTemplateInput(updates)

  const template = await Template.findById(templateId)
  if (!template) {
    throw new OError('Current template not found, strange...', {
      status: 500,
      templateId,
    })
  }

  if (updates.name) {
    const conflictingTemplate = await Template.findOne(
      { name: updates.name, _id: { $ne: templateId } },
      { owner: true }
    ).exec()
    if (conflictingTemplate) {
      throw new TemplateNameConflictError(String(conflictingTemplate.owner))
    }
  }

  await renderTemplateHtmlFields(updates)
  updates.lastUpdated = new Date()
  Object.assign(template, updates)

  await template.save()

  return updates
}

async function deleteTemplate({ templateId }) {
  const template = await Template.findByIdAndDelete(templateId).exec()
  if (template) {
    await deleteTemplateAssets(template._id, template.version)
  }
}

/**
 * @param {{
 *   projectId: string,
 *   userId: string | null | undefined,
 *   templateSource: {
 *     name: string,
 *     category: string,
 *     descriptionMD: string,
 *     authorMD: string,
 *     license: string,
 *     build: string,
 *     override?: boolean
 *   }
 * }} options
 */
async function createTemplateFromProject({
  projectId,
  userId,
  templateSource,
}) {
  validateTemplateInput(templateSource)
  const sourceProject = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: true,
  })
  if (!userId || sourceProject?.owner_ref?.toString() !== userId) {
    throw new ForbiddenError('Template publication requires project ownership')
  }

  let template = await Template.findOne({ name: templateSource.name }).exec()
  const previousVersion = template?.version
  let newVersion

  if (template) {
    const { canOverride, templateOwnerName } = await canUserOverrideTemplate(
      template,
      userId
    )

    if (!templateSource.override) {
      return {
        conflict: true,
        canOverride,
        templateOwnerName,
      }
    }
    if (!canOverride) {
      throw new ForbiddenError('Template replacement is not authorized')
    }

    const authorizedState = {
      name: template.name,
      owner: template.owner ?? null,
      version: template.version,
    }
    // Allocate a distinct asset key without changing the version readers see.
    const reservation = await Template.findOneAndUpdate(
      { _id: template._id, ...authorizedState },
      [
        {
          $set: {
            reservedVersion: {
              $add: [
                { $max: ['$version', { $ifNull: ['$reservedVersion', 0] }] },
                1,
              ],
            },
          },
        },
      ],
      { new: true, projection: { reservedVersion: 1 } }
    )
      .lean()
      .exec()
    if (
      !reservation ||
      !Number.isSafeInteger(reservation.reservedVersion) ||
      reservation.reservedVersion <= template.version
    ) {
      throw new OError('Template changed before version reservation')
    }
    newVersion = reservation.reservedVersion
    // Mongoose matches this document's _id and the authorized prior state.
    template.$where = authorizedState
  }

  const templateData = await generateTemplateData(projectId, templateSource)

  if (!template) {
    template = new Template(templateData)
    template.owner = userId
  } else {
    Object.assign(template, templateData, {
      version: newVersion,
    })
  }

  try {
    await uploadTemplateAssets(
      projectId,
      userId,
      templateSource.build,
      template
    )
  } catch (error) {
    await deleteTemplateAssets(template._id, template.version)
    throw error
  }
  try {
    await template.save()
  } catch (error) {
    // A definite zero-match can only discard this attempt's unique files.
    // Keep the files when a write error leaves publication uncertain.
    if (error instanceof mongoose.Error.DocumentNotFoundError) {
      await deleteTemplateAssets(template._id, template.version)
    }
    throw error
  }

  if (previousVersion !== undefined) {
    void deleteTemplateAssets(template._id, previousVersion)
  }
  return {
    conflict: false,
    templateId: template._id,
  }
}

async function fetchTemplatePreview({ templateId, version, style }) {
  const publishedVersion = await requirePublishedTemplateVersion(
    templateId,
    version
  )
  const styleParam = style ? `style=${style}` : ''
  const isImage = style === 'preview' || style === 'thumbnail'

  if (style && !isImage) {
    throw new OError('Wrong style', { status: 404, style })
  }

  const pdfUrl = `${settings.apis.filestore.url}/template/${templateId}/v/${publishedVersion}/pdf?${styleParam}`
  const { response } = await fetchStreamWithResponse(pdfUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT),
  })

  if (!response.ok) {
    throw new OError(`Failed to fetch file: ${response.statusText}`, {
      status: 400,
      templateId,
      version,
      styleParam,
    })
  }

  return {
    stream: Readable.from(response.body),
    contentType: isImage ? 'application/octet-stream' : 'application/pdf',
  }
}

async function getTemplatesPageData(category) {
  const categoryName = settings.templateLinks.find(item =>
    item.url.endsWith(`/${category}`)
  )?.name
  const templateLinks = categoryName
    ? undefined
    : settings.templateLinks.filter(link => link.url !== '/templates/all')
  return {
    categoryName,
    templateLinks,
  }
}

async function getTemplate(key, val) {
  if (!key || !val) {
    logger.warn('No key or val provided to getTemplate')
    return null
  }

  const query = { [key]: val }
  const template = await Template.findOne(query).exec()
  if (!template) return null

  return _formatTemplateForPage(template)
}

async function getCategoryTemplates(reqQuery) {
  const { category, by = 'lastUpdated', order = 'desc' } = reqQuery || {}

  const query = category === 'all' ? {} : { category: '/templates/' + category }
  const projection = {
    _id: 1,
    version: 1,
    name: 1,
    author: 1,
    description: 1,
    lastUpdated: 1,
  }
  const allTemplates = await Template.find(query, projection).exec()
  const formattedTemplates = allTemplates.map(_formatTemplateForList)
  const sortedTemplates = _sortTemplates(formattedTemplates, { by, order })

  return {
    totalSize: sortedTemplates.length,
    templates: sortedTemplates,
  }
}

function _sortTemplates(templates, sort) {
  if (
    (sort.by && !['lastUpdated', 'name'].includes(sort.by)) ||
    (sort.order && !['asc', 'desc'].includes(sort.order))
  ) {
    throw new OError('Invalid sorting criteria', { status: 400, sort })
  }
  const sortedTemplates = _.orderBy(
    templates,
    [sort.by || 'lastUpdated'],
    [sort.order || 'desc']
  )
  return sortedTemplates
}

function _formatTemplateForList(template) {
  return {
    id: String(template._id),
    version: String(template.version),
    name: template.name,
    author: cleanHtml(template.author, 'plainText'),
    description: cleanHtml(template.description, 'plainText'),
    lastUpdated: template.lastUpdated,
  }
}

function _formatTemplateForPage(template) {
  return {
    id: template._id.toString(),
    version: template.version.toString(),
    category: template.category,
    name: template.name,
    author: cleanHtml(template.author, 'linksOnly'),
    authorMD: template.authorMD,
    description: cleanHtml(template.description, 'reachText'),
    descriptionMD: template.descriptionMD,
    license: template.license,
    lastUpdated: template.lastUpdated,
    owner: template.owner,
    mainFile: template.mainFile,
    compiler: template.compiler,
    imageName: template.imageName,
    language: template.language,
  }
}

export default {
  createTemplateFromProject,
  editTemplate,
  deleteTemplate,
  getTemplate,
  getCategoryTemplates,
  fetchTemplatePreview,
  getTemplatesPageData,
}
