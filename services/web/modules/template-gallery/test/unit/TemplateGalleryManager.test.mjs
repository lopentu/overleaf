import { rejects } from 'node:assert/strict'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { fetchStreamWithResponse } from '@overleaf/fetch-utils'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import TemplatesManager from '../../../../app/src/Features/Templates/TemplatesManager.mjs'
import TemplateGalleryManager from '../../app/src/TemplateGalleryManager.mjs'
import {
  canUserOverrideTemplate,
  deleteTemplateAssets,
  generateTemplateData,
  uploadTemplateAssets,
} from '../../app/src/TemplateGalleryHelper.mjs'
import { Template } from '../../app/src/models/Template.mjs'

vi.mock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: { promises: { getProject: vi.fn() } },
}))
vi.mock('@overleaf/fetch-utils', async importOriginal => ({
  ...(await importOriginal()),
  fetchStreamWithResponse: vi.fn(),
}))
vi.mock('../../app/src/TemplateGalleryHelper.mjs', () => ({
  canUserOverrideTemplate: vi.fn(),
  deleteTemplateAssets: vi.fn(),
  generateTemplateData: vi.fn(),
  renderTemplateHtmlFields: vi.fn(),
  uploadTemplateAssets: vi.fn(),
  validateTemplateInput: vi.fn(),
}))
vi.mock('../../app/src/models/Template.mjs', () => {
  const Template = vi.fn(function (data) {
    Object.assign(this, data)
    this._id = 'new-template-id'
    this.save = vi.fn().mockResolvedValue(undefined)
  })
  Template.findOne = vi.fn()
  Template.findOneAndUpdate = vi.fn()
  Template.findByIdAndDelete = vi.fn()
  return { Template }
})

