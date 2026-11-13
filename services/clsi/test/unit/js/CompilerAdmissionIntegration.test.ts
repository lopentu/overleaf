import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import type { JobRequest } from '../../../app/js/JobRequest.ts'
import { DockerApiFixture, gate, waitForEvent } from './DockerApiFixture.ts'

describe('admission with real job adapter and Dockerode over synthetic HTTP', () => {
  let root: string
  let fixture: DockerApiFixture
  let manager: CompilerAdmission
  let request: JobRequest
  let releaseCleanup: (() => void) | undefined
  const results: Promise<unknown>[] = []
  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'compiler-manager-integration-')
    )
    await fs.mkdir(path.join(root, 'input'), { mode: 0o700 })
    await fs.writeFile(path.join(root, 'input/main.tex'), 'synthetic input')
    fixture = new DockerApiFixture()
    const docker = await fixture.open()
    const lease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    const image = `sha256:${'a'.repeat(64)}`
    manager = new CompilerAdmission(
      new EphemeralDockerJob(docker, {
        trustedStagingRoot: root,
        allowedImages: [image],
        allowedExecutables: ['/usr/bin/pdflatex'],
      }),
      new OwnedJobReconciler(docker, lease),
      { activeLimit: 1, sweepIntervalMs: 5 }
    )
    await manager.start()
    request = {
      image,
      argv: ['/usr/bin/pdflatex'],
      cwd: '/compile',
      inputDirectory: path.join(root, 'input'),
      outputDirectory: path.join(root, 'output'),
      timeoutMs: 1000,
    }
  })
  afterEach(async () => {
    releaseCleanup?.()
    releaseCleanup = undefined
    await manager.close()
    await Promise.all(results.splice(0))
    await fixture.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  it('holds capacity and the singleton through actual asynchronous Docker cleanup settlement', async () => {
    const held = gate()
    releaseCleanup = held.release
    fixture.holds.set('remove-container', held.promise)
    const active = manager
      .submit('project-a', request)
      .catch((error: unknown) => error)
    results.push(active)
    const queued = manager
      .submit('project-b', {
        ...request,
        outputDirectory: path.join(root, 'output-b'),
      })
      .catch((error: unknown) => error)
    results.push(queued)
    await waitForEvent(fixture, 'remove-container')
    expect(manager.status()).toMatchObject({ active: 1, queued: 1 })
    await manager.reconcile()
    expect(
      fixture.events.filter(event => event === 'remove-container')
    ).toHaveLength(1)
    let closed = false
    const closing = manager.close().then(() => {
      closed = true
    })
    expect(await queued).toMatchObject({ code: 'CLOSED' })
    await assert.rejects(
      CompilerLease.acquire(path.join(root, 'manager.sock')),
      /already exists|EADDRINUSE/
    )
    expect(closed).toBe(false)
    held.release()
    await closing
    expect(await active).toMatchObject({ exitCode: 0 })
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  it('reconciles a volume created after a disconnected real Dockerode create response and initial cleanup', async () => {
    fixture.lateVolumeDelayMs = 30
    const outcome = manager
      .submit('ambiguous', request)
      .catch((error: unknown) => error)
    results.push(outcome)
    expect(await outcome).toBeInstanceOf(Error)
    await waitForEvent(fixture, 'late-volume')
    for (let n = 0; n < 100 && fixture.ownedVolume; n++)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(fixture.ownedVolume).toBe(false)
    expect(fixture.events).toContain('remove-volume')
    await manager.reconcile()
    expect(manager.status()).toMatchObject({ active: 0, ready: true })
  })
})
