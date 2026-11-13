import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import type { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
import { CompileSourcePlanCache } from '../../../app/js/CompileSourcePlanCache.ts'

const PROJECT = '1234567890abcdef12345678'
const USER = 'abcdef1234567890abcdef12'
function raw(content = 'old', size?: number) {
  const bytes = Buffer.from(
    JSON.stringify({
      compile: {
        options: { syncType: 'full' },
        resources: [{ path: 'main.tex', content }],
      },
    })
  )
  return size === undefined
    ? bytes
    : Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 32)])
}
async function install(
  manager: CompilerAdmission,
  root: string,
  cache: import('../../../app/js/CompileSourcePlanCache.ts').CompileSourcePlanCache,
  projectId = PROJECT,
  bytes = raw()
) {
  const lease = await manager.acquire({
    projectId,
    userId: USER,
    kind: 'compile',
  })
  await lease.run(async scope => {
    const plan = await parseFullSourcePlan(scope, bytes)
    await materializeFullSource(scope, plan, {
      stagingRoot: path.join(root, 'operations'),
    })
    await cache.install(scope, plan)
  })
  await lease.closed
}
test('only a successfully materialized opaque full plan can install; missing GET state is genuine404', async () => {
  await withSourceFixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    await lease.run(async scope => {
      await assert.rejects(cache.load(scope), { name: 'NotFoundError' })
      const parsedOnly = await parseFullSourcePlan(scope, raw())
      await assert.rejects(cache.install(scope, parsedOnly), {
        code: 'INVALID_SOURCE_REQUEST',
      })
      assert.deepEqual(await fs.readdir(path.join(root, 'plans')), [])
    })
  })
})
test('inactive eviction cannot delete an expired plan while its project has active source work', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    await install(manager, root, cache)
    const names = await fs.readdir(directory)
    assert.equal(names.length, 1)
    const file = path.join(directory, names[0]!),
      expired = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000)
    await fs.utimes(file, expired, expired)
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>()
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
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
      await cache.expire()
      assert.equal(cancelled, false)
      assert.equal((await fs.readdir(directory)).length, 1)
    } finally {
      held.resolve()
      await work
    }
    await cache.expire()
    assert.deepEqual(await fs.readdir(directory), [])
    const next = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    await next.run(async scope => {
      await assert.rejects(cache.load(scope), { name: 'NotFoundError' })
    })
  })
})
test('the64MiB decoded-plan budget evicts inactive LRU while preserving an active oldest plan', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>(),
      bytes = raw('active', 7 * 1024 * 1024)
    const active = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    const work = active.run(async scope => {
      const plan = await parseFullSourcePlan(scope, bytes)
      await materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      await cache.install(scope, plan)
      entered.resolve()
      await held.promise
    })
    try {
      await entered.promise
      for (let i = 1; i <= 9; i++)
        await install(
          manager,
          root,
          cache,
          i.toString(16).padStart(24, '0'),
          raw('other', 7 * 1024 * 1024)
        )
      const names = await fs.readdir(directory)
      let total = 0
      for (const name of names) {
        const stat = await fs.lstat(path.join(directory, name))
        assert.equal(stat.mode & 0o777, 0o600)
        assert.equal(stat.nlink, 1)
        total += stat.size
      }
      assert.equal(names.length, 9)
      assert.ok(total <= 64 * 1024 * 1024)
      assert.equal(active.signal.aborted, false)
      const activeName = `${PROJECT}.${USER}.json`
      assert.ok(names.includes(activeName))
    } finally {
      held.resolve()
      await work
    }
  })
}, 15000)
test('the128-plan entry budget uses bounded inactive eviction without accumulating temporary files', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    for (let i = 1; i <= 129; i++)
      await install(manager, root, cache, i.toString(16).padStart(24, '0'))
    const names = await fs.readdir(directory)
    assert.equal(names.length, 128)
    assert.equal(
      names.some(name => name.startsWith('.')),
      false
    )
    assert.equal(names.includes(`${'1'.padStart(24, '0')}.${USER}.json`), false)
    assert.ok(
      names.includes(`${(129).toString(16).padStart(24, '0')}.${USER}.json`)
    )
  })
}, 15000)
test('cache reset owns the real cancel/join fence before deleting a plan and leaves unrelated work running', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    await install(manager, root, cache)
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>(),
      cancelled = Promise.withResolvers<void>()
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    const work = lease.run(async scope => {
      scope.signal.addEventListener('abort', () => cancelled.resolve(), {
        once: true,
      })
      entered.resolve()
      await held.promise
    })
    const observed = work.catch(() => {})
    await entered.promise
    let resetDone = false
    const reset = cache.resetAndClear({ projectId: PROJECT }).then(() => {
      resetDone = true
    })
    await cancelled.promise
    assert.equal(resetDone, false)
    assert.equal((await fs.readdir(directory)).length, 1)
    const other = await manager.acquire({
      projectId: '2234567890abcdef12345678',
      kind: 'compile',
    })
    await other.run(async () => {})
    held.resolve()
    await observed
    await reset
    assert.deepEqual(await fs.readdir(directory), [])
    await lease.closed
  })
})
test('cache reset cancels queued scope metadata instead of inventing or executing a source request', async () => {
  await withSourceFixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    await install(manager, root, cache)
    const held = Promise.withResolvers<void>()
    const leases = await Promise.all(
      ['2234567890abcdef12345678', '3234567890abcdef12345678'].map(projectId =>
        manager.acquire({ projectId, kind: 'compile' })
      )
    )
    const active = leases.map(lease =>
      lease.run(async () => {
        await held.promise
      })
    )
    try {
      const pending = manager.acquire({
        projectId: PROJECT,
        userId: USER,
        kind: 'wordcount',
      })
      void pending.catch(() => {})
      assert.equal(manager.status().queued, 1)
      await cache.resetAndClear({ projectId: PROJECT })
      await assert.rejects(pending, { code: 'CANCELLED' })
      assert.equal(
        leases.some(lease => lease.signal.aborted),
        false
      )
      assert.deepEqual(await fs.readdir(path.join(root, 'plans')), [])
    } finally {
      held.resolve()
      await Promise.all(active)
    }
  })
})

