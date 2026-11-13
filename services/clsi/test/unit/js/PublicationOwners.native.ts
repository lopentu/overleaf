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
import { openCompileOutputPublisher } from '../../../app/js/CompileOutputPublisher.ts'
const mode = process.argv[2]
assert.ok(
  [
    'read-abort',
    'write-abort',
    'rename-abort',
    'rollback-retry',
    'rename-reject',
    'parent-create-reject',
    'read-return',
    'rename-return',
    'read-reset',
    'foreign-target',
    'committed-abort',
    'close-abort',
    'device-guard',
    'one-open-directory',
  ].includes(mode ?? '')
)
const PROJECT = '1234567890abcdef12345678'
const profile = {
  optimiseInDocker: true,
  archiveLogs: false,
  strace: false,
  pdfCaching: false,
  clsiCache: false,
}
const held = Promise.withResolvers<void>(),
  entered = Promise.withResolvers<void>()
const original = {
  open: fs.open,
  rename: fs.rename,
  rm: fs.rm,
  mkdir: fs.mkdir,
  lstat: fs.lstat,
  opendir: fs.opendir,
}
let blockRollback = true,
  closes = 0
try {
  await withSourceFixture(async (root, manager) => {
    const outputRoot = path.join(root, 'published'),
      finalParent = path.join(outputRoot, PROJECT),
      final = path.join(finalParent, 'generated-files/abcdef-123456')
    await fs.mkdir(outputRoot, { mode: 0o700 })
    const unit = await openCompileOutputPublisher(manager, {
      outputRoot,
      profile,
    })
    const abort = new AbortController(),
      lease = await manager.acquire(
        { projectId: PROJECT, kind: 'compile' },
        { signal: abort.signal }
      )
    let operation: string | undefined,
      closed = false
    void lease.closed.then(() => {
      closed = true
    })
    Object.defineProperty(fs, 'open', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = await original.open(...args),
          name = typeof args[0] === 'string' ? args[0] : ''
        const selected =
          (['read-abort', 'read-return', 'read-reset'].includes(mode ?? '') &&
            name.endsWith('/artifacts/output.pdf')) ||
          (['write-abort', 'close-abort'].includes(mode ?? '') &&
            name.includes('/publication-') &&
            name.endsWith('/output.pdf'))
        if (selected) {
          const close = file.close.bind(file)
          Object.defineProperty(file, 'close', {
            value: async () => {
              closes++
              if (mode === 'close-abort') {
                entered.resolve()
                await held.promise
              }
              await close()
            },
          })
          if (
            ['read-abort', 'read-return', 'read-reset'].includes(mode ?? '')
          ) {
            const read = file.read.bind(file)
            Object.defineProperty(file, 'read', {
              value: async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null
              ) => {
                const result = await read(buffer, offset, length, position)
                entered.resolve()
                await held.promise
                return result
              },
            })
          } else if (mode === 'write-abort') {
            const write = file.write.bind(file)
            Object.defineProperty(file, 'write', {
              value: async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null
              ) => {
                const result = await write(buffer, offset, length, position)
                entered.resolve()
                await held.promise
                return result
              },
            })
          }
        }
        return file
      },
    })
    Object.defineProperty(fs, 'rename', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.rename>) => {
        const result = await original.rename(...args)
        if (typeof args[0] === 'string' && args[0].includes('/publication-')) {
          if (mode === 'rename-reject')
            throw new Error('synthetic late rename acknowledgement failure')
          if (mode === 'foreign-target') {
            await original.rename(final, path.join(root, 'displaced-owned'))
            await original.mkdir(final, { mode: 0o700 })
            await fs.writeFile(
              path.join(final, 'foreign.txt'),
              'preserve unrelated replacement'
            )
          }
          if (
            mode === 'rename-abort' ||
            mode === 'rollback-retry' ||
            mode === 'rename-return'
          ) {
            entered.resolve()
            await held.promise
          }
        }
        return result
      },
    })
    Object.defineProperty(fs, 'mkdir', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.mkdir>) => {
        const result = await original.mkdir(...args)
        if (mode === 'parent-create-reject' && args[0] === finalParent)
          throw new Error('synthetic late mkdir acknowledgement failure')
        return result
      },
    })
    Object.defineProperty(fs, 'rm', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.rm>) => {
        if (mode === 'rollback-retry' && blockRollback && args[0] === final)
          throw new Error('synthetic final target cleanup failure')
        return await original.rm(...args)
      },
    })
    Object.defineProperty(fs, 'lstat', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original.lstat(...args)
        if (
          mode === 'device-guard' &&
          typeof args[0] === 'string' &&
          args[0].endsWith('/artifacts')
        ) {
          if (typeof stat.dev === 'number') stat.dev += 1
          else stat.dev += 1n
        }
        return stat
      },
    })
    let measuringDirectories = false
    let previousDirectory: Awaited<ReturnType<typeof fs.opendir>> | undefined
    Object.defineProperty(fs, 'opendir', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.opendir>) => {
        if (
          mode === 'one-open-directory' &&
          measuringDirectories &&
          previousDirectory
        ) {
          let closed = false
          try {
            await previousDirectory.read()
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ERR_DIR_CLOSED'
            )
              closed = true
            else throw error
          }
          if (!closed)
            throw new Error('synthetic single-directory-handle budget')
        }
        const directory = await original.opendir(...args)
        if (measuringDirectories) previousDirectory = directory
        return directory
      },
    })
    syncBuiltinESMExports()
    const work = lease.run(async scope => {
      const plan = await parseFullSourcePlan(
        scope,
        Buffer.from(
          '{"compile":{"resources":[{"path":"main.tex","content":"source"}]}}'
        )
      )
      const source = await materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      operation = path.dirname(source.stagingRoot)
      const artifacts = path.join(source.stagingRoot, 'artifacts')
      await fs.mkdir(artifacts, { mode: 0o700 })
      await fs.writeFile(path.join(artifacts, 'output.pdf'), 'complete payload')
      if (mode === 'one-open-directory') {
        await fs.mkdir(path.join(artifacts, 'nested'))
        await fs.writeFile(
          path.join(artifacts, 'nested/output.log'),
          'nested complete'
        )
      }
      measuringDirectories = mode === 'one-open-directory'
      const publication = unit
        .publish(scope, {
          outputDirectory: artifacts,
          buildId: 'abcdef-123456',
        })
        .finally(() => {
          measuringDirectories = false
        })
      if (mode === 'read-return' || mode === 'rename-return') {
        void publication.catch(() => {})
        await entered.promise
        return undefined
      }
      return await publication
    })
    let settled = false
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
    let reset: Promise<void> | undefined,
      resetDone = false
    try {
      if (
        [
          'close-abort',
          'read-return',
          'rename-return',
          'read-reset',
          'read-abort',
          'write-abort',
          'rename-abort',
          'rollback-retry',
        ].includes(mode ?? '')
      ) {
        assert.equal(
          await Promise.race([
            entered.promise.then(() => true),
            outcome.then(() => false),
          ]),
          true,
          'actual held I/O was not reached'
        )
        if (mode === 'read-reset')
          reset = manager.reset({ projectId: PROJECT }, async () => {
            resetDone = true
          })
        else if (mode !== 'read-return' && mode !== 'rename-return')
          abort.abort()
        await delay(30)
        assert.equal(
          settled,
          false,
          'operation settled while its actual I/O remained held'
        )
        assert.equal(closed, false)
        assert.equal(manager.status().active, 1)
        assert.equal(resetDone, false)
        if (
          ['read-abort', 'read-return', 'read-reset', 'write-abort'].includes(
            mode ?? ''
          )
        )
          assert.equal(closes, 0)
        held.resolve()
      }
      const result = await outcome
      if (mode === 'read-return' || mode === 'rename-return')
        assert.equal(result, undefined)
      else if (mode === 'committed-abort' || mode === 'one-open-directory') {
        assert.ok(result && typeof result === 'object' && 'buildId' in result)
        abort.abort()
      } else assert.ok(result instanceof Error)
      if (reset) {
        await reset
        assert.equal(resetDone, true)
      }
      if (mode === 'one-open-directory') {
        await lease.closed
        assert.equal(
          await fs.readFile(path.join(final, 'nested/output.log'), 'utf8'),
          'nested complete'
        )
        assert.ok(previousDirectory)
        await assert.rejects(previousDirectory.read(), {
          code: 'ERR_DIR_CLOSED',
        })
      } else if (mode === 'device-guard') {
        await lease.closed
        assert.deepEqual(await fs.readdir(outputRoot), [])
      } else if (mode === 'committed-abort') {
        await lease.closed
        assert.equal(
          await fs.readFile(path.join(final, 'output.pdf'), 'utf8'),
          'complete payload'
        )
      } else if (mode === 'foreign-target') {
        assert.equal(
          await fs.readFile(path.join(final, 'foreign.txt'), 'utf8'),
          'preserve unrelated replacement'
        )
        assert.equal(manager.status().active, 1)
        assert.equal(closed, false)
        await original.rm(final, { recursive: true })
        await manager.retryCleanup()
        await lease.closed
      } else if (mode === 'rollback-retry') {
        assert.ok(operation)
        assert.equal(
          await fs.lstat(operation).then(
            () => true,
            () => false
          ),
          false,
          'outer source factory did not remove its operation root'
        )
        assert.equal(manager.status().active, 1)
        assert.equal(closed, false)
        assert.equal(
          await fs.readFile(path.join(final, 'output.pdf'), 'utf8'),
          'complete payload'
        )
        blockRollback = false
        await manager.retryCleanup()
        await lease.closed
        assert.equal(
          await fs.lstat(final).then(
            () => true,
            () => false
          ),
          false,
          'persistent cleanup depended on removed private parent'
        )
      } else if (mode === 'rename-reject') {
        const retained = await fs.lstat(final).then(
          () => true,
          () => false
        )
        if (retained) await original.rm(final, { recursive: true })
        await manager.retryCleanup()
        await lease.closed
        assert.equal(
          retained,
          false,
          'rename rejection left the exact newly owned target instead of reconciling rollback'
        )
      } else if (mode === 'parent-create-reject') {
        const wasHeld = manager.status().active === 1 && !closed
        assert.equal(
          await fs.lstat(finalParent).then(
            () => true,
            () => false
          ),
          true
        )
        await original.rm(finalParent, { recursive: true })
        await manager.retryCleanup()
        await lease.closed
        assert.equal(
          wasHeld,
          true,
          'ambiguous persistent parent allocation released ownership'
        )
      } else {
        await lease.closed
        assert.equal(
          await fs.lstat(final).then(
            () => true,
            () => false
          ),
          false
        )
        assert.equal(manager.status().active, 0)
        if (
          ['read-abort', 'read-return', 'read-reset', 'write-abort'].includes(
            mode ?? ''
          )
        )
          assert.equal(closes, 1)
      }
    } finally {
      held.resolve()
      blockRollback = false
      for (const [name, value] of Object.entries(original))
        Object.defineProperty(fs, name, { configurable: true, value })
      syncBuiltinESMExports()
      await outcome
      if (
        await fs.lstat(final).then(
          () => true,
          () => false
        )
      )
        await original.rm(final, { recursive: true })
      if (
        mode === 'parent-create-reject' &&
        (await fs.lstat(finalParent).then(
          () => true,
          () => false
        ))
      )
        await original.rm(finalParent, { recursive: true })
      await manager.retryCleanup()
    }
  })
  console.log(`${mode} native publication owner PASS`)
} finally {
  held.resolve()
  blockRollback = false
  for (const [name, value] of Object.entries(original))
    Object.defineProperty(fs, name, { configurable: true, value })
  syncBuiltinESMExports()
}
