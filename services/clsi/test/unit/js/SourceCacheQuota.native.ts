import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { withSourceFixture } from './SourceInputFixture.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import { CompileSourcePlanCache } from '../../../app/js/CompileSourcePlanCache.ts'
const MiB = 1024 * 1024,
  USER = 'abcdef1234567890abcdef12'
function bytes(content: string) {
  const raw = Buffer.from(
    JSON.stringify({ compile: { resources: [{ path: 'main.tex', content }] } })
  )
  return Buffer.concat([raw, Buffer.alloc(7 * MiB - raw.length, 32)])
}
const held = Promise.withResolvers<void>(),
  entered = Promise.withResolvers<void>(),
  open = fs.open
let closes = 0
try {
  await withSourceFixture(async (root, manager) => {
    const cacheRoot = path.join(root, 'plans'),
      cache = await CompileSourcePlanCache.open(manager, cacheRoot)
    const projects = Array.from({ length: 9 }, (_, i) =>
      (i + 1).toString(16).padStart(24, '0')
    )
    async function install(projectId: string, raw: Buffer) {
      const lease = await manager.acquire({
        projectId,
        userId: USER,
        kind: 'compile',
      })
      await lease.run(async scope => {
        const plan = await parseFullSourcePlan(scope, raw)
        await materializeFullSource(scope, plan, {
          stagingRoot: path.join(root, 'operations'),
        })
        await cache.install(scope, plan)
      })
      await lease.closed
    }
    for (const project of projects) await install(project, bytes('old'))
    Object.defineProperty(fs, 'open', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args),
          name = typeof args[0] === 'string' ? args[0] : ''
        if (path.dirname(name) === cacheRoot && name.endsWith('.tmp')) {
          const close = file.close.bind(file)
          Object.defineProperty(file, 'close', {
            value: async () => {
              await close()
              if (++closes === 2) entered.resolve()
              await held.promise
            },
          })
        }
        return file
      },
    })
    syncBuiltinESMExports()
    const pending = projects
      .slice(0, 2)
      .map(project => install(project, bytes('new')))
    for (const work of pending) void work.catch(() => {})
    try {
      assert.equal(
        await Promise.race([
          entered.promise.then(() => true),
          Promise.race(pending).then(
            () => false,
            () => false
          ),
        ]),
        true,
        'both real pending cache writes must be reached'
      )
      await delay(25)
      const inodes = new Set<string>()
      let occupied = 0
      for (const name of await fs.readdir(cacheRoot)) {
        const stat = await fs.lstat(path.join(cacheRoot, name)),
          key = `${stat.dev}:${stat.ino}`
        if (!inodes.has(key)) {
          inodes.add(key)
          occupied += stat.size
        }
      }
      assert.ok(
        occupied <= 64 * MiB,
        'concurrent pending source plans exceeded the64MiB payload budget'
      )
      assert.equal(closes, 2)
      assert.equal(manager.status().active, 2)
      assert.equal(manager.status().queued, 0)
    } finally {
      held.resolve()
      await Promise.all(pending)
    }
    const names = await fs.readdir(cacheRoot)
    assert.equal(names.length, 7)
    assert.equal(
      names.some(name => name.startsWith('.')),
      false
    )
    for (const project of projects.slice(0, 2))
      assert.deepEqual(
        await fs.readFile(path.join(cacheRoot, `${project}.${USER}.json`)),
        bytes('new')
      )
  })
  console.log('concurrent pending quota native PASS')
} finally {
  held.resolve()
  Object.defineProperty(fs, 'open', { configurable: true, value: open })
  syncBuiltinESMExports()
}
