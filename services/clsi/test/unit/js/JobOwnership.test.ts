import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'

describe('guarded compiler ownership reconciliation', () => {
  let root: string
  let lease: CompilerLease
  let api: OwnershipApiFixture
  let reconciler: OwnedJobReconciler
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-ownership-'))
    lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    api = new OwnershipApiFixture()
    reconciler = new OwnedJobReconciler(await api.open(), lease)
  })
  afterEach(async () => {
    await lease.close()
    await api.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  it('sweeps exact owned restart resources, containers before volumes, and preserves active and foreign identities', async () => {
    const stale = randomUUID()
    const active = randomUUID()
    const foreign = randomUUID()
    api.addContainer(stale)
    api.addVolume(stale)
    api.addContainer(active)
    api.addVolume(active)
    api.addContainer(foreign, 'foreign-manager')
    api.addVolume(foreign, 'foreign-manager')
    await reconciler.sweep(new Set([active]))
    expect(api.containers.size).toBe(2)
    expect(api.volumes.size).toBe(2)
    expect(api.events.filter(event => event.startsWith('remove:'))).toEqual([
      `remove:containers:container-${stale}`,
      `remove:volumes:lope-clsi-job-${stale}`,
    ])
    expect(
      api.events
        .filter(event => event.startsWith('filter:'))
        .every(event => event.includes('ephemeral-docker-job-v1'))
    ).toBe(true)
  })
  it('does no API work without an actually held exclusive lease', async () => {
    await lease.close()
    await assert.rejects(reconciler.sweep(new Set()), /lease/i)
    expect(api.listCalls).toBe(0)
  })
  it('rejects a second OS listener and preserves pre-existing stale endpoints', async () => {
    await assert.rejects(
      CompilerLease.acquire(path.join(root, 'manager.sock')),
      /already exists|EADDRINUSE|exclusive|lease/i
    )
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import net from 'node:net'; const server=net.createServer(); server.on('error', error => process.exit(error.code==='EADDRINUSE'?0:2)); server.listen(${JSON.stringify(path.join(root, 'manager.sock'))}, () => server.close(() => process.exit(3)));`,
      ],
      { timeout: 2000, encoding: 'utf8' }
    )
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    const stale = path.join(root, 'stale.sock')
    await fs.writeFile(stale, 'operator must inspect')
    await assert.rejects(
      CompilerLease.acquire(stale),
      /already exists|EADDRINUSE|exclusive|lease/i
    )
    expect(await fs.readFile(stale, 'utf8')).toBe('operator must inspect')
    // No protocol is exposed even to a local client.
    const client = net.connect(path.join(root, 'manager.sock'))
    await new Promise<void>((resolve, reject) => {
      client.once('close', resolve)
      client.once('error', reject)
    })
  })
  it('requires an owner-controlled private real socket parent', async () => {
    const unsafe = path.join(root, 'unsafe')
    await fs.mkdir(unsafe, { mode: 0o755 })
    await assert.rejects(
      CompilerLease.acquire(path.join(unsafe, 'manager.sock')),
      /private|trusted/i
    )
    const alias = path.join(root, 'alias')
    await fs.symlink(root, alias)
    await assert.rejects(
      CompilerLease.acquire(path.join(alias, 'other.sock')),
      /private|trusted|real/i
    )
  })
  for (const kind of ['container', 'volume']) {
    it(`preserves ${kind} ownership drift and blocks reconciliation`, async () => {
      const resource =
        kind === 'container'
          ? api.addContainer(randomUUID())
          : api.addVolume(randomUUID())
      resource.drift = true
      await assert.rejects(reconciler.sweep(new Set()), /ownership|reconcil/i)
      expect(api.containers.size + api.volumes.size).toBe(1)
      expect(api.events.some(event => event.startsWith('remove:'))).toBe(false)
    })
  }
  for (const failure of ['list', 'inspect', 'remove']) {
    it(`surfaces ${failure} errors and leaves failed resources available for a later retry`, async () => {
      api.addContainer(randomUUID())
      api.failures.add(failure)
      await assert.rejects(reconciler.sweep(new Set()), /reconcil|failure/i)
      expect(api.containers.size).toBe(1)
      api.failures.clear()
      await reconciler.sweep(new Set())
      expect(api.containers.size).toBe(0)
    })
  }
  it('rejects malformed claimed UUIDs and names without deleting them', async () => {
    api.addContainer('not-a-uuid')
    await assert.rejects(reconciler.sweep(new Set()), /identity|reconcil/i)
    api.containers.clear()
    api.addContainer(randomUUID(), 'ephemeral-docker-job-v1', 'foreign-name')
    await assert.rejects(reconciler.sweep(new Set()), /name|reconcil/i)
    expect(api.events.some(event => event.startsWith('remove:'))).toBe(false)
  })
  for (const mode of [0o777, 0o770]) {
    it(`rejects a private leaf below nonsticky writable ancestor ${mode.toString(8)} before binding`, async () => {
      await lease.close()
      await fs.chmod(root, 0o755)
      const ancestor = path.join(root, 'unsafe')
      await fs.mkdir(ancestor)
      await fs.chmod(ancestor, mode)
      const worker = path.join(ancestor, 'worker')
      await fs.mkdir(worker, { mode: 0o700 })
      let unexpected: CompilerLease | undefined
      try {
        await assert.rejects(async () => {
          unexpected = await CompilerLease.acquire(
            path.join(worker, 'manager.sock')
          )
        }, /unsafe ancestor/i)
      } finally {
        await unexpected?.close()
      }
      expect(await fs.readdir(worker)).toEqual([])
    })
  }
  it('enforces the same100-byte UTF-8 bound as the private listener rather than counting characters', async () => {
    const prefixBytes = Buffer.byteLength(root + path.sep)
    const endpoint = path.join(root, 'x'.repeat(100 - prefixBytes - 2) + 'éé')
    expect(endpoint.length).toBe(100)
    expect(Buffer.byteLength(endpoint)).toBe(102)
    let unexpected: CompilerLease | undefined
    try {
      await assert.rejects(async () => {
        unexpected = await CompilerLease.acquire(endpoint)
      }, /100 bytes/i)
    } finally {
      await unexpected?.close()
    }
  })
})
