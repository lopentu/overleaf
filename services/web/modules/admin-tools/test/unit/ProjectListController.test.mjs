import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../app/src/models/Project.mjs', () => ({
  Project: { find: vi.fn() },
}))
vi.mock('../../../../app/src/models/DeletedProject.mjs', () => ({
  DeletedProject: { find: vi.fn() },
}))
vi.mock('../../../../app/src/models/User.mjs', () => ({ User: {} }))
vi.mock(
  '../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({
    default: {},
  })
)
vi.mock('../../../../app/src/Features/Project/ProjectHelper.mjs', () => ({
  default: { isTrashed: () => false },
}))
vi.mock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: {},
}))
vi.mock('../../../../app/src/Features/Project/ProjectDeleter.mjs', () => ({
  default: {},
}))
vi.mock('../../../../app/src/Features/Project/UserSettingsHelper.mjs', () => ({
  default: {},
}))
vi.mock('../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {},
}))
vi.mock('../../../../app/src/Features/Errors/HttpErrorHandler.mjs', () => ({
  default: {},
}))

describe('admin project JSON query scope', function () {
  beforeEach(async function (ctx) {
    ctx.Project = (
      await import('../../../../app/src/models/Project.mjs')
    ).Project
    ctx.DeletedProject = (
      await import('../../../../app/src/models/DeletedProject.mjs')
    ).DeletedProject
    ctx.controller = (
      await import('../../app/src/ProjectListController.mjs')
    ).default
    ctx.Project.find.mockReturnValue({
      lean: () => ({
        exec: async () => [
          {
            _id: 'active-project',
            name: 'Active project',
            owner_ref: 'owner-a',
            lastUpdated: new Date('2026-01-02'),
          },
        ],
      }),
    })
    ctx.DeletedProject.find.mockReturnValue({
      lean: () => ({
        exec: async () => [
          {
            project: {
              _id: 'deleted-project',
              name: 'Deleted project',
              owner_ref: 'owner-b',
              lastUpdated: new Date('2026-01-01'),
            },
            deleterData: { deletedAt: new Date('2026-01-03') },
          },
        ],
      }),
    })
  })

  it('returns active and deleted projects across owners when no owner is in the route', async function (ctx) {
    const res = { json: vi.fn() }
    await ctx.controller.getProjectsJson({ params: {}, body: {} }, res)

    expect(ctx.Project.find.mock.calls[0][0]).toEqual({})
    expect(ctx.DeletedProject.find.mock.calls[0][0]).toEqual({
      project: { $type: 'object' },
    })
    expect(res.json.mock.calls[0][0]).toMatchObject({
      totalSize: 2,
      projects: [
        { id: 'active-project', owner: 'owner-a', deleted: false },
        { id: 'deleted-project', owner: 'owner-b', deleted: true },
      ],
    })
  })

  it('keeps owner-scoped queries restricted to the route owner', async function (ctx) {
    await ctx.controller.getProjectsJson(
      { params: { userId: 'owner-a' }, body: {} },
      { json: vi.fn() }
    )

    expect(ctx.Project.find.mock.calls[0][0]).toEqual({ owner_ref: 'owner-a' })
    expect(ctx.DeletedProject.find.mock.calls[0][0]).toEqual({
      'project.owner_ref': 'owner-a',
    })
  })

  it('forwards query failures instead of reporting an empty successful list', async function (ctx) {
    const failure = new Error('database unavailable')
    ctx.Project.find.mockReturnValue({
      lean: () => ({
        exec: async () => {
          throw failure
        },
      }),
    })
    const res = { json: vi.fn() }
    const next = vi.fn()
    await ctx.controller.getProjectsJson({ params: {}, body: {} }, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })
})
