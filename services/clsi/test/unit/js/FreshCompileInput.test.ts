import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'

import * as sourceUnit from '../../../app/js/FreshCompileInput.ts'
import { CompileSourcePlanCache } from '../../../app/js/CompileSourcePlanCache.ts'
import { withSourceFixture as fixture } from './SourceInputFixture.ts'

const PROJECT = '1234567890abcdef12345678'
const USER = 'abcdef1234567890abcdef12'
const decoded = Buffer.from(
  ' { "compile" : { "options": { "syncType": "full" }, "resources": [{"path":"nested/文.tex","content":"clean source"}], "rootResourcePath":"nested/文.tex" } }\n'
)

test('a complete real legacy body materializes nested UTF8 source in one lease-owned workspace', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await lease.run(async scope => {
      assert.deepEqual(scope.metadata, {
        projectId: PROJECT,
        userId: USER,
        kind: 'compile',
      })
      assert.ok(Object.isFrozen(scope.metadata))
      const plan = await unit.parseFullSourcePlan(scope, decoded)
      const source = await unit.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.equal(
        await fs.readFile(
          path.join(source.sourceDirectory, 'nested/文.tex'),
          'utf8'
        ),
        'clean source'
      )
      assert.deepEqual(source.resourceList, [{ path: 'nested/文.tex' }])
      assert.equal(path.dirname(source.sourceDirectory), source.sourceRoot)
      assert.notEqual(path.dirname(source.stagingRoot), source.sourceRoot)
      assert.equal((await fs.stat(source.sourceRoot)).mode & 0o777, 0o700)
    })
    await lease.closed
    assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
  })
})
test('incremental requests require the genuine409 resync protocol before creating source or downloading', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      await assert.rejects(
        unit.parseFullSourcePlan(
          scope,
          Buffer.from(
            '{"compile":{"options":{"syncType":"incremental"},"resources":[]}}'
          )
        ),
        { name: 'FilesOutOfSyncError' }
      )
      await assert.rejects(
        unit.parseFullSourcePlan(
          scope,
          Buffer.from(
            '{"compile":{"options":{"syncType":"history-incremental"},"rawChangeOperations":[],"baseHistoryVersion":42,"globalBlobs":[]}}'
          )
        ),
        error =>
          error instanceof Error &&
          error.name === 'MissingUpdatesError' &&
          'info' in error &&
          typeof error.info === 'object' &&
          error.info !== null &&
          'baseHistoryVersion' in error.info &&
          error.info.baseHistoryVersion === -1
      )
      assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
    })
  })
})
test('GET source reconstruction uses the exact last full decoded body despite a later TeX source mutation', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    const first = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await first.run(async scope => {
      const plan = await unit.parseFullSourcePlan(scope, decoded)
      const source = await unit.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      await cache.install(scope, plan)
      await fs.writeFile(
        path.join(source.sourceDirectory, 'nested/文.tex'),
        'TeX modified this'
      )
    })
    const files = await fs.readdir(path.join(root, 'plans'))
    assert.equal(files.length, 1)
    assert.deepEqual(
      await fs.readFile(path.join(root, 'plans', files[0]!)),
      decoded
    )
    const next = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    await next.run(async scope => {
      const plan = await cache.load(scope)
      const source = await unit.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.equal(
        await fs.readFile(
          path.join(source.sourceDirectory, 'nested/文.tex'),
          'utf8'
        ),
        'clean source'
      )
    })
  })
})
test('the existing manager expiry fence skips active work instead of cancelling it to free cache space', async () => {
  await fixture(async (_root, manager) => {
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    const lease = await manager.acquire({
      projectId: PROJECT,
      kind: 'wordcount',
    })
    let cancelled = false
    const work = lease.run(async scope => {
      scope.signal.addEventListener('abort', () => {
        cancelled = true
      })
      entered.resolve()
      await held.promise
    })
    try {
      await entered.promise
      assert.equal(
        typeof Reflect.get(manager, 'tryExpire'),
        'function',
        'existing admission has no noncanceling expiry fence'
      )
      let deleted = false
      const result = await manager.tryExpire(
        { projectId: PROJECT },
        async () => {
          deleted = true
        }
      )
      assert.equal(result, false)
      assert.equal(deleted, false)
      assert.equal(cancelled, false)
      assert.equal(manager.status().active, 1)
    } finally {
      held.resolve()
      await work
    }
  })
})

test('an inactive expiry fence blocks a racing acquire until its actual deletion finishes', async () => {
  await fixture(async (root, manager) => {
    assert.equal(typeof Reflect.get(manager, 'tryExpire'), 'function')
    const file = path.join(root, 'expired-plan')
    await fs.writeFile(file, 'old')
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>()
    const expiry = manager.tryExpire({ projectId: PROJECT }, async () => {
      entered.resolve()
      await held.promise
      await fs.unlink(file)
    })
    try {
      await entered.promise
      await assert.rejects(
        manager.acquire({ projectId: PROJECT, kind: 'compile' }),
        { code: 'PROJECT_BUSY' }
      )
      const other = await manager.acquire({
        projectId: '2234567890abcdef12345678',
        kind: 'compile',
      })
      await other.run(async () => {})
      assert.equal(await fs.readFile(file, 'utf8'), 'old')
    } finally {
      held.resolve()
      assert.equal(await expiry, true)
    }
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    const next = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await next.run(async () => {})
  })
})
test('a failed expiry retains its existing fence until the same owned deletion succeeds', async () => {
  await fixture(async (root, manager) => {
    assert.equal(typeof Reflect.get(manager, 'tryExpire'), 'function')
    const file = path.join(root, 'repair-required')
    await assert.rejects(
      manager.tryExpire({ projectId: PROJECT }, async () => {
        await fs.unlink(file)
      }),
      { code: 'ENOENT' }
    )
    await assert.rejects(
      manager.acquire({ projectId: PROJECT, kind: 'wordcount' }),
      { code: 'PROJECT_BUSY' }
    )
    await fs.writeFile(file, 'repair now available')
    assert.equal(
      await manager.tryExpire({ projectId: PROJECT }, async () => {
        throw new Error('original owned deletion must be retried')
      }),
      true
    )
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
    const lease = await manager.acquire({
      projectId: PROJECT,
      kind: 'wordcount',
    })
    await lease.run(async () => {})
  })
})

