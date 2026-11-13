import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { withSourceFixture } from './SourceInputFixture.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import { copyMaterializedPlanBytes } from '../../../app/js/CompileSourcePlan.ts'
import { CompileSourcePlanCache } from '../../../app/js/CompileSourcePlanCache.ts'
import type { MaterializedSource } from '../../../app/js/FreshCompileInput.ts'
import type { WorkflowScope } from '../../../app/js/CompilerAdmission.ts'
const mode = process.argv[2]
assert.ok(
  [
    'root-authority',
    'source-identity-capture',
    'source-registration-validation',
    'source-late-allocation',
    'source-abort-allocation',
    'source-late-identity',
    'cache-identity-capture',
    'cache-unawaited-rename',
    'cache-rename-abort',
    'cache-read-abort',
    'cache-read-close-error',
    'cache-close-abort',
    'cache-write-abort',
    'cache-backup-link-error',
    'cache-backup-cleanup-error',
    'source-write-abort',
    'source-write-close-error',
  ].includes(mode ?? '')
)
const PROJECT = '1234567890abcdef12345678',
  USER = 'abcdef1234567890abcdef12'
function body(content: string) {
  return Buffer.from(
    JSON.stringify({
      compile: {
        options: { syncType: 'full' },
        resources: [{ path: 'main.tex', content }],
      },
    })
  )
}
function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    (('code' in error && error.code === code) ||
      (error instanceof AggregateError &&
        error.errors.some((nested: unknown) => hasCode(nested, code))))
  )
}
const mkdtemp = fs.mkdtemp
const lstatSync = fsSync.lstatSync
const open = fs.open,
  rename = fs.rename,
  link = fs.link,
  unlink = fs.unlink,
  lstat = fs.lstat
const entered = Promise.withResolvers<void>(),
  held = Promise.withResolvers<void>(),
  bodyMayReturn = Promise.withResolvers<void>()
let closes = 0,
  blockCleanup = true