describe('publishing a gallery template', function () {
  const publisher = 'publisher-id'
  const projectId = 'source-project-id'
  const projectOwner = { owner_ref: { toString: () => publisher } }
  const templateSource = {
    name: 'Template',
    build: 'build-id',
    override: false,
  }

  beforeEach(function () {
    vi.clearAllMocks()
    ProjectGetter.promises.getProject.mockResolvedValue(projectOwner)
    Template.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) })
    Template.findOneAndUpdate.mockImplementation(() => versionQuery(3))
    generateTemplateData.mockResolvedValue({ name: templateSource.name })
  })

  it('publishes a template from a project the publisher owns', async function () {
    const result = await TemplateGalleryManager.createTemplateFromProject({
      projectId,
      userId: publisher,
      templateSource,
    })
    expect(result).toEqual({ conflict: false, templateId: 'new-template-id' })

    expect(ProjectGetter.promises.getProject).toHaveBeenCalledWith(projectId, {
      owner_ref: true,
    })
    expect(uploadTemplateAssets).toHaveBeenCalledWith(
      projectId,
      publisher,
      templateSource.build,
      expect.objectContaining({ owner: publisher })
    )
  })

  it.each([null, { owner_ref: 'another-user' }])(
    'checks source project ownership before preparing a template',
    async function (project) {
      ProjectGetter.promises.getProject.mockResolvedValue(project)

      await rejects(
        () =>
          TemplateGalleryManager.createTemplateFromProject({
            projectId,
            userId: publisher,
            templateSource,
          }),
        Errors.ForbiddenError
      )

      expect(Template.findOne).not.toHaveBeenCalled()
      expect(generateTemplateData).not.toHaveBeenCalled()
      expect(uploadTemplateAssets).not.toHaveBeenCalled()
    }
  )

  it('requires existing template permissions before replacing a same-name entry', async function () {
    const existing = existingTemplate()
    canUserOverrideTemplate.mockResolvedValue({
      canOverride: false,
      templateOwnerName: 'Existing owner',
    })

    await rejects(
      () =>
        TemplateGalleryManager.createTemplateFromProject({
          projectId,
          userId: publisher,
          templateSource: { ...templateSource, override: true },
        }),
      Errors.ForbiddenError
    )

    expect(canUserOverrideTemplate).toHaveBeenCalledWith(existing, publisher)
    expect(Template.findOneAndUpdate).not.toHaveBeenCalled()
    expect(generateTemplateData).not.toHaveBeenCalled()
    expect(uploadTemplateAssets).not.toHaveBeenCalled()
    expect(existing.save).not.toHaveBeenCalled()
  })

  it('binds an authorized replacement to the previously authorized document', async function () {
    const existing = existingTemplate()
    canUserOverrideTemplate.mockResolvedValue({
      canOverride: true,
      templateOwnerName: 'Existing owner',
    })
    existing.save.mockImplementation(function () {
      expect(this.$where).toEqual({
        owner: 'other-owner-id',
        name: templateSource.name,
        version: 2,
      })
      expect(this.version).toBe(3)
    })

    const result = await TemplateGalleryManager.createTemplateFromProject({
      projectId,
      userId: publisher,
      templateSource: { ...templateSource, override: true },
    })
    expect(result).toEqual({ conflict: false, templateId: existing._id })

    expect(canUserOverrideTemplate).toHaveBeenCalledWith(existing, publisher)
    expect(existing.save).toHaveBeenCalledOnce()
    expect(deleteTemplateAssets).toHaveBeenCalledWith(existing._id, 2)
  })

  it('allocates distinct file versions and preserves the winner on a stale save', async function () {
    const first = existingTemplate()
    const second = existingTemplate()
    Template.findOne
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(first) })
      .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(second) })
    canUserOverrideTemplate.mockResolvedValue({
      canOverride: true,
      templateOwnerName: 'Existing owner',
    })
    let reservedVersion = 2
    Template.findOneAndUpdate.mockImplementation((filter, update) => {
      expect(filter).toEqual({
        _id: first._id,
        owner: first.owner,
        name: templateSource.name,
        version: 2,
      })
      expect(update).toEqual([
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
      ])
      return versionQuery(++reservedVersion)
    })
    let activeVersion = 2
    const save = function () {
      if (this.$where.version !== activeVersion) {
        throw new mongoose.Error.DocumentNotFoundError({}, 'Template', 0)
      }
      activeVersion = this.version
    }
    first.save.mockImplementation(save)
    second.save.mockImplementation(save)

    const options = {
      projectId,
      userId: publisher,
      templateSource: { ...templateSource, override: true },
    }
    const results = await Promise.allSettled([
      TemplateGalleryManager.createTemplateFromProject(options),
      TemplateGalleryManager.createTemplateFromProject(options),
    ])

    expect(results.map(result => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    const uploads = uploadTemplateAssets.mock.calls.map(call => call[3].version)
    expect(uploads.sort()).toEqual([3, 4])
    expect(deleteTemplateAssets).toHaveBeenCalledWith(first._id, 2)
    expect(deleteTemplateAssets).toHaveBeenCalledWith(
      first._id,
      activeVersion === 3 ? 4 : 3
    )
    expect(deleteTemplateAssets).not.toHaveBeenCalledWith(
      first._id,
      activeVersion
    )
  })

  it('uses server-owned version metadata when removing a template', async function () {
    const existing = existingTemplate()
    Template.findByIdAndDelete.mockReturnValue({
      exec: vi.fn().mockResolvedValue(existing),
    })
    await TemplateGalleryManager.deleteTemplate({
      templateId: existing._id,
      version: 99,
    })
    expect(Template.findByIdAndDelete).toHaveBeenCalledWith(existing._id)
    expect(deleteTemplateAssets).toHaveBeenCalledWith(existing._id, 2)
  })

  it('keeps the attempt files if a write error leaves the publication result uncertain', async function () {
    const existing = existingTemplate()
    canUserOverrideTemplate.mockResolvedValue({
      canOverride: true,
      templateOwnerName: 'Existing owner',
    })
    const error = new Error('uncertain write')
    existing.save.mockRejectedValue(error)

    await rejects(
      () =>
        TemplateGalleryManager.createTemplateFromProject({
          projectId,
          userId: publisher,
          templateSource: { ...templateSource, override: true },
        }),
      candidate => candidate === error
    )
    expect(uploadTemplateAssets).toHaveBeenCalledOnce()
    expect(deleteTemplateAssets).not.toHaveBeenCalled()
  })

  it('does not read a file version that still awaits publication', async function () {
    Template.findOne.mockReturnValue({
      lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    })
    await rejects(
      () =>
        TemplateGalleryManager.fetchTemplatePreview({
          templateId: '0123456789abcdef01234567',
          version: '4',
        }),
      Errors.NotFoundError
    )
    expect(Template.findOne).toHaveBeenCalledWith(
      { _id: '0123456789abcdef01234567', version: 4 },
      { version: 1 }
    )
    expect(fetchStreamWithResponse).not.toHaveBeenCalled()
  })

  it('refuses to open a new project from a reserved template version', async function () {
    Template.findOne.mockReturnValue({
      lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    })
    await rejects(
      () =>
        TemplatesManager.promises.createProjectFromV1Template(
          undefined,
          'pdflatex',
          undefined,
          '0123456789abcdef01234567',
          'Template',
          '4',
          publisher
        ),
      Errors.NotFoundError
    )
    expect(fetchStreamWithResponse).not.toHaveBeenCalled()
  })

  function versionQuery(reservedVersion) {
    return {
      lean: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ reservedVersion }),
      }),
    }
  }

  function existingTemplate() {
    const document = {
      _id: 'existing-template-id',
      owner: 'other-owner-id',
      name: templateSource.name,
      version: 2,
      save: vi.fn().mockResolvedValue(undefined),
    }
    Template.findOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue(document),
    })
    return document
  }
})