test('history-full reuses actual editor operations and returns the reconstructed version', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await lease.run(async scope => {
      const raw = Buffer.from(
        JSON.stringify({
          compile: {
            options: { syncType: 'history-full', historyId: PROJECT },
            rootResourcePath: 'main.tex',
            baseHistoryVersion: 8,
            globalBlobs: [],
            rawSnapshot: { files: { 'main.tex': { content: 'old' } } },
            rawChangeOperations: [
              [{ pathname: 'main.tex', textOperation: [3, '!'] }],
            ],
            resources: [],
          },
        })
      )
      const plan = await unit.parseFullSourcePlan(scope, raw)
      const source = await unit.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.equal(
        await fs.readFile(
          path.join(source.sourceDirectory, 'main.tex'),
          'utf8'
        ),
        'old!'
      )
      assert.equal(source.baseHistoryVersion, 9)
      assert.deepEqual(source.resourceList, [{ path: 'main.tex' }])
    })
  })
})
test('canonical duplicate and file-parent resource collisions fail before host source creation', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      for (const resources of [
        [
          { path: 'a', content: '' },
          { path: 'a', content: '' },
        ],
        [
          { path: 'a', content: '' },
          { path: 'a/child', content: '' },
        ],
        [{ path: 'a/../outside', content: '' }],
        [{ path: '/absolute', content: '' }],
        [{ path: 'a\\b', content: '' }],
      ]) {
        await assert.rejects(
          unit.parseFullSourcePlan(
            scope,
            Buffer.from(
              JSON.stringify({
                compile: { options: { syncType: 'full' }, resources },
              })
            )
          ),
          { code: 'INVALID_SOURCE_REQUEST' }
        )
      }
      assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
    })
  })
})
test('body and implicit-parent counts are bounded before materialization', async () => {
  const unit = sourceUnit
  await fixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      await assert.rejects(
        unit.parseFullSourcePlan(scope, Buffer.alloc(7 * 1024 * 1024 + 1, 32)),
        { code: 'INPUT_LIMIT' }
      )
      const resources = Array.from({ length: 2049 }, (_, index) => ({
        path: `d-${index}/file`,
        content: '',
      }))
      await assert.rejects(
        unit.parseFullSourcePlan(
          scope,
          Buffer.from(
            JSON.stringify({
              compile: { options: { syncType: 'full' }, resources },
            })
          )
        ),
        { code: 'INPUT_LIMIT' }
      )
      assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
    })
  })
})
test('parser failures expose no malformed signed URL or document content', async () => {
  const unit = sourceUnit
  await fixture(async (_root, manager) => {
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      const sentinel = 'synthetic-private-plan-marker-7f9c'
      let caught: unknown
      try {
        await unit.parseFullSourcePlan(
          scope,
          Buffer.from(
            JSON.stringify({
              compile: {
                resources: [
                  { path: 'main.tex', content: 'text', modified: sentinel },
                ],
              },
            })
          )
        )
      } catch (error) {
        caught = error
      }
      assert.ok(caught instanceof Error)
      assert.equal(
        String(caught).includes(sentinel),
        false,
        'source-bearing parser diagnostic escaped'
      )
      assert.equal(
        'cause' in caught,
        false,
        'raw parser failure retained as diagnostic cause'
      )
    })
  })
})

test('host-only expiry never waits for a Docker sweep or makes unrelated admission unavailable', async () => {
  await fixture(async (root, manager, api) => {
    const file = path.join(root, 'expired-host-plan')
    await fs.writeFile(file, 'old')
    const held = Promise.withResolvers<void>()
    api.listHold = held.promise
    const expiry = manager.tryExpire({ projectId: PROJECT }, async () => {
      await fs.unlink(file)
    })
    void expiry.catch(() => {})
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      const other = await manager.acquire({
        projectId: '2234567890abcdef12345678',
        kind: 'compile',
      })
      await other.run(async () => {})
    } finally {
      api.listHold = undefined
      held.resolve()
      await expiry
    }
    await assert.rejects(fs.stat(file), { code: 'ENOENT' })
  })
})

test('BOM-prefixed decoded JSON matches Express decoding while retaining its exact source-plan bytes', async () => {
  await fixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), decoded])
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await lease.run(async scope => {
      const plan = await sourceUnit.parseFullSourcePlan(scope, bytes)
      const source = await sourceUnit.materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.equal(
        await fs.readFile(
          path.join(source.sourceDirectory, 'nested/文.tex'),
          'utf8'
        ),
        'clean source'
      )
      await cache.install(scope, plan)
    })
    assert.deepEqual(
      await fs.readFile(path.join(root, 'plans', `${PROJECT}.${USER}.json`)),
      bytes
    )
  })
})
