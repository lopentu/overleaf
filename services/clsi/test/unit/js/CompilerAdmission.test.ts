import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import type { JobRequest, JobResult } from '../../../app/js/JobRequest.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'
import { gate } from './DockerApiFixture.ts'

class ControlledExecutor {
  readonly calls: { request: JobRequest; identity: string | undefined }[] = []
  readonly pending: { release: () => void; fail: (error: Error) => void }[] = []
  run(request: JobRequest, identity?: string): Promise<JobResult> {
    this.calls.push({ request, identity })
    return new Promise<JobResult>((resolve, reject) => {
      this.pending.push({
        release: () =>
          resolve({
            exitCode: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            output: { entries: 0, files: 0, bytes: 0 },
            outputDirectory: request.outputDirectory,
          }),
        fail: reject,
      })
    })
  }
  release(index: number): void {
    const item = this.pending[index]
    if (!item) throw new Error('missing job')
    item.release()
  }
}

describe('bounded compiler admission', () => {
  let root: string
  let lease: CompilerLease
  let api: OwnershipApiFixture
  let executor: ControlledExecutor
  let manager: CompilerAdmission
  const outcomes: Promise<unknown>[] = []
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-admission-'))
    api = new OwnershipApiFixture()
    const docker = await api.open()
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    executor = new ControlledExecutor()
    manager = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(docker, lease),
      { sweepIntervalMs: 60_000 }
    )
    await manager.start()
  })
  afterEach(async () => {
    for (const pending of executor.pending) pending.release()
    await manager.close()
    await Promise.all(outcomes.splice(0))
    await lease.close()
    await api.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  function request(key: string): JobRequest {
    return {
      image: `sha256:${'a'.repeat(64)}`,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: path.join(root, key, 'input'),
      outputDirectory: path.join(root, key, 'output'),
      timeoutMs: 1000,
    }
  }
  function submit(
    key: string,
    input = request(key),
    queueTimeoutMs?: number
  ): Promise<unknown> {
    const promise = manager
      .submit(key, input, queueTimeoutMs)
      .catch((error: unknown) => error)
    outcomes.push(promise)
    return promise
  }
  async function turn(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  it('admits exactly two, queues eight metadata requests, and rejects the eleventh without invoking it', async () => {
    for (let i = 0; i < 10; i++) submit(String(i))
    expect(executor.calls).toHaveLength(2)
    expect(manager.status()).toMatchObject({ active: 2, queued: 8 })
    const overflow = submit('overflow')
    await turn()
    expect(manager.status().queued).toBe(8)
    expect(await overflow).toMatchObject({ code: 'OVERLOADED' })
    expect(executor.calls).toHaveLength(2)
    // Queued paths deliberately do not exist: no file staging or validation I/O is performed here.
    expect(await fs.readdir(root)).toEqual(['manager.sock'])
    const closing = manager.close()
    for (const pending of executor.pending) pending.release()
    await closing
  })
  it('keeps FIFO order, holds a conflicting head, and excludes both project and overlapping directories', async () => {
    submit('project-a')
    submit('project-b')
    submit('project-a', request('a-next'))
    submit('project-c', request('c'))
    executor.release(1)
    await turn()
    expect(executor.calls).toHaveLength(2)
    executor.release(0)
    await turn()
    expect(executor.calls.map(call => call.request.inputDirectory)).toEqual([
      request('project-a').inputDirectory,
      request('project-b').inputDirectory,
      request('a-next').inputDirectory,
      request('c').inputDirectory,
    ])
    const shared = request('nested')
    shared.inputDirectory = path.join(request('c').inputDirectory, 'child')
    submit('project-d', shared)
    executor.release(2)
    await turn()
    expect(executor.calls).toHaveLength(4)
    executor.release(3)
    await turn()
    expect(executor.calls).toHaveLength(5)
  })
  it('removes a cancelled queued request and never invokes its executor', async () => {
    submit('a')
    submit('b')
    const controller = new AbortController()
    const queued = submit('cancelled', {
      ...request('cancelled'),
      signal: controller.signal,
    })
    controller.abort()
    await turn()
    expect(manager.status().queued).toBe(0)
    expect(await queued).toMatchObject({ code: 'CANCELLED' })
    expect(manager.status()).toMatchObject({ active: 2, queued: 0 })
    expect(executor.calls).toHaveLength(2)
  })
  it('expires queued work clearly and rejects waits longer than thirty seconds', async () => {
    submit('a')
    submit('b')
    expect(await submit('expired', request('expired'), 5)).toMatchObject({
      code: 'QUEUE_DEADLINE',
    })
    expect(await submit('invalid', request('invalid'), 30_001)).toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(executor.calls).toHaveLength(2)
  })
  it('retains a cancelled or hung active slot and UUID until executor cleanup settles', async () => {
    const controller = new AbortController()
    const active = submit('a', { ...request('a'), signal: controller.signal })
    submit('b')
    submit('c')
    const identity = executor.calls[0]?.identity
    expect(identity).toMatch(/^[a-f0-9-]{36}$/)
    controller.abort()
    await turn()
    expect(executor.calls[0]?.request.signal?.aborted).toBe(true)
    expect(manager.status()).toMatchObject({ active: 2, queued: 1 })
    api.addContainer(identity ?? randomUUID())
    await manager.reconcile()
    expect(api.containers.size).toBe(1)
    expect(executor.calls).toHaveLength(2)
    executor.release(0)
    await active
    await turn()
    expect(executor.calls).toHaveLength(3)
    await manager.reconcile()
    expect(api.containers.size).toBe(0)
  })
  it('blocks admission and rejects queued work on sweep failure, then recovers only after a successful sweep', async () => {
    submit('a')
    submit('b')
    const queued = submit('c')
    api.failures.add('list')
    await assert.rejects(manager.reconcile(), /reconcil|list/i)
    expect(await queued).toMatchObject({ code: 'RECONCILIATION_FAILED' })
    expect(await submit('blocked')).toMatchObject({
      code: 'RECONCILIATION_FAILED',
    })
    expect(manager.status().reconciliationError).toBeInstanceOf(Error)
    api.failures.clear()
    await manager.reconcile()
    submit('recovered')
    executor.release(0)
    await turn()
    expect(executor.calls).toHaveLength(3)
  })
  it('reconciles an ambiguous late create periodically without overlapping sweeps', async () => {
    await manager.close()
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(await api.client(), lease),
      { sweepIntervalMs: 10 }
    )
    await manager.start()
    const identity = randomUUID()
    api.addContainer(identity)
    api.addVolume(identity)
    const held = gate()
    api.listHold = held.promise
    const first = manager.reconcile()
    const second = manager.reconcile()
    await turn()
    expect(api.maxConcurrentLists).toBe(1)
    held.release()
    await Promise.all([first, second])
    expect(api.containers.size + api.volumes.size).toBe(0)
    api.addContainer(randomUUID())
    for (let n = 0; n < 30 && api.containers.size; n++)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(api.containers.size).toBe(0)
  })
  it('rejects unbounded metadata before retaining or invoking it, and snapshots accepted metadata', async () => {
    submit('a')
    submit('b')
    expect(await submit('x'.repeat(129))).toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(
      await submit('huge', { ...request('huge'), argv: ['x'.repeat(65537)] })
    ).toMatchObject({ code: 'INVALID_REQUEST' })
    const queuedRequest = request('snapshot')
    submit('snapshot', queuedRequest)
    queuedRequest.inputDirectory = '/changed'
    executor.release(0)
    await turn()
    expect(executor.calls[2]?.request.inputDirectory).toBe(
      request('snapshot').inputDirectory
    )
  })
  it('retains only declared metadata, dropping any unexpected archive or closure property', async () => {
    const input = Object.assign(request('extra'), {
      archive: Buffer.alloc(1024),
      callback: () => 'not queued',
    })
    submit('extra', input)
    expect(executor.calls[0]?.request).not.toHaveProperty('archive')
    expect(executor.calls[0]?.request).not.toHaveProperty('callback')
  })
  it('does not admit or perform a sweep before startup, or after the OS lease is lost', async () => {
    await manager.close()
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    const unstarted = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(await api.client(), lease)
    )
    const calls = api.listCalls
    await assert.rejects(unstarted.submit('new', request('new')), {
      code: 'NOT_READY',
    })
    expect(api.listCalls).toBe(calls)
    await lease.close()
    await assert.rejects(unstarted.start(), /lease/i)
    expect(api.listCalls).toBe(calls)
    await assert.rejects(unstarted.submit('lost', request('lost')), /lease/i)
    expect(executor.calls).toHaveLength(0)
  })
  it('keeps the actual singleton listener while shutdown waits for hung cleanup, rejecting its queue', async () => {
    submit('a')
    submit('b')
    const queued = submit('c')
    let closed = false
    const closing = manager.close().then(() => {
      closed = true
    })
    expect(await queued).toMatchObject({ code: 'CLOSED' })
    await turn()
    expect(closed).toBe(false)
    await assert.rejects(
      CompilerLease.acquire(path.join(root, 'manager.sock')),
      /already exists|EADDRINUSE/
    )
    expect(await submit('after-close')).toMatchObject({ code: 'CLOSED' })
    executor.release(0)
    executor.release(1)
    await closing
    expect(closed).toBe(true)
  })
  it('does not reuse a successful sweep started before failed active cleanup settled', async () => {
    submit('a')
    submit('b')
    submit('c')
    const identity = executor.calls[0]?.identity
    if (!identity) throw new Error('missing active identity')
    api.addContainer(identity)
    const held = gate()
    api.volumeListHold = held.promise
    const sweeping = manager.reconcile()
    for (let n = 0; n < 50 && api.listCalls < 4; n++)
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    expect(api.listCalls).toBe(4)
    executor.pending[0]?.fail(new Error('cleanup failed after container list'))
    await turn()
    expect(executor.calls).toHaveLength(2)
    held.release()
    await sweeping
    for (let n = 0; n < 50 && executor.calls.length < 3; n++)
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    expect(executor.calls).toHaveLength(3)
    expect(api.containers.size).toBe(0)
  })
  it('checks elapsed queue time again before dispatch even when the timer callback has not run', async () => {
    submit('a')
    submit('b')
    const queued = submit('late', request('late'), 5)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    executor.release(0)
    await turn()
    expect(executor.calls).toHaveLength(2)
    expect(await queued).toMatchObject({ code: 'QUEUE_DEADLINE' })
  })
  it('does not permit two admission managers to share one held singleton lease', async () => {
    const docker = await api.client()
    expect(
      () =>
        new CompilerAdmission(executor, new OwnedJobReconciler(docker, lease))
    ).toThrow(/lease|manager|claim/i)
  })
  it('requires a successful startup retry before admitting after an initial sweep failure', async () => {
    await manager.close()
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(await api.client(), lease),
      { sweepIntervalMs: 60_000 }
    )
    api.failures.add('list')
    await assert.rejects(manager.start(), /failure/i)
    api.failures.clear()
    await manager.reconcile()
    expect(manager.status().ready).toBe(false)
    await manager.start()
    submit('after-retry')
    expect(executor.calls).toHaveLength(1)
  })
  it('keeps admission blocked when a failed job resource has drifted outside the manager label filter', async () => {
    submit('a')
    submit('b')
    submit('c')
    const identity = executor.calls[0]?.identity
    if (!identity) throw new Error('missing identity')
    const resource = api.addContainer(identity, 'foreign-after-cleanup-error')
    executor.pending[0]?.fail(new Error('ownership cleanup failure'))
    for (
      let n = 0;
      n < 30 && manager.status().reconciliationError === undefined;
      n++
    )
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    expect(manager.status().reconciliationError).toBeInstanceOf(Error)
    expect(manager.status().ready).toBe(false)
    expect(executor.calls).toHaveLength(2)
    resource.manager = 'ephemeral-docker-job-v1'
    await manager.reconcile()
    expect(api.containers.size).toBe(0)
    expect(manager.status().ready).toBe(true)
  })
  it('preserves the singleton on shutdown cleanup failure and permits a deliberate cleanup retry', async () => {
    api.addContainer(randomUUID())
    api.failures.add('remove')
    await assert.rejects(manager.close(), /reconcil/i)
    await assert.rejects(
      CompilerLease.acquire(path.join(root, 'manager.sock')),
      /already exists|EADDRINUSE/
    )
    expect(await submit('closed')).toMatchObject({ code: 'CLOSED' })
    api.failures.clear()
    await manager.close()
    expect(api.containers.size).toBe(0)
  })
  it('does not finish startup or install periodic work after shutdown began during the initial sweep', async () => {
    await manager.close()
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      executor,
      new OwnedJobReconciler(await api.client(), lease),
      { sweepIntervalMs: 5 }
    )
    const held = gate()
    api.listHold = held.promise
    const starting = manager.start().catch((error: unknown) => error)
    const closing = manager.close()
    held.release()
    await closing
    expect(await starting).toMatchObject({ code: 'CLOSED' })
    const calls = api.listCalls
    await new Promise<void>(resolve => setTimeout(resolve, 15))
    expect(api.listCalls).toBe(calls)
    await assert.rejects(manager.reconcile(), { code: 'CLOSED' })
  })
})
