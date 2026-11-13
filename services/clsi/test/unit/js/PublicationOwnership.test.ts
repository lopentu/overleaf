import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'vitest'
import * as source from '../../../app/js/FreshCompileInput.ts'
import { CompileSourcePlanCache } from '../../../app/js/CompileSourcePlanCache.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const raw = Buffer.from(
  '{"compile":{"resources":[{"path":"main.tex","content":"source"}]}}'
)

test('one genuine completed source scope owns one reusable sequential filesystem transaction slot', async () => {
  await withSourceFixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      const plan = await source.parseFullSourcePlan(scope, raw)
      const materialized = await source.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.ok(
        'sourceOperationDirectory' in source &&
          typeof source.sourceOperationDirectory === 'function',
        'publisher lacks real source-root authority'
      )
      const operation: unknown = source.sourceOperationDirectory(scope, manager)
      assert.equal(operation, path.dirname(materialized.stagingRoot))
      assert.ok(
        'ownSourceFilesystemTransaction' in source &&
          typeof source.ownSourceFilesystemTransaction === 'function',
        'neutral single slot is unavailable'
      )
      const claim = source.ownSourceFilesystemTransaction
      const release: unknown = claim(scope, async () => {})
      assert.equal(typeof release, 'function')
      assert.throws(() => claim(scope, async () => {}), {
        code: 'INVALID_SOURCE_REQUEST',
      })
      if (typeof release === 'function') release()
      await cache.install(scope, plan)
      const next: unknown = claim(scope, async () => {})
      assert.equal(typeof next, 'function')
      if (typeof next === 'function') next()
    })
  })
})

test('filesystem transaction claims refuse unfinished and closed source authority', async () => {
  await withSourceFixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    let saved:
      | import('../../../app/js/CompilerAdmission.ts').WorkflowScope
      | undefined
    assert.ok(
      'ownSourceFilesystemTransaction' in source &&
        typeof source.ownSourceFilesystemTransaction === 'function',
      'neutral single slot is unavailable'
    )
    const claim = source.ownSourceFilesystemTransaction
    await lease.run(async scope => {
      saved = scope
      assert.throws(() => claim(scope, async () => {}), {
        code: 'INVALID_SOURCE_REQUEST',
      })
      const plan = await source.parseFullSourcePlan(scope, raw)
      await source.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
    })
    assert.ok(saved)
    const closed = saved
    assert.throws(() => claim(closed, async () => {}), {
      code: 'INVALID_SOURCE_REQUEST',
    })
  })
})

test('operation roots cannot be read before full materialization, through another manager, or after closure', async () => {
  await withSourceFixture(async (root, manager) => {
    assert.ok(
      'sourceOperationDirectory' in source &&
        typeof source.sourceOperationDirectory === 'function',
      'publisher lacks real source-root authority'
    )
    const getRoot = source.sourceOperationDirectory
    let saved:
      | import('../../../app/js/CompilerAdmission.ts').WorkflowScope
      | undefined
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      saved = scope
      assert.throws(() => getRoot(scope, manager), {
        code: 'INVALID_SOURCE_REQUEST',
      })
      const plan = await source.parseFullSourcePlan(scope, raw)
      await source.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      await withSourceFixture(async (_otherRoot, other) => {
        assert.throws(() => getRoot(scope, other), {
          code: 'INVALID_SOURCE_REQUEST',
        })
      })
    })
    assert.ok(saved)
    const closed = saved
    assert.throws(() => getRoot(closed, manager), {
      code: 'INVALID_SOURCE_REQUEST',
    })
  })
})
