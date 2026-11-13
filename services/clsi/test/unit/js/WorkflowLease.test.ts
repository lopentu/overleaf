import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import type { WorkflowLease } from '../../../app/js/CompilerAdmission.ts'
import type { JobRequest, JobResult } from '../../../app/js/JobRequest.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'

function gate() {
  return Promise.withResolvers<void>()
}
class Executor {
  hold: Promise<void> | undefined
  readonly calls: { request: JobRequest; identity: string | undefined }[] = []
  run(request: JobRequest, identity?: string): Promise<JobResult> {
    this.calls.push({ request, identity })
    return (this.hold ?? Promise.resolve()).then(() => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      output: { entries: 0, files: 0, bytes: 0 },
      outputDirectory: request.outputDirectory,
    }))
  }
}
const meta = (projectId: string) => ({ projectId, kind: 'compile' as const })
describe('real workflow leases', () => {
  let root: string,
    workspace: string,
    api: OwnershipApiFixture,
    manager: CompilerAdmission,
    executor: Executor
  const pending: Array<() => void> = []
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-lease-'))
    workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace, { mode: 0o700 })
    api = new OwnershipApiFixture()
    executor = new Executor()
    const lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(await api.open(), lease),
      { sweepIntervalMs: 60_000 }
    )
    await manager.start()
  })
  afterEach(async () => {
    for (const release of pending.splice(0)) release()
    await manager.retryCleanup?.().catch(() => {})
    await manager.close()
    await api.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  async function acquire(project: string): Promise<WorkflowLease> {
    const lease = await manager.acquire?.(meta(project))
    expect(lease).toBeDefined()
    if (!lease) throw new Error('workflow acquisition missing')
    return lease
  }
  it('admits actual metadata before any JobRequest exists and holds capacity through cleanup', async () => {
    const lease = await acquire('p')
    const cleanup = gate()
    pending.push(cleanup.resolve)
    let cleanupStarted = false,
      closed = false
    void lease.closed.then(() => {
      closed = true
    })
    const run = lease.run(async scope => {
      scope.ownWorkspace(workspace, async () => {
        cleanupStarted = true
        await cleanup.promise
      })
      return 17
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(cleanupStarted).toBe(true)
    expect(closed).toBe(false)
    expect(manager.status()).toMatchObject({ active: 1 })
    expect(executor.calls).toHaveLength(0)
    cleanup.resolve()
    expect(await run).toBe(17)
    await lease.closed
    expect(manager.status().active).toBe(0)
  })
  it('keeps a failed host cleanup held across a successful Docker-only sweep, then retries exactly once', async () => {
    const lease = await acquire('p')
    const failure = new Error('host cleanup failed')
    let attempts = 0
    const result = await lease
      .run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          if (++attempts === 1) throw failure
        })
        return 1
      })
      .catch((error: unknown) => error)
    expect(result).toBe(failure)
    await manager.reconcile()
    expect(manager.status()).toMatchObject({
      active: 1,
      ready: false,
      cleanupHeld: 1,
    })
    await assert.rejects(manager.acquire(meta('other')), {
      code: 'RECONCILIATION_FAILED',
    })
    await manager.retryCleanup()
    await lease.closed
    expect(attempts).toBe(2)
    expect(manager.status()).toMatchObject({
      active: 0,
      ready: true,
      cleanupHeld: 0,
    })
  })
  it('retains both work and cleanup errors, and never releases ownership on the cleanup error', async () => {
    const lease = await acquire('p')
    const primary = new Error('work failed'),
      cleanup = new Error('cleanup failed')
    let fail = true
    const result = await lease
      .run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          if (fail) throw cleanup
        })
        throw primary
      })
      .catch((error: unknown) => error)
    assert.ok(result instanceof AggregateError)
    expect(result.errors).toEqual([primary, cleanup])
    expect(result.cause).toBe(primary)
    expect(manager.status()).toMatchObject({ active: 1, cleanupHeld: 1 })
    fail = false
    await manager.retryCleanup()
    await lease.closed
  })
  it('bounds to two active and eight metadata queues and never calls the job executor', async () => {
    const a = await acquire('a'),
      b = await acquire('b')
    const hold = gate()
    pending.push(hold.resolve)
    const ar = a.run(async () => hold.promise),
      br = b.run(async () => hold.promise)
    const queued = Array.from({ length: 8 }, (_, i) =>
      manager
        .acquire(meta(`q${i}`))
        .then(lease => lease.run(async () => 0))
        .catch((error: unknown) => error)
    )
    await assert.rejects(manager.acquire(meta('overflow')), {
      code: 'OVERLOADED',
    })
    expect(manager.status()).toMatchObject({ active: 2, queued: 8 })
    expect(executor.calls).toHaveLength(0)
    hold.resolve()
    await Promise.all([ar, br, ...queued])
  })
  it('makes mutable same-project requests busy while immutable SyncTeX retains queue admission', async () => {
    const lease = await acquire('p')
    const hold = gate()
    pending.push(hold.resolve)
    const running = lease.run(async () => hold.promise)
    await assert.rejects(manager.acquire(meta('p')), {
      code: 'PROJECT_BUSY',
    })
    const reader = await manager.acquire({
      projectId: 'p',
      kind: 'output-read',
    })
    await reader.run(async () => 42)
    hold.resolve()
    await running
  })
  it('joins an unawaited known job and preserves cancellation even when the executor ignores it', async () => {
    const lease = await acquire('p')
    const held = gate()
    pending.push(held.resolve)
    executor.hold = held.promise
    const input = path.join(workspace, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    await fs.writeFile(path.join(input, 'main.tex'), 'x')
    const request: JobRequest = {
      image: `sha256:${'a'.repeat(64)}`,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(workspace, 'new-output'),
      timeoutMs: 1000,
    }
    let cleanup = false
    const outcome = lease
      .run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          cleanup = true
        })
        void scope.runJob(request)
        return 'must not report success'
      })
      .catch((error: unknown) => error)
    expect(executor.calls).toHaveLength(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    const stopping = manager.cancelAndWait({ projectId: 'p' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(cleanup).toBe(false)
    expect(manager.status().active).toBe(1)
    held.resolve()
    expect(await outcome).toMatchObject({ code: 'CANCELLED' })
    await stopping
    expect(cleanup).toBe(true)
  })
  it('preserves cancellation arriving while owned cleanup is still pending', async () => {
    const lease = await acquire('p'),
      held = gate(),
      entered = gate()
    pending.push(held.resolve)
    const result = lease
      .run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          entered.resolve()
          await held.promise
        })
        return 'late success'
      })
      .catch((error: unknown) => error)
    await entered.promise
    const stop = manager.cancelAndWait({ projectId: 'p' })
    held.resolve()
    expect(await result).toMatchObject({ code: 'CANCELLED' })
    await stop
  })
  it('rejects queued matching readers on reset and preserves unrelated active work', async () => {
    const a = await acquire('a'),
      b = await acquire('b'),
      hold = gate()
    pending.push(hold.resolve)
    const ar = a.run(async () => hold.promise),
      br = b.run(async () => hold.promise)
    const queued = manager
      .acquire({ projectId: 'target', kind: 'output-read' })
      .catch((error: unknown) => error)
    let cleared = false
    await manager.reset({ projectId: 'target' }, async () => {
      cleared = true
    })
    expect(await queued).toMatchObject({ code: 'CANCELLED' })
    expect(cleared).toBe(true)
    expect(a.signal.aborted || b.signal.aborted).toBe(false)
    hold.resolve()
    await Promise.all([ar, br])
  })
  it('keeps a failed reset fence, deduplicates in-flight reset and retries the original owned clear', async () => {
    const held = gate()
    pending.push(held.resolve)
    let calls = 0,
      fail = true
    const clear = async () => {
      calls++
      await held.promise
      if (fail) throw new Error('clear failed')
    }
    const first = manager.reset({ projectId: 'p' }, clear)
    const duplicate = manager.reset({ projectId: 'p' }, clear)
    expect(first).toBe(duplicate)
    held.resolve()
    await assert.rejects(first, new RegExp('clear failed'))
    await assert.rejects(manager.acquire(meta('p')), {
      code: 'PROJECT_BUSY',
    })
    fail = false
    await manager.reset({ projectId: 'p' }, clear)
    expect(calls).toBe(2)
    const next = await acquire('p')
    await next.run(async () => 0)
  })
  it('shutdown surfaces a failed host cleanup and retains the OS guard until explicit retry', async () => {
    const lease = await acquire('p')
    let fail = true
    await lease
      .run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          if (fail) throw new Error('cleanup failed')
        })
      })
      .catch(() => {})
    await assert.rejects(manager.close(), new RegExp('cleanup failed'))
    await assert.rejects(
      CompilerLease.acquire(path.join(root, 'manager.sock')),
      /already exists/
    )
    fail = false
    await manager.retryCleanup()
    await manager.close()
    await lease.closed
  })
  it('allows sequential genuine jobs with fresh protected UUIDs but rejects concurrent use', async () => {
    const lease = await acquire('p'),
      held = gate()
    pending.push(held.resolve)
    executor.hold = held.promise
    const input = path.join(workspace, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    await fs.writeFile(path.join(input, 'main.tex'), 'real source')
    const request: JobRequest = {
      image: `sha256:${'a'.repeat(64)}`,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(workspace, 'output-a'),
      timeoutMs: 1000,
    }
    await lease.run(async scope => {
      scope.ownWorkspace(workspace, async () => {})
      const first = scope.runJob(request)
      await assert.rejects(
        scope.runJob({
          ...request,
          outputDirectory: path.join(workspace, 'overlap'),
        }),
        { code: 'CLOSED' }
      )
      held.resolve()
      await first
      await scope.runJob({
        ...request,
        outputDirectory: path.join(workspace, 'output-b'),
      })
    })
    expect(executor.calls).toHaveLength(2)
    const ids = executor.calls.map(call => call.identity)
    expect(new Set(ids).size).toBe(2)
    expect(
      ids.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
    ).toBe(true)
    await assert.rejects(
      lease.run(async () => 0),
      {
        code: 'CLOSED',
      }
    )
  })
  it('bounds active workspace ownership to one cleanup and still cleans when registration is misused', async () => {
    const lease = await acquire('p')
    let calls = 0
    await assert.rejects(
      lease.run(async scope => {
        scope.ownWorkspace(workspace, async () => {
          calls++
        })
        scope.ownWorkspace(workspace, async () => {})
      }),
      { code: 'INVALID_REQUEST' }
    )
    expect(calls).toBe(1)
    await lease.closed
    expect(manager.status().active).toBe(0)
  })
  it('stop joins actual work and owned cleanup before returning', async () => {
    const lease = await acquire('p')
    const work = gate(),
      cleanup = gate()
    pending.push(work.resolve, cleanup.resolve)
    const run = lease
      .run(async scope => {
        scope.ownWorkspace(workspace, () => cleanup.promise)
        await work.promise
      })
      .catch((error: unknown) => error)
    let done = false
    const stop = manager.cancelAndWait({ projectId: 'p' }).then(() => {
      done = true
    })
    expect(lease.signal.aborted).toBe(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(done).toBe(false)
    work.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(done).toBe(false)
    cleanup.resolve()
    await stop
    await run
    expect(done).toBe(true)
  })
  it('reset fences new work and does not clear until cleanup settles', async () => {
    const lease = await acquire('p')
    const held = gate()
    pending.push(held.resolve)
    let cleared = false
    const running = lease
      .run(async () => held.promise)
      .catch((error: unknown) => error)
    const reset = manager.reset({ projectId: 'p' }, async () => {
      cleared = true
    })
    await assert.rejects(manager.acquire(meta('p')), {
      code: 'PROJECT_BUSY',
    })
    expect(cleared).toBe(false)
    held.resolve()
    await reset
    await running
    expect(cleared).toBe(true)
    const next = await acquire('p')
    await next.run(async () => 0)
  })
  it.each(['input', 'output'] as const)(
    'retains an earlier sequential %s path until owned cleanup closes',
    async reuseKind => {
      const workspaceA = path.join(root, 'workspace-a')
      const workspaceB = path.join(root, 'workspace-b')
      for (const directory of [workspaceA, workspaceB])
        await fs.mkdir(directory, { mode: 0o700 })
      const input1 = path.join(workspaceA, 'first-input')
      const input2 = path.join(workspaceA, 'second-input')
      const output1 = path.join(workspaceA, 'first-output')
      for (const directory of [input1, input2]) {
        await fs.mkdir(directory, { mode: 0o700 })
        await fs.writeFile(path.join(directory, 'main.tex'), 'real source')
      }
      const request: JobRequest = {
        image: `sha256:${'a'.repeat(64)}`,
        argv: ['/usr/bin/pdflatex'],
        cwd: '/compile',
        inputDirectory: input1,
        outputDirectory: output1,
        timeoutMs: 1000,
      }
      const lease = await acquire('a'),
        cleanup = gate(),
        entered = gate()
      pending.push(cleanup.resolve)
      let closed = false
      void lease.closed.then(() => {
        closed = true
      })
      const run = lease.run(async scope => {
        scope.ownWorkspace(workspaceA, async () => {
          entered.resolve()
          await cleanup.promise
        })
        await scope.runJob(request)
        await fs.mkdir(output1, { mode: 0o700 })
        await fs.writeFile(path.join(output1, 'output.pdf'), 'real result')
        await scope.runJob({
          ...request,
          inputDirectory: input2,
          outputDirectory: path.join(workspaceA, 'second-output'),
        })
      })
      await entered.promise
      const reuse = manager.submit('b', {
        ...request,
        inputDirectory: reuseKind === 'input' ? input1 : output1,
        outputDirectory: path.join(workspaceB, 'new-output'),
      })
      void reuse.catch(() => {})
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(closed).toBe(false)
        expect(executor.calls).toHaveLength(2)
        expect(manager.status()).toMatchObject({ active: 1, queued: 1 })
      } finally {
        cleanup.resolve()
        await Promise.all([run, reuse])
      }
      await lease.closed
      expect(executor.calls).toHaveLength(3)
      expect(manager.status().active).toBe(0)
    }
  )

  it('requires a declared workspace before workflow execution', async () => {
    const input = path.join(workspace, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    const request: JobRequest = {
      image: `sha256:${'a'.repeat(64)}`,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(workspace, 'out'),
      timeoutMs: 1000,
    }
    const lease = await acquire('p')
    await lease.run(async scope => {
      await assert.rejects(scope.runJob(request), {
        code: 'INVALID_REQUEST',
      })
    })
    expect(executor.calls).toHaveLength(0)
  })
  it('rejects input and output outside the declared root while allowing sequential descendants', async () => {
    const input = path.join(workspace, 'input'),
      outside = path.join(root, 'other')
    await fs.mkdir(input, { mode: 0o700 })
    await fs.mkdir(outside, { mode: 0o700 })
    const request: JobRequest = {
      image: `sha256:${'a'.repeat(64)}`,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(workspace, 'out'),
      timeoutMs: 1000,
    }
    const lease = await acquire('p')
    await lease.run(async scope => {
      scope.ownWorkspace(workspace, async () => {})
      for (const crossing of [
        { ...request, inputDirectory: outside },
        { ...request, outputDirectory: path.join(outside, 'out') },
        { ...request, inputDirectory: workspace },
        { ...request, outputDirectory: workspace },
      ]) {
        await assert.rejects(scope.runJob(crossing), {
          code: 'INVALID_REQUEST',
        })
      }
      expect(executor.calls).toHaveLength(0)
      for (const name of ['one', 'two', 'three'])
        await scope.runJob({
          ...request,
          outputDirectory: path.join(workspace, name),
        })
    })
    expect(executor.calls).toHaveLength(3)
  })
  it('reserves the whole root before the first job and refuses ancestor or child workspaces', async () => {
    const child = path.join(workspace, 'child'),
      unrelated = path.join(root, 'unrelated')
    for (const directory of [child, unrelated])
      await fs.mkdir(directory, { mode: 0o700 })
    const hold = gate(),
      entered = gate(),
      a = await acquire('a')
    pending.push(hold.resolve)
    const running = a.run(async scope => {
      scope.ownWorkspace(workspace, async () => {})
      entered.resolve()
      await hold.promise
    })
    await entered.promise
    for (const directory of [child, root]) {
      const b = await acquire('b')
      await assert.rejects(
        b.run(async scope => {
          scope.ownWorkspace(directory, async () => {})
        }),
        { code: 'PROJECT_BUSY' }
      )
      await b.closed
    }
    const independent = await acquire('b')
    await independent.run(async scope => {
      scope.ownWorkspace(unrelated, async () => {})
      return 7
    })
    expect(a.signal.aborted).toBe(false)
    expect(manager.status().active).toBe(1)
    hold.resolve()
    await running
  })
  it.each([
    'missing',
    'file',
    'symlink',
    'public-mode',
    'unsafe-ancestor',
  ] as const)(
    'refuses an unowned or unsafe workspace shape: %s',
    async shape => {
      let selected = path.join(root, 'selected')
      if (shape === 'file') await fs.writeFile(selected, 'file')
      if (shape === 'symlink') await fs.symlink(workspace, selected)
      if (shape === 'public-mode') await fs.mkdir(selected, { mode: 0o755 })
      if (shape === 'unsafe-ancestor') {
        const ancestor = path.join(root, 'unsafe')
        await fs.mkdir(ancestor, { mode: 0o700 })
        await fs.chmod(ancestor, 0o777)
        selected = path.join(ancestor, 'private-leaf')
        await fs.mkdir(selected, { mode: 0o700 })
      }
      const lease = await acquire('p')
      let cleanupCalls = 0
      await assert.rejects(
        lease.run(async scope => {
          scope.ownWorkspace(selected, async () => {
            cleanupCalls++
          })
        }),
        { code: 'INVALID_REQUEST' }
      )
      expect(cleanupCalls).toBe(0)
      expect(executor.calls).toHaveLength(0)
      await lease.closed
    }
  )
  it.each(['input', 'output-parent', 'output'] as const)(
    'rejects a descendant %s symlink crossing another held workspace',
    async kind => {
      const otherRoot = path.join(root, 'other-workspace'),
        ownInput = path.join(workspace, 'input'),
        otherInput = path.join(otherRoot, 'input'),
        alias = path.join(workspace, 'alias')
      await fs.mkdir(otherRoot, { mode: 0o700 })
      await fs.mkdir(otherInput, { mode: 0o700 })
      await fs.mkdir(ownInput, { mode: 0o700 })
      await fs.symlink(kind === 'output-parent' ? otherRoot : otherInput, alias)
      const other = await acquire('other'),
        hold = gate(),
        entered = gate()
      pending.push(hold.resolve)
      const held = other.run(async scope => {
        scope.ownWorkspace(otherRoot, async () => {})
        entered.resolve()
        await hold.promise
      })
      await entered.promise
      try {
        const lease = await acquire('p')
        await lease.run(async scope => {
          scope.ownWorkspace(workspace, async () => {})
          await assert.rejects(
            scope.runJob({
              image: `sha256:${'a'.repeat(64)}`,
              argv: ['/usr/bin/pdflatex'],
              cwd: '/compile',
              inputDirectory: kind === 'input' ? alias : ownInput,
              outputDirectory:
                kind === 'output-parent'
                  ? path.join(alias, 'new-output')
                  : kind === 'output'
                    ? alias
                    : path.join(workspace, 'new-output'),
              timeoutMs: 1000,
            }),
            { code: 'INVALID_REQUEST' }
          )
        })
        expect(executor.calls).toHaveLength(0)
      } finally {
        hold.resolve()
        await held
      }
    }
  )
})
