import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import express from 'express'
import { test } from 'vitest'
import { openCompilerWorkflow } from '../../../app/js/CompilerWorkflow.ts'
import { createCompilerWorkflowRouter } from '../../../app/js/CompilerWorkflowHttp.ts'
import { queueDirOperation } from '../../../app/js/OutputCacheManager.js'
import { withSourceFixture } from './SourceInputFixture.ts'
import type { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
const projectId = '1234567890abcdef12345678',
  buildId = 'abcdef-345678'
async function withPublished(
  use: (
    origin: string,
    target: string,
    logical: string,
    manager: CompilerAdmission
  ) => Promise<void>
) {
  await withSourceFixture(async (root, manager) => {
    const outputRoot = path.join(root, 'output'),
      logical = path.join(outputRoot, projectId),
      build = path.join(logical, 'generated-files', buildId)
    await fs.mkdir(build, { recursive: true, mode: 0o700 })
    const target = path.join(build, 'output.log')
    await fs.writeFile(target, Buffer.alloc(128 * 1024, 65), { mode: 0o600 })
    const workflow = await openCompilerWorkflow(manager, {
      stagingRoot: path.join(root, 'operations'),
      sourceCacheRoot: path.join(root, 'plans'),
      outputRoot,
      defaultImage: `sha256:${'d'.repeat(64)}`,
      profiles: [],
      publication: {
        optimiseInDocker: true,
        archiveLogs: false,
        strace: false,
        pdfCaching: false,
        clsiCache: false,
      },
    })
    const app = express()
    app.use(
      createCompilerWorkflowRouter(manager, workflow, {
        downloadHost: 'http://synthetic.invalid',
        outputUrlPrefix: '',
      })
    )
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    try {
      await use(
        'http://127.0.0.1:' +
          address.port +
          '/project/' +
          projectId +
          '/build/' +
          buildId +
          '/output/',
        target,
        logical,
        manager
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
}
async function withFileHook<T>(
  target: string,
  patch: (file: FileHandle) => void,
  use: () => Promise<T>
): Promise<T> {
  const open = fs.open
  Object.defineProperty(fs, 'open', {
    configurable: true,
    value: async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args)
      if (args[0] === target) patch(file)
      return file
    },
  })
  syncBuiltinESMExports()
  try {
    return await use()
  } finally {
    Object.defineProperty(fs, 'open', { configurable: true, value: open })
    syncBuiltinESMExports()
  }
}
test('published reader holds the actual output queue and active capacity through real descriptor close completion', async () => {
  await withPublished(async (origin, target, logical, manager) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let following = false
    await withFileHook(
      target,
      file => {
        const close = file.close.bind(file)
        Object.defineProperty(file, 'close', {
          value: async () => {
            entered.resolve()
            await release.promise
            await close()
          },
        })
      },
      async () => {
        const fetched = fetch(origin + 'output.log').then(response =>
          response.arrayBuffer()
        )
        try {
          await entered.promise
          const queued = queueDirOperation(logical, async () => {
            following = true
          })
          await new Promise<void>(resolve => setImmediate(resolve))
          assert.equal(following, false)
          assert.equal(manager.status().active, 1)
          release.resolve()
          await fetched
          await queued
          assert.equal(following, true)
        } finally {
          release.resolve()
          await fetched.catch(() => {})
        }
      }
    )
  })
})
test('disconnect during a real held read cannot close its descriptor or release capacity until the actual read result joins', async () => {
  await withPublished(async (origin, target, _logical, manager) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let pending = false,
      closes = 0
    await withFileHook(
      target,
      file => {
        const read = file.read.bind(file),
          close = file.close.bind(file)
        Object.defineProperty(file, 'read', {
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null
          ) => {
            const result = await read(buffer, offset, length, position)
            pending = true
            entered.resolve()
            await release.promise
            pending = false
            return result
          },
        })
        Object.defineProperty(file, 'close', {
          value: async () => {
            closes++
            assert.equal(pending, false, 'read result was not joined')
            await close()
          },
        })
      },
      async () => {
        const request = http.get(origin + 'output.log')
        request.on('error', () => {})
        try {
          await entered.promise
          request.destroy()
          await new Promise<void>(resolve => setTimeout(resolve, 20))
          assert.equal(manager.status().active, 1)
          assert.equal(closes, 0)
        } finally {
          release.resolve()
          request.destroy()
        }
      }
    )
  })
})
test('ZIP failure retains its exact descriptor for cleanup retry even after the build path is removed', async () => {
  await withPublished(async (origin, target, _logical, manager) => {
    const entered = Promise.withResolvers<void>(),
      retried = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let closes = 0
    await withFileHook(
      target,
      file => {
        const close = file.close.bind(file)
        Object.defineProperty(file, 'close', {
          value: async () => {
            if (++closes <= 3) {
              if (closes === 3) entered.resolve()
              throw new Error('synthetic close refusal')
            }
            retried.resolve()
            await release.promise
            await close()
          },
        })
      },
      async () => {
        const fetched = fetch(origin + 'output.zip').then(response =>
          response.arrayBuffer()
        )
        void fetched.catch(() => {})
        try {
          await entered.promise
          await new Promise<void>(resolve => setImmediate(resolve))
          assert.equal(manager.status().active, 1)
          await fs.rm(path.dirname(target), { recursive: true })
          const cleanup = manager.retryCleanup()
          await retried.promise
          assert.equal(manager.status().active, 1)
          release.resolve()
          await cleanup
          assert.equal(manager.status().active, 0)
        } finally {
          release.resolve()
          await fetched.catch(() => {})
        }
      }
    )
  })
})