try {
  await withSourceFixture(async (root, manager) => {
    const cacheRoot = path.join(root, 'plans'),
      staging = path.join(root, 'operations')
    const cache = await CompileSourcePlanCache.open(manager, cacheRoot)
    const file = path.join(cacheRoot, `${PROJECT}.${USER}.json`)
    const oldBody = body('old'),
      newBody = body('new')
    const first = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await first.run(async scope => {
      const plan = await parseFullSourcePlan(scope, oldBody)
      await materializeFullSource(scope, plan, { stagingRoot: staging })
      await cache.install(scope, plan)
    })
    const abort = new AbortController()
    let settled = false,
      closed = false,
      savedScope: WorkflowScope | undefined
    let cacheTask: Promise<void> | undefined
    let materializeTask: Promise<MaterializedSource> | undefined
    let operationDirectory: string | undefined,
      movedDirectory: string | undefined,
      authorityDenied = false
    const current = await manager.acquire(
      {
        projectId: PROJECT,
        userId: USER,
        kind: mode?.startsWith('cache-read') ? 'wordcount' : 'compile',
      },
      { signal: abort.signal }
    )
    void current.closed.then(() => {
      closed = true
    })
    if (mode === 'source-late-allocation' || mode === 'source-abort-allocation')
      Object.defineProperty(fs, 'mkdtemp', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.mkdtemp>) => {
          const directory = await mkdtemp(...args)
          entered.resolve()
          await held.promise
          return directory
        },
      })
    if (mode === 'source-late-identity')
      Object.defineProperty(fs, 'lstat', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.lstat>) => {
          const stat = await lstat(...args)
          if (
            typeof args[0] === 'string' &&
            path.dirname(args[0]) === staging &&
            path.basename(args[0]).startsWith('operation-')
          ) {
            entered.resolve()
            await held.promise
          }
          return stat
        },
      })
    if (mode === 'source-registration-validation') {
      Object.defineProperty(fsSync, 'lstatSync', {
        configurable: true,
        value: (...args: Parameters<typeof fsSync.lstatSync>) => {
          if (
            typeof args[0] === 'string' &&
            path.dirname(args[0]) === staging &&
            path.basename(args[0]).startsWith('operation-')
          ) {
            operationDirectory = args[0]
            throw new Error('synthetic workspace registration metadata failure')
          }
          return lstatSync(...args)
        },
      })
    }
    if (mode === 'root-authority' || mode === 'source-identity-capture') {
      let observations = 0
      Object.defineProperty(fs, 'lstat', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.lstat>) => {
          const stat = await lstat(...args)
          if (
            typeof args[0] === 'string' &&
            path.dirname(args[0]) === staging &&
            path.basename(args[0]).startsWith('operation-')
          ) {
            operationDirectory = args[0]
            if (mode === 'source-identity-capture' && observations++ === 0)
              throw new Error('synthetic source identity capture failure')
            if (++observations === 2) {
              movedDirectory = path.join(staging, 'moved-owned-operation')
              await rename(operationDirectory, movedDirectory)
              await fs.mkdir(operationDirectory, { mode: 0o700 })
              await fs.writeFile(
                path.join(operationDirectory, 'foreign'),
                'preserved'
              )
              return await lstat(operationDirectory)
            }
          }
          return stat
        },
      })
    }
    Object.defineProperty(fs, 'open', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args)
        const name = typeof args[0] === 'string' ? args[0] : ''
        const temporary =
          path.dirname(name) === cacheRoot &&
          path.basename(name).endsWith('.tmp')
        const selectedRead = mode?.startsWith('cache-read') && name === file
        const selectedWrite =
          temporary &&
          [
            'cache-write-abort',
            'cache-close-abort',
            'cache-identity-capture',
          ].includes(mode ?? '')
        const selectedSource =
          ['source-write-abort', 'source-write-close-error'].includes(
            mode ?? ''
          ) && name.endsWith('/source/project/main.tex')
        if (mode === 'cache-identity-capture' && temporary)
          Object.defineProperty(handle, 'stat', {
            value: async () => {
              throw new Error('synthetic identity capture failure')
            },
          })
        if (selectedRead) {
          const read = handle.read.bind(handle)
          let count = 0
          Object.defineProperty(handle, 'read', {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => {
              const value = await read(buffer, offset, length, position)
              if (++count === 1) {
                entered.resolve()
                await held.promise
              }
              return value
            },
          })
        }
        if ((mode === 'cache-write-abort' && temporary) || selectedSource) {
          const write = handle.write.bind(handle)
          Object.defineProperty(handle, 'write', {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => {
              const value = await write(buffer, offset, length, position)
              entered.resolve()
              await held.promise
              return value
            },
          })
        }
        if (selectedRead || selectedWrite || selectedSource) {
          const close = handle.close.bind(handle)
          Object.defineProperty(handle, 'close', {
            value: async () => {
              closes++
              await close()
              if (mode === 'cache-close-abort') {
                entered.resolve()
                await held.promise
              }
              if (
                mode === 'cache-read-close-error' ||
                mode === 'source-write-close-error'
              )
                throw new Error('synthetic late close failure')
            },
          })
        }
        return handle
      },
    })
    if (mode?.includes('rename'))
      Object.defineProperty(fs, 'rename', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.rename>) => {
          const value = await rename(...args)
          if (
            typeof args[0] === 'string' &&
            path.dirname(args[0]) === cacheRoot &&
            args[0].endsWith('.tmp')
          ) {
            entered.resolve()
            await held.promise
          }
          return value
        },
      })
    if (mode === 'cache-backup-link-error')
      Object.defineProperty(fs, 'link', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.link>) => {
          if (typeof args[1] === 'string' && args[1].endsWith('.old'))
            throw new Error('synthetic link failure')
          return await link(...args)
        },
      })
    if (mode === 'cache-backup-cleanup-error')
      Object.defineProperty(fs, 'unlink', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.unlink>) => {
          if (
            blockCleanup &&
            typeof args[0] === 'string' &&
            args[0].endsWith('.old')
          )
            throw new Error('synthetic backup cleanup failure')
          return await unlink(...args)
        },
      })
    syncBuiltinESMExports()
    const work = current.run(async scope => {
      savedScope = scope
      if (mode?.startsWith('cache-read')) {
        await cache.load(scope)
        return
      }
      const plan = await parseFullSourcePlan(scope, newBody)
      if (
        mode === 'source-late-allocation' ||
        mode === 'source-late-identity'
      ) {
        materializeTask = materializeFullSource(scope, plan, {
          stagingRoot: staging,
        })
        void materializeTask.catch(() => {})
        await entered.promise
        await bodyMayReturn.promise
        return
      }
      try {
        await materializeFullSource(scope, plan, { stagingRoot: staging })
      } catch (error) {
        if (mode === 'root-authority') {
          try {
            copyMaterializedPlanBytes(scope, plan)
          } catch (failure) {
            authorityDenied = hasCode(failure, 'INVALID_SOURCE_REQUEST')
          }
        }
        throw error
      }
      if (mode?.startsWith('source-')) return
      if (mode === 'cache-unawaited-rename') {
        cacheTask = cache.install(scope, plan)
        void cacheTask.catch(() => {})
        await entered.promise
        await bodyMayReturn.promise
        return
      }
      await cache.install(scope, plan)
    })
    const outcome = work.then(
      value => {
        settled = true
        return value
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    try {
      if (
        [
          'cache-rename-abort',
          'cache-read-abort',
          'cache-read-close-error',
          'cache-close-abort',
          'cache-write-abort',
          'source-write-abort',
          'source-write-close-error',
          'cache-unawaited-rename',
          'source-late-allocation',
          'source-abort-allocation',
          'source-late-identity',
        ].includes(mode ?? '')
      ) {
        const reached = await Promise.race([
          entered.promise.then(() => true),
          outcome.then(() => false),
        ])
        assert.equal(reached, true, 'real pending operation was never reached')
        if (
          mode === 'cache-unawaited-rename' ||
          mode === 'source-late-allocation' ||
          mode === 'source-late-identity'
        )
          bodyMayReturn.resolve()
        else abort.abort()
        await delay(40)
        assert.equal(
          closed,
          false,
          'lease closed before actual I/O and cleanup completed'
        )
        assert.equal(manager.status().active, 1)
        if (mode !== 'cache-unawaited-rename') assert.equal(settled, false)
        if (mode?.includes('write') || mode?.startsWith('cache-read'))
          assert.equal(closes, 0)
        if (mode === 'cache-close-abort') assert.equal(closes, 1)
        held.resolve()
        const error = await outcome
        if (
          mode === 'source-late-allocation' ||
          mode === 'source-late-identity'
        ) {
          assert.equal(
            await materializeTask?.then(
              () => false,
              () => true
            ),
            true,
            'late materialization succeeded after active work ended'
          )
          assert.deepEqual(await fs.readdir(staging), [])
        } else if (mode === 'cache-unawaited-rename') {
          assert.equal(
            await cacheTask?.then(
              () => false,
              () => true
            ),
            true,
            'late unawaited transaction committed after active work ended'
          )
        } else {
          assert.ok(error instanceof Error)
          assert.ok(hasCode(error, 'SOURCE_CANCELLED'))
          if (mode?.endsWith('close-error'))
            assert.ok(hasCode(error, 'SOURCE_IO_FAILED'))
          if (mode === 'source-abort-allocation')
            assert.equal(
              closes,
              0,
              'no source file was opened before allocation completed'
            )
          else if (!mode?.includes('rename')) assert.equal(closes, 1)
        }
        await current.closed
        assert.equal(
          (await fs.readFile(file)).equals(oldBody),
          true,
          'cancelled transaction replaced previous authoritative bytes'
        )
      } else {
        const error = await outcome
        assert.ok(error instanceof Error)
        if (
          mode === 'cache-identity-capture' ||
          mode === 'cache-backup-cleanup-error'
        ) {
          const wasHeld = manager.status().active === 1 && !closed
          if (mode === 'cache-backup-cleanup-error') {
            await manager.reconcile()
            assert.equal(manager.status().ready, false)
            assert.deepEqual(await fs.readdir(staging), [])
            assert.ok(savedScope)
            await assert.rejects(cache.load(savedScope), {
              code: 'INVALID_SOURCE_REQUEST',
            })
          }
          blockCleanup = false
          if (mode === 'cache-identity-capture')
            for (const name of await fs.readdir(cacheRoot))
              if (name.endsWith('.tmp'))
                await unlink(path.join(cacheRoot, name))
          await manager.retryCleanup()
          await current.closed
          assert.equal(
            wasHeld,
            true,
            'incomplete persistent cleanup released the owned workflow'
          )
          assert.equal(manager.status().active, 0)
        } else if (mode === 'source-registration-validation') {
          assert.ok(operationDirectory)
          const retained = await lstat(operationDirectory).then(
            () => true,
            () => false
          )
          Object.defineProperty(fsSync, 'lstatSync', {
            configurable: true,
            value: lstatSync,
          })
          syncBuiltinESMExports()
          if (retained) await fs.rm(operationDirectory, { recursive: true })
          await manager.retryCleanup()
          await current.closed
          assert.equal(
            retained,
            false,
            'failed registration left a created directory after releasing ownership'
          )
        } else if (mode === 'source-identity-capture') {
          const wasHeld = manager.status().active === 1 && !closed
          assert.ok(operationDirectory)
          Object.defineProperty(fsSync, 'lstatSync', {
            configurable: true,
            value: lstatSync,
          })
          syncBuiltinESMExports()
          await fs.rm(operationDirectory, { recursive: true })
          await manager.retryCleanup()
          await current.closed
          assert.equal(
            wasHeld,
            true,
            'unknown created source root released the workflow before deliberate repair'
          )
        } else if (mode === 'root-authority') {
          assert.ok(operationDirectory && movedDirectory)
          assert.equal(
            await fs.readFile(path.join(operationDirectory, 'foreign'), 'utf8'),
            'preserved'
          )
          Object.defineProperty(fs, 'lstat', {
            configurable: true,
            value: lstat,
          })
          syncBuiltinESMExports()
          await rename(operationDirectory, path.join(root, 'foreign-preserved'))
          await rename(movedDirectory, operationDirectory)
          await manager.retryCleanup()
          await current.closed
          assert.equal(
            authorityDenied,
            true,
            'failed final materialization postcondition granted cache-install authority'
          )
          assert.equal(
            await fs.readFile(
              path.join(root, 'foreign-preserved/foreign'),
              'utf8'
            ),
            'preserved'
          )
        } else {
          await current.closed
          assert.equal((await fs.readFile(file)).equals(oldBody), true)
        }
      }
    } finally {
      Object.defineProperty(fsSync, 'lstatSync', {
        configurable: true,
        value: lstatSync,
      })
      syncBuiltinESMExports()
      held.resolve()
      bodyMayReturn.resolve()
      blockCleanup = false
      for (const [name, value] of [
        ['mkdtemp', mkdtemp],
        ['open', open],
        ['rename', rename],
        ['link', link],
        ['unlink', unlink],
        ['lstat', lstat],
      ] as const)
        Object.defineProperty(fs, name, { configurable: true, value })
      syncBuiltinESMExports()
      await outcome
      await materializeTask?.catch(() => {})
      await cacheTask?.catch(() => {})
      if (operationDirectory && movedDirectory) {
        if (
          await lstat(movedDirectory).then(
            () => true,
            () => false
          )
        ) {
          await fs.rm(operationDirectory, { recursive: true, force: true })
          await rename(movedDirectory, operationDirectory)
        }
      }
      for (const name of await fs.readdir(cacheRoot))
        if (name.endsWith('.tmp')) await unlink(path.join(cacheRoot, name))
      await manager.retryCleanup()
    }
  })
  console.log(`${mode} native source owner PASS`)
} finally {
  Object.defineProperty(fsSync, 'lstatSync', {
    configurable: true,
    value: lstatSync,
  })
  syncBuiltinESMExports()
  held.resolve()
  bodyMayReturn.resolve()
  for (const [name, value] of [
    ['mkdtemp', mkdtemp],
    ['open', open],
    ['rename', rename],
    ['link', link],
    ['unlink', unlink],
    ['lstat', lstat],
  ] as const)
    Object.defineProperty(fs, name, { configurable: true, value })
  syncBuiltinESMExports()
}
