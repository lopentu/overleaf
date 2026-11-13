import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app/src/UserListController.mjs', () => ({ default: {} }))
vi.mock('../../app/src/ProjectListController.mjs', () => ({
  default: { getProjectsJson: vi.fn() },
}))
vi.mock('../../app/src/AdminToolsController.mjs', () => ({ default: {} }))
vi.mock(
  '../../../../app/src/Features/Authentication/AuthenticationController.mjs',
  () => ({ default: { addEndpointToLoginWhitelist: vi.fn() } })
)
vi.mock(
  '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
  () => ({ default: { ensureUserIsSiteAdmin: vi.fn() } })
)

describe('admin project listing routes', function () {
  beforeEach(async function (ctx) {
    const { default: router } =
      await import('../../app/src/AdminToolsRouter.mjs')
    ctx.authorization = (
      await import('../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs')
    ).default
    ctx.controller = (
      await import('../../app/src/ProjectListController.mjs')
    ).default
    ctx.webRouter = { get: vi.fn(), post: vi.fn(), delete: vi.fn() }
    router.apply(ctx.webRouter)
  })

  for (const path of ['/admin/projects', '/admin/user/:userId/projects']) {
    it(`protects ${path} with the site-admin gate before listing projects`, function (ctx) {
      const route = ctx.webRouter.post.mock.calls.find(([url]) => url === path)
      expect(route).toEqual([
        path,
        ctx.authorization.ensureUserIsSiteAdmin,
        ctx.controller.getProjectsJson,
      ])
    })
  }
})
