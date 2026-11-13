import assert from 'node:assert/strict'
import express from 'express'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  createWorkflowJsonHandler,
  createWorkflowStopHandler,
  createWorkflowResetHandler,
} from '../../../app/js/WorkflowAdmissionHttp.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'

function gate() {
  return Promise.withResolvers<void>()
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(predicate()).toBe(true)
}
describe('prebody workflow HTTP ownership', () => {
  let root: string,
    api: OwnershipApiFixture,
    manager: CompilerAdmission,
    server: Server | undefined,
    port: number
  const consumed = new Map<string, number>()
  const sockets: http.ClientRequest[] = []
  const release: Array<() => void> = []
  beforeEach(async () => {
    consumed.clear()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-http-'))
    api = new OwnershipApiFixture()
    const lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      {
        run: async () => {
          throw new Error('HTTP metadata phase must not run Docker')
        },
      },
      new OwnedJobReconciler(await api.open(), lease),
      { sweepIntervalMs: 60000 }
    )
    await manager.start()
  })
  afterEach(async () => {
    for (const done of release.splice(0)) done()
    for (const req of sockets.splice(0)) req.destroy()
    await manager.retryCleanup().catch(() => {})
    await manager.close()
    server?.closeAllConnections()
    if (server)
      await new Promise<void>(resolve => server?.close(() => resolve()))
    await api.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  async function mount(
    work: (
      request: unknown,
      scope: import('../../../app/js/CompilerAdmission.ts').WorkflowScope
    ) => Promise<
      import('../../../app/js/WorkflowAdmissionHttp.ts').WorkflowHttpResult
    >,
    queueTimeoutMs = 30000,
    bodyLimitBytes = 7 * 1024 * 1024
  ) {
    expect(createWorkflowJsonHandler).toBeTypeOf('function')
    const app = express()
    app.use((req, _res, next) => {
      req.on('data', (chunk: Buffer) =>
        consumed.set(req.url, (consumed.get(req.url) ?? 0) + chunk.length)
      )
      next()
    })
    app.post(
      '/job/:projectId',
      createWorkflowJsonHandler(
        manager,
        req => ({ projectId: req.params.projectId ?? '', kind: 'compile' }),
        (req, scope) => work(req.body, scope),
        { queueTimeoutMs, bodyLimitBytes }
      )
    )
    app.post(
      '/stop/:projectId',
      createWorkflowStopHandler(manager, req => ({
        projectId: req.params.projectId ?? '',
      }))
    )
    app.post(
      '/reset/:projectId',
      createWorkflowResetHandler(
        manager,
        req => ({ projectId: req.params.projectId ?? '' }),
        async () => {
          await fs.writeFile(path.join(root, 'cleared'), 'yes')
        }
      )
    )
    server = http.createServer(app)
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    port = address.port
  }
  function request(route: string) {
    const ended = Promise.withResolvers<{ status: number; body: string }>()
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        agent: false,
      },
      res => {
        let body = ''
        res.on('data', chunk => {
          body += String(chunk)
        })
        res.on('end', () =>
          ended.resolve({ status: res.statusCode ?? 0, body })
        )
        res.on('error', ended.reject)
      }
    )
    req.on('error', ended.reject)
    void ended.promise.catch(() => {})
    sockets.push(req)
    return { req, response: ended.promise }
  }
  it('pauses eight chunked callers before parsing while two active bodies own capacity, rejects the eleventh', async () => {
    let parsed = 0
    await mount(async body => {
      parsed++
      return { statusCode: 200, body }
    })
    const first = request('/job/a'),
      second = request('/job/b')
    first.req.write('{"value":')
    second.req.write('{"value":')
    await until(() => manager.status().active === 2)
    const queued = Array.from({ length: 8 }, (_, i) => {
      const r = request(`/job/q${i}`)
      r.req.end('{"value":1}')
      return r
    })
    await until(() => manager.status().queued === 8)
    expect(parsed).toBe(0)
    expect(
      Array.from({ length: 8 }, (_, i) => consumed.get(`/job/q${i}`) ?? 0)
    ).toEqual(Array(8).fill(0))
    const extra = request('/job/overflow')
    extra.req.end('{"value":2}')
    expect((await extra.response).status).toBe(503)
    expect(parsed).toBe(0)
    expect(await fs.readdir(root)).toEqual(['manager.sock'])
    first.req.end('1}')
    second.req.end('2}')
    expect((await first.response).status).toBe(200)
    expect((await second.response).status).toBe(200)
    expect(
      (await Promise.all(queued.map(r => r.response))).every(
        r => r.status === 200
      )
    ).toBe(true)
    expect(parsed).toBe(10)
  })
  it('never parses a cancelled queued body or a queued deadline body', async () => {
    let parsed = 0
    await mount(async body => {
      parsed++
      return { statusCode: 200, body }
    }, 20)
    const a = request('/job/a'),
      b = request('/job/b')
    a.req.write('{')
    b.req.write('{')
    await until(() => manager.status().active === 2)
    const cancelled = request('/job/cancelled')
    cancelled.req.write('{"value":')
    await until(() => manager.status().queued === 1)
    cancelled.req.destroy()
    await until(() => manager.status().queued === 0)
    const expired = request('/job/expired')
    expired.req.end('{"value":1}')
    expect((await expired.response).status).toBe(503)
    expect(parsed).toBe(0)
    a.req.end('}')
    b.req.end('}')
    await Promise.all([a.response, b.response])
  })
  it('normal request-body completion does not cancel active work, and response waits for owned cleanup', async () => {
    const cleanup = gate()
    release.push(cleanup.resolve)
    let workStarted = false,
      signal: AbortSignal | undefined
    await mount(async (_body, scope) => {
      workStarted = true
      signal = scope.signal
      scope.ownWorkspace(
        await fs.mkdtemp(path.join(root, 'workspace-')),
        () => cleanup.promise
      )
      return { statusCode: 200, body: { ok: true } }
    })
    const r = request('/job/p')
    r.req.end('{"value":1}')
    let responded = false
    void r.response.then(() => {
      responded = true
    })
    await until(() => workStarted)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(signal?.aborted).toBe(false)
    expect(responded).toBe(false)
    expect(manager.status().active).toBe(1)
    cleanup.resolve()
    expect((await r.response).status).toBe(200)
  })
  it('stop bypasses a full job queue, aborts slow active parsing, and reset waits for held cleanup', async () => {
    const cleanup = gate()
    release.push(cleanup.resolve)
    let entered = false
    await mount(async (_body, scope) => {
      entered = true
      scope.ownWorkspace(
        await fs.mkdtemp(path.join(root, 'workspace-')),
        () => cleanup.promise
      )
      return { statusCode: 200, body: { ok: true } }
    })
    const owned = request('/job/owned')
    owned.req.end('{}')
    await until(() => entered)
    const slow = request('/job/slow')
    slow.req.write('{')
    await until(() => manager.status().active === 2)
    const queued = Array.from({ length: 8 }, (_, i) => {
      const r = request(`/job/q${i}`)
      r.req.end('{}')
      return r
    })
    await until(() => manager.status().queued === 8)
    const stopped = request('/stop/slow')
    stopped.req.end('{}')
    expect((await stopped.response).status).toBe(204)
    await slow.response.catch(() => undefined)
    const reset = request('/reset/owned')
    reset.req.end('{}')
    let cleared = false
    void reset.response.then(() => {
      cleared = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cleared).toBe(false)
    await assert.rejects(fs.stat(path.join(root, 'cleared')), {
      code: 'ENOENT',
    })
    cleanup.resolve()
    expect((await reset.response).status).toBe(204)
    expect(await fs.readFile(path.join(root, 'cleared'), 'utf8')).toBe('yes')
    await owned.response
    await Promise.all(queued.map(r => r.response))
  })
  it('control ownership continues after the control client disconnects', async () => {
    const cleanup = gate()
    release.push(cleanup.resolve)
    let started = false
    await mount(async (_body, scope) => {
      scope.ownWorkspace(
        await fs.mkdtemp(path.join(root, 'workspace-')),
        () => cleanup.promise
      )
      // This test stops already-owned cleanup, so readiness follows binding.
      started = true
      return { statusCode: 200, body: {} }
    })
    const job = request('/job/p')
    job.req.end('{}')
    await until(() => started)
    const stop = request('/stop/p')
    stop.req.write('{')
    await until(() => manager.status().controlFences === 1)
    stop.req.destroy()
    await stop.response.catch(() => undefined)
    expect(manager.status().active).toBe(1)
    cleanup.resolve()
    await until(
      () =>
        manager.status().active === 0 && manager.status().controlFences === 0
    )
    await job.response
  })
  it('enforces JSON byte limit only in admitted work and never calls user work on oversize or invalid JSON', async () => {
    let calls = 0
    await mount(
      async () => {
        calls++
        return { statusCode: 200, body: { ok: true } }
      },
      30000,
      32
    )
    const big = request('/job/a')
    big.req.end(JSON.stringify({ value: 'x'.repeat(40) }))
    expect((await big.response).status).toBe(413)
    const bad = request('/job/b')
    bad.req.end('{invalid')
    expect((await bad.response).status).toBe(400)
    expect(calls).toBe(0)
  })
})
