import nodeAssert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  EphemeralDockerJob,
  type JobRequest,
} from '../../../app/js/EphemeralDockerJob.ts'
import {
  DockerApiFixture,
  gate,
  waitForEvent,
  type Phase,
} from './DockerApiFixture.ts'

const IMAGE = `sha256:${'a'.repeat(64)}`
describe('EphemeralDockerJob', () => {
  let fixture: DockerApiFixture
  let root: string
  let runner: EphemeralDockerJob
  let request: JobRequest
  beforeEach(async () => {
    fixture = new DockerApiFixture()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ephemeral-job-test-'))
    await fs.mkdir(path.join(root, 'input'), { mode: 0o700 })
    await fs.writeFile(path.join(root, 'input', 'main.tex'), 'hello')
    runner = new EphemeralDockerJob(await fixture.open(), {
      trustedStagingRoot: root,
      allowedImages: [IMAGE],
      allowedExecutables: ['/usr/bin/pdflatex'],
    })
    request = {
      image: IMAGE,
      argv: ['/usr/bin/pdflatex', 'literal;$(no-shell)'],
      cwd: '/compile',
      inputDirectory: path.join(root, 'input'),
      outputDirectory: path.join(root, 'output'),
      timeoutMs: 2000,
    }
  })
  afterEach(async () => {
    await fixture.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  it('transfers real archives, runs argv literally, pauses before collecting and removes both owned resources', async () => {
    const result = await runner.run(request)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('ok')
    expect(
      await fs.readFile(
        path.join(request.outputDirectory, 'result.pdf'),
        'utf8'
      )
    ).toBe('synthetic-pdf')
    expect(fixture.events).toEqual([
      'volume',
      'create',
      'start',
      'upload',
      'exec',
      'pause',
      'collect',
      'unpause',
      'remove-container',
      'remove-volume',
    ])
    expect(fixture.execConfig?.Cmd).toEqual([
      '/usr/bin/pdflatex',
      'literal;$(no-shell)',
    ])
    expect(fixture.containerConfig).toMatchObject({
      User: '33:33',
      NetworkDisabled: true,
      HostConfig: {
        ReadonlyRootfs: true,
        LogConfig: { Type: 'none', Config: {} },
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 1073741824,
        MemorySwap: 1073741824,
        PidsLimit: 256,
        NanoCpus: 1000000000,
        Mounts: [
          {
            Target: '/compile',
            Type: 'volume',
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
    })
    expect(fixture.volumeConfig).toMatchObject({
      Driver: 'local',
      DriverOpts: {
        type: 'tmpfs',
        device: 'tmpfs',
        o: 'size=256m,uid=33,gid=33,mode=0700,nodev,nosuid,noexec',
      },
    })
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
    expect(fixture.uploaded.includes(Buffer.from('hello'))).toBe(true)
  })
  it('propagates input archive failures and cancels the upload instead of hanging on an unfinished request', async () => {
    await fs.symlink(
      '/etc/passwd',
      path.join(request.inputDirectory, 'forbidden')
    )
    const pending = runner
      .run({ ...request, timeoutMs: 200 })
      .catch((error: unknown) => error)
    const observed: unknown = await Promise.race([
      pending,
      new Promise<string>(resolve => {
        setTimeout(() => {
          resolve('hung upload')
        }, 500)
      }),
    ])
    expect(observed).toBeInstanceOf(Error)
    expect(
      observed instanceof Error &&
        /Unsafe project archive/.test(observed.message)
    ).toBe(true)
    expect(fixture.events).not.toContain('exec')
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  it('preserves a nonzero compile result and still cleans both resources', async () => {
    fixture.exitCode = 2
    expect((await runner.run(request)).exitCode).toBe(2)
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  for (const phase of [
    'volume',
    'create',
    'start',
    'upload',
    'exec',
    'collect',
  ] satisfies Phase[]) {
    for (const reason of ['cancel', 'deadline']) {
      it(`${reason} during ${phase} waits for a late API response then removes owned resources`, async () => {
        const held = gate()
        fixture.holds.set(phase, held.promise)
        const abort = new AbortController()
        const pending = runner.run({
          ...request,
          timeoutMs: reason === 'deadline' ? 75 : 2000,
          signal: abort.signal,
        })
        const settled = pending.then(
          () => 'success',
          (error: unknown) => error
        )
        await waitForEvent(fixture, phase)
        if (reason === 'cancel') abort.abort(new Error('caller cancelled'))
        else
          await new Promise<void>(resolve => {
            setTimeout(resolve, 100)
          })
        held.release()
        expect(await settled).toBeInstanceOf(Error)
        expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
      })
    }
  }
  for (const phase of ['exec', 'collect']) {
    for (const reason of ['cancel', 'deadline']) {
      it(`${reason} interrupts an open ${phase} response stream and cleans resources`, async () => {
        fixture.holdExec = phase === 'exec'
        fixture.holdCollect = phase === 'collect'
        const abort = new AbortController()
        const pending = runner
          .run({
            ...request,
            timeoutMs: reason === 'deadline' ? 100 : 2000,
            signal: abort.signal,
          })
          .catch((error: unknown) => error)
        await waitForEvent(
          fixture,
          phase === 'exec' ? 'exec' : 'collect-stream'
        )
        if (reason === 'cancel') abort.abort()
        expect(await pending).toBeInstanceOf(Error)
        expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
      })
    }
  }
  it('rejects excess exec output instead of buffering it and cleans both resources', async () => {
    fixture.output = Buffer.alloc(1024 * 1024 + 1)
    await nodeAssert.rejects(runner.run(request), /output/i)
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  it('removes the owned volume even when the completed container deletion returns an API error', async () => {
    fixture.failures.add('remove-container-response')
    await nodeAssert.rejects(runner.run(request), AggregateError)
    expect(fixture.events.slice(-2)).toEqual([
      'remove-container',
      'remove-volume',
    ])
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  it('preserves an unowned container and reports the still-attached owned volume instead of claiming cleanup', async () => {
    fixture.containerLabelsMismatch = true
    const error: unknown = await runner
      .run(request)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(fixture.events).not.toContain('remove-container')
    expect(fixture.events).toContain('remove-volume')
    expect(fixture.ownedContainer && fixture.ownedVolume).toBe(true)
  })
  it('still attempts owned volume removal and surfaces both cleanup failures', async () => {
    fixture.failures.add('remove-container')
    fixture.failures.add('remove-volume')
    const error: unknown = await runner
      .run(request)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(fixture.events.slice(-2)).toEqual([
      'remove-container',
      'remove-volume',
    ])
  })
  it('never removes a volume whose ownership label does not match', async () => {
    fixture.labelsMismatch = true
    const error: unknown = await runner
      .run(request)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError))
      throw new Error('expected ownership failure')
    const causes: readonly unknown[] = error.errors
    expect(
      causes.some(
        cause => cause instanceof Error && /ownership/.test(cause.message)
      )
    ).toBe(true)
    expect(fixture.events).not.toContain('remove-volume')
    expect(fixture.events).not.toContain('create')
  })
  it('cleans both resources when upload fails and never runs the command', async () => {
    fixture.failures.add('upload')
    await nodeAssert.rejects(runner.run(request), /upload failure/)
    expect(fixture.events).not.toContain('exec')
    expect(fixture.ownedContainer || fixture.ownedVolume).toBe(false)
  })
  for (const mutation of [
    { image: 'image:latest' },
    { image: `sha256:${'b'.repeat(64)}` },
    { cwd: '/compile/../etc' },
    { argv: ['/bin/sh', '-c', 'evil'] },
    { environment: { LD_PRELOAD: '/compile/a.so' } },
    { timeoutMs: 0 },
  ]) {
    it(`rejects invalid request ${JSON.stringify(mutation)} before creating Docker resources`, async () => {
      await nodeAssert.rejects(runner.run({ ...request, ...mutation }))
      expect(fixture.events).toEqual([])
    })
  }
  it('rejects staging symlinks and preserves an existing output directory', async () => {
    await fs.mkdir(request.outputDirectory)
    await fs.writeFile(path.join(request.outputDirectory, 'keep'), 'unchanged')
    await nodeAssert.rejects(runner.run(request))
    expect(
      await fs.readFile(path.join(request.outputDirectory, 'keep'), 'utf8')
    ).toBe('unchanged')
    await fs.symlink(request.inputDirectory, path.join(root, 'alias'))
    await nodeAssert.rejects(
      runner.run({
        ...request,
        inputDirectory: path.join(root, 'alias'),
        outputDirectory: path.join(root, 'new-output'),
      })
    )
    expect(fixture.events).toEqual([])
  })
})