test('the exact decoded byte snapshot cannot change while the real parser promise settles', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    const bytes = raw('old'),
      original = Buffer.from(bytes)
    await lease.run(async scope => {
      const pending = parseFullSourcePlan(scope, bytes)
      const offset = bytes.indexOf('old')
      assert.ok(offset > 0)
      bytes.write('new', offset)
      const plan = await pending
      const source = await materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      assert.equal(
        await fs.readFile(
          path.join(source.sourceDirectory, 'main.tex'),
          'utf8'
        ),
        'old'
      )
      await cache.install(scope, plan)
    })
    const names = await fs.readdir(directory)
    assert.equal(names.length, 1)
    assert.equal(
      (await fs.readFile(path.join(directory, names[0]!))).equals(original),
      true,
      'cache did not retain the exact bytes that its parsed/materialized plan used'
    )
  })
})
test('cache reset deletes only the copied logical filter it fenced even if the caller mutates it while joining', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    const otherProject = '2234567890abcdef12345678'
    await install(manager, root, cache)
    await install(manager, root, cache, otherProject)
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      cancelled = Promise.withResolvers<void>()
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    const work = lease.run(async scope => {
      scope.signal.addEventListener('abort', () => cancelled.resolve())
      entered.resolve()
      await held.promise
    })
    const observed = work.catch(() => {})
    await entered.promise
    const filter = { projectId: PROJECT }
    const reset = cache.resetAndClear(filter)
    filter.projectId = otherProject
    try {
      await cancelled.promise
    } finally {
      held.resolve()
      await observed
      await reset
    }
    const names = await fs.readdir(directory)
    assert.deepEqual(names, [`${otherProject}.${USER}.json`])
  })
})
test('cache reset rejects a kind-limited filter instead of deleting plans while another source kind is active', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    await install(manager, root, cache)
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    const work = lease.run(async () => {
      entered.resolve()
      await held.promise
    })
    try {
      await entered.promise
      await assert.rejects(
        Reflect.apply(cache.resetAndClear, cache, [
          { projectId: PROJECT, kind: 'compile' },
        ]),
        { code: 'INVALID_SOURCE_REQUEST' }
      )
      assert.equal(lease.signal.aborted, false)
      assert.equal((await fs.readdir(directory)).length, 1)
    } finally {
      held.resolve()
      await work
    }
  })
})

