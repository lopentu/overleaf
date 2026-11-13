import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'vitest'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const MiB = 1024 * 1024
function body(
  resources: { path: string; url: string; fallbackURL?: string }[]
) {
  return Buffer.from(
    JSON.stringify({ compile: { options: { syncType: 'full' }, resources } })
  )
}
async function server(
  run: (base: string, requests: string[]) => Promise<void>,
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) => void
) {
  const requests: string[] = []
  const instance = http.createServer((req, res) => {
    requests.push((req.url ?? '').split('?')[0]!)
    handler(req, res)
  })
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`, requests)
  } finally {
    instance.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      instance.close(error => (error ? reject(error) : resolve()))
    )
  }
}
function send(response: http.ServerResponse, size: number, fill = 7) {
  void pipeline(
    Readable.from(
      (function* () {
        const chunk = Buffer.alloc(64 * 1024, fill)
        while (size > 0) {
          const count = Math.min(size, chunk.length)
          yield chunk.subarray(0, count)
          size -= count
        }
      })()
    ),
    response
  ).catch(() => {})
}
for (const extra of [0, 1]) {
  test(`a real URL stream enforces50MiB plus${extra} before disk writes and never retries a limit`, async () => {
    await server(
      async (base, requests) => {
        await withSourceFixture(async (root, manager) => {
          const lease = await manager.acquire({
            projectId: PROJECT,
            kind: 'compile',
          })
          const pending = lease.run(async scope => {
            const plan = await parseFullSourcePlan(
              scope,
              body([{ path: 'binary.dat', url: base + '/large' }])
            )
            const source = await materializeFullSource(scope, plan, {
              stagingRoot: path.join(root, 'operations'),
            })
            assert.equal(
              (await fs.stat(path.join(source.sourceDirectory, 'binary.dat')))
                .size,
              50 * MiB
            )
            const file = await fs.open(
              path.join(source.sourceDirectory, 'binary.dat')
            )
            try {
              const one = Buffer.alloc(1)
              await file.read(one, 0, 1, 50 * MiB - 1)
              assert.equal(one[0], 7)
            } finally {
              await file.close()
            }
          })
          if (extra) await assert.rejects(pending, { code: 'INPUT_LIMIT' })
          else await pending
          await lease.closed
          assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
          assert.deepEqual(requests, ['/large'])
        })
      },
      (_req, response) => send(response, 50 * MiB + extra)
    )
  }, 15000)
}
for (const extra of [0, 1]) {
  test(`two real50MiB downloads enforce aggregate100MiB plus${extra}`, async () => {
    await server(
      async (base, _requests) => {
        await withSourceFixture(async (root, manager) => {
          const lease = await manager.acquire({
            projectId: PROJECT,
            kind: 'compile',
          })
          const resources = [
            { path: 'one', url: base + '/large' },
            { path: 'two', url: base + '/large' },
          ]
          if (extra) resources.push({ path: 'extra', url: base + '/one-byte' })
          const pending = lease.run(async scope => {
            const plan = await parseFullSourcePlan(scope, body(resources))
            const source = await materializeFullSource(scope, plan, {
              stagingRoot: path.join(root, 'operations'),
            })
            assert.equal(
              (await fs.stat(path.join(source.sourceDirectory, 'one'))).size +
                (await fs.stat(path.join(source.sourceDirectory, 'two'))).size,
              100 * MiB
            )
          })
          if (extra) await assert.rejects(pending, { code: 'INPUT_LIMIT' })
          else await pending
          await lease.closed
          assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
        })
      },
      (req, response) => send(response, req.url === '/one-byte' ? 1 : 50 * MiB)
    )
  }, 20000)
}
test('real404 uses only the supplied fallback and writes exact binary bytes', async () => {
  await server(
    async (base, requests) => {
      await withSourceFixture(async (root, manager) => {
        const lease = await manager.acquire({
          projectId: PROJECT,
          kind: 'compile',
        })
        await lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            body([
              {
                path: 'binary',
                url: base + '/missing',
                fallbackURL: base + '/fallback',
              },
            ])
          )
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          assert.deepEqual(
            await fs.readFile(path.join(source.sourceDirectory, 'binary')),
            Buffer.from([0, 255, 10])
          )
        })
        assert.deepEqual(requests, ['/missing', '/fallback'])
      })
    },
    (req, res) => {
      if (req.url === '/missing') {
        res.statusCode = 404
        res.end('missing')
      } else res.end(Buffer.from([0, 255, 10]))
    }
  )
})
test('non404 failure retries three times, never uses fallback, and sanitizes source-bearing errors', async () => {
  await server(
    async (base, requests) => {
      await withSourceFixture(async (root, manager) => {
        const lease = await manager.acquire({
          projectId: PROJECT,
          kind: 'compile',
        })
        const pending = lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            body([
              {
                path: 'failed',
                url: base + '/failed?token=synthetic-private-download',
                fallbackURL: base + '/forbidden-fallback',
              },
            ])
          )
          return await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
        })
        await assert.rejects(pending, error => {
          assert.ok(error instanceof Error)
          assert.equal(
            error.message.includes('synthetic-private-download'),
            false
          )
          assert.equal('cause' in error, false)
          return 'code' in error && error.code === 'SOURCE_DOWNLOAD_FAILED'
        })
        assert.deepEqual(requests, ['/failed', '/failed', '/failed'])
        assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
      })
    },
    (_req, res) => {
      res.statusCode = 500
      res.end('synthetic-private-download')
    }
  )
})
test('a partial failed response is closed and removed before a retry writes exact replacement bytes', async () => {
  let attempts = 0
  await server(
    async (base, requests) => {
      await withSourceFixture(async (root, manager) => {
        const lease = await manager.acquire({
          projectId: PROJECT,
          kind: 'compile',
        })
        await lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            body([{ path: 'file', url: base + '/retry' }])
          )
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          assert.equal(
            await fs.readFile(
              path.join(source.sourceDirectory, 'file'),
              'utf8'
            ),
            'complete'
          )
        })
        assert.deepEqual(requests, ['/retry', '/retry'])
      })
    },
    (_req, res) => {
      if (++attempts === 1) {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
        setImmediate(() => res.destroy())
      } else res.end('complete')
    }
  )
})
test('a workflow abort joins the real HTTP response close and owned workspace cleanup', async () => {
  const entered = Promise.withResolvers<void>(),
    closed = Promise.withResolvers<void>()
  await server(
    async (base, _requests) => {
      await withSourceFixture(async (root, manager) => {
        const cancel = new AbortController()
        const lease = await manager.acquire(
          { projectId: PROJECT, kind: 'compile' },
          { signal: cancel.signal }
        )
        let settled = false
        const pending = lease
          .run(async scope => {
            const plan = await parseFullSourcePlan(
              scope,
              body([{ path: 'held', url: base + '/held' }])
            )
            return await materializeFullSource(scope, plan, {
              stagingRoot: path.join(root, 'operations'),
            })
          })
          .finally(() => {
            settled = true
          })
        void pending.catch(() => {})
        const reached = await Promise.race([
          entered.promise.then(() => true),
          pending.then(
            () => false,
            () => false
          ),
        ])
        assert.equal(
          reached,
          true,
          'bounded download did not reach the real server'
        )
        cancel.abort()
        await assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
        await closed.promise
        await lease.closed
        assert.equal(settled, true)
        assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
      })
    },
    (_req, res) => {
      res.on('close', () => closed.resolve())
      res.writeHead(200)
      res.write('held')
      entered.resolve()
    }
  )
})
