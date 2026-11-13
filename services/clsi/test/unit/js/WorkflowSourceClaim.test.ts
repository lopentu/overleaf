import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { withSourceFixture } from './SourceInputFixture.ts'
import type { WorkflowScope } from '../../../app/js/CompilerAdmission.ts'
const PROJECT = '1234567890abcdef12345678'
test('a single precreation cleanup claim binds only its same callback and blocks jobs until the real root binds', async () => {
  await withSourceFixture(async (root, manager) => {
    let cleanups = 0
    const cleanup = async () => {
      cleanups++
    }
    const workspace = path.join(root, 'workspace'),
      input = path.join(workspace, 'input')
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      assert.equal(
        typeof Reflect.get(scope, 'claimWorkspaceCleanup'),
        'function',
        'real scope lacks precreation cleanup ownership'
      )
      scope.claimWorkspaceCleanup(cleanup)
      assert.throws(() => scope.claimWorkspaceCleanup(cleanup), {
        code: 'INVALID_REQUEST',
      })
      await fs.mkdir(workspace, { mode: 0o700 })
      await fs.mkdir(input, { mode: 0o700 })
      await fs.writeFile(path.join(input, 'main.tex'), 'source')
      const request = {
        image: `sha256:${'a'.repeat(64)}`,
        argv: ['/usr/bin/pdflatex'],
        cwd: '/compile',
        inputDirectory: input,
        outputDirectory: path.join(workspace, 'new-output'),
        timeoutMs: 1000,
      }
      await assert.rejects(scope.runJob(request), { code: 'INVALID_REQUEST' })
      assert.throws(() => scope.ownWorkspace(workspace, async () => {}), {
        code: 'INVALID_REQUEST',
      })
      scope.ownWorkspace(workspace, cleanup)
      assert.throws(() => scope.ownWorkspace(workspace, cleanup), {
        code: 'INVALID_REQUEST',
      })
    })
    await lease.closed
    assert.equal(cleanups, 1)
  })
})
test('a successful no-allocation cleanup claim releases once and its closed scope cannot claim or bind', async () => {
  await withSourceFixture(async (root, manager) => {
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace, { mode: 0o700 })
    let saved: WorkflowScope | undefined,
      count = 0
    const cleanup = async () => {
      count++
    }
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    await lease.run(async scope => {
      saved = scope
      assert.equal(
        typeof Reflect.get(scope, 'claimWorkspaceCleanup'),
        'function'
      )
      scope.claimWorkspaceCleanup(cleanup)
    })
    await lease.closed
    assert.ok(saved)
    assert.equal(saved.signal.aborted, false)
    assert.equal(count, 1)
    assert.equal(manager.status().active, 0)
    const closedScope = saved
    assert.throws(() => closedScope.claimWorkspaceCleanup(cleanup), {
      code: 'CLOSED',
    })
    assert.throws(() => closedScope.ownWorkspace(workspace, cleanup), {
      code: 'CLOSED',
    })
  })
})
test('failed cleanup without a bound root keeps capacity across sweep and retries the exact callback after workfinish', async () => {
  await withSourceFixture(async (_root, manager) => {
    let failures = true,
      count = 0,
      closed = false
    const cleanup = async () => {
      count++
      if (failures) throw new Error('synthetic unallocated cleanup failure')
    }
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    void lease.closed.then(() => {
      closed = true
    })
    await assert.rejects(
      lease.run(async scope => {
        assert.equal(
          typeof Reflect.get(scope, 'claimWorkspaceCleanup'),
          'function'
        )
        scope.claimWorkspaceCleanup(cleanup)
      })
    )
    await manager.reconcile()
    assert.equal(manager.status().active, 1)
    assert.equal(manager.status().ready, false)
    assert.equal(closed, false)
    failures = false
    await manager.retryCleanup()
    await lease.closed
    assert.equal(count, 2)
    assert.equal(manager.status().active, 0)
  })
})
test('external reset joins a claimed cleanup even before a workspace root exists', async () => {
  await withSourceFixture(async (_root, manager) => {
    const entered = Promise.withResolvers<void>(),
      body = Promise.withResolvers<void>(),
      cleanupEntered = Promise.withResolvers<void>(),
      cleanupHeld = Promise.withResolvers<void>()
    const lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
    const work = lease.run(async scope => {
      assert.equal(
        typeof Reflect.get(scope, 'claimWorkspaceCleanup'),
        'function'
      )
      scope.claimWorkspaceCleanup(async () => {
        cleanupEntered.resolve()
        await cleanupHeld.promise
      })
      entered.resolve()
      await body.promise
    })
    void work.catch(() => {})
    await entered.promise
    let resetDone = false
    const reset = manager
      .reset({ projectId: PROJECT }, async () => {})
      .then(() => {
        resetDone = true
      })
    body.resolve()
    await cleanupEntered.promise
    try {
      assert.equal(resetDone, false)
      assert.equal(manager.status().active, 1)
    } finally {
      cleanupHeld.resolve()
      await work.catch(() => {})
      await reset
      await lease.closed
    }
  })
})
test('an aborted real scope refuses a new cleanup claim or root bind', async () => {
  await withSourceFixture(async (root, manager) => {
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace, { mode: 0o700 })
    const abort = new AbortController(),
      lease = await manager.acquire(
        { projectId: PROJECT, kind: 'compile' },
        { signal: abort.signal }
      )
    await assert.rejects(
      lease.run(async scope => {
        assert.equal(
          typeof Reflect.get(scope, 'claimWorkspaceCleanup'),
          'function'
        )
        abort.abort()
        assert.throws(() => scope.claimWorkspaceCleanup(async () => {}), {
          code: 'CANCELLED',
        })
        assert.throws(() => scope.ownWorkspace(workspace, async () => {}), {
          code: 'CANCELLED',
        })
      }),
      { name: 'AbortError' }
    )
    await lease.closed
  })
})