test('closed and caller-forged scopes cannot read private source-plan bytes', async () => {
  await withSourceFixture(async (root, manager) => {
    const cache = await CompileSourcePlanCache.open(
      manager,
      path.join(root, 'plans')
    )
    await install(manager, root, cache)
    let saved:
      | import('../../../app/js/CompilerAdmission.ts').WorkflowScope
      | undefined
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'wordcount',
    })
    await lease.run(async scope => {
      saved = scope
    })
    await lease.closed
    assert.ok(saved)
    await assert.rejects(cache.load(saved), { code: 'INVALID_SOURCE_REQUEST' })
    const forged = {
      identity: saved.identity,
      signal: new AbortController().signal,
      metadata: Object.freeze({
        projectId: PROJECT,
        userId: USER,
        kind: 'wordcount',
      }),
    }
    await assert.rejects(Reflect.apply(cache.load, cache, [forged]), {
      code: 'INVALID_SOURCE_REQUEST',
    })
  })
})
for (const problem of [
  'root-mode',
  'symlink',
  'hardlink',
  'file-mode',
  'stale-temporary',
  'too-large',
] as const) {
  test(`cache startup refuses ${problem} before retaining private plan metadata`, async () => {
    await withSourceFixture(async (root, manager) => {
      const directory = path.join(root, 'plans'),
        file = path.join(directory, `${PROJECT}.${USER}.json`)
      if (problem === 'root-mode') await fs.chmod(directory, 0o755)
      else if (problem === 'symlink') {
        const target = path.join(root, 'outside')
        await fs.writeFile(target, raw(), { mode: 0o600 })
        await fs.symlink(target, file)
      } else if (problem === 'stale-temporary')
        await fs.writeFile(path.join(directory, '.unknown.tmp'), 'preserved', {
          mode: 0o600,
        })
      else {
        await fs.writeFile(file, raw(), { mode: 0o600 })
        if (problem === 'hardlink')
          await fs.link(file, path.join(root, 'other-link'))
        if (problem === 'file-mode') await fs.chmod(file, 0o644)
        if (problem === 'too-large')
          await fs.truncate(file, 7 * 1024 * 1024 + 1)
      }
      const before = await fs.readdir(directory)
      await assert.rejects(CompileSourcePlanCache.open(manager, directory), {
        code: 'SOURCE_CACHE_UNSAFE',
      })
      assert.deepEqual(await fs.readdir(directory), before)
      if (problem === 'root-mode') {
        await fs.chmod(directory, 0o700)
        await CompileSourcePlanCache.open(manager, directory)
      }
    })
  })
}

test('one held manager cannot concurrently open two independent cache budget authorities', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans')
    const results = await Promise.allSettled([
      CompileSourcePlanCache.open(manager, directory),
      CompileSourcePlanCache.open(manager, directory),
    ])
    assert.equal(
      results.filter(result => result.status === 'fulfilled').length,
      1
    )
    const failed = results.find(result => result.status === 'rejected')
    assert.ok(failed && failed.status === 'rejected')
    assert.equal(failed.reason.code, 'SOURCE_CACHE_UNSAFE')
  })
})
test('cache root replacement is refused while foreign replacement bytes survive', async () => {
  await withSourceFixture(async (root, manager) => {
    const directory = path.join(root, 'plans'),
      moved = path.join(root, 'held-old-plans'),
      cache = await CompileSourcePlanCache.open(manager, directory)
    await install(manager, root, cache)
    await fs.rename(directory, moved)
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(
      path.join(directory, `${PROJECT}.${USER}.json`),
      raw('foreign'),
      { mode: 0o600 }
    )
    try {
      const lease = await manager.acquire({
        projectId: PROJECT,
        userId: USER,
        kind: 'wordcount',
      })
      await lease.run(async scope => {
        await assert.rejects(cache.load(scope), { code: 'SOURCE_CACHE_UNSAFE' })
      })
      await assert.rejects(cache.expire(), { code: 'SOURCE_CACHE_UNSAFE' })
      assert.deepEqual(
        await fs.readFile(path.join(directory, `${PROJECT}.${USER}.json`)),
        raw('foreign')
      )
    } finally {
      await fs.rename(directory, path.join(root, 'foreign-plans'))
      await fs.rename(moved, directory)
    }
  })
})
for (const operation of ['load', 'install'] as const) {
  test(`cache ${operation} rejects a real active scope owned by another held manager`, async () => {
    await withSourceFixture(async (rootA, managerA) => {
      const directory = path.join(rootA, 'plans'),
        cache = await CompileSourcePlanCache.open(managerA, directory)
      await install(managerA, rootA, cache)
      await withSourceFixture(async (rootB, managerB) => {
        const lease = await managerB.acquire({
          projectId: PROJECT,
          userId: USER,
          kind: 'compile',
        })
        await lease.run(async scope => {
          if (operation === 'load')
            await assert.rejects(cache.load(scope), {
              code: 'INVALID_SOURCE_REQUEST',
            })
          else {
            const plan = await parseFullSourcePlan(scope, raw('wrong manager'))
            await materializeFullSource(scope, plan, {
              stagingRoot: path.join(rootB, 'operations'),
            })
            await assert.rejects(cache.install(scope, plan), {
              code: 'INVALID_SOURCE_REQUEST',
            })
          }
          assert.deepEqual(
            await fs.readFile(path.join(directory, `${PROJECT}.${USER}.json`)),
            raw()
          )
        })
      })
    })
  })
}
