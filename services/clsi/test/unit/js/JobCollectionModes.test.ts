import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import { DockerApiFixture, gate, waitForEvent } from './DockerApiFixture.ts'

const IMAGE = `sha256:${'a'.repeat(64)}`
const ID = '11111111-2222-4333-8444-555555555555'
let fixture: DockerApiFixture, root: string, runner: EphemeralDockerJob
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'job-collection-'))
  await fs.mkdir(path.join(root, 'in'), { mode: 0o700 })
  await fs.writeFile(path.join(root, 'in/main.tex'), 'hello')
  fixture = new DockerApiFixture()
  runner = new EphemeralDockerJob(await fixture.open(), {
    trustedStagingRoot: root,
    allowedImages: [IMAGE],
    allowedExecutables: ['/usr/bin/pdflatex'],
  })
})
afterEach(async () => {
  await fixture.close()
  await fs.rm(root, { recursive: true, force: true })
})
function request() {
  return {
    image: IMAGE,
    argv: ['/usr/bin/pdflatex'],
    cwd: '/compile',
    inputDirectory: path.join(root, 'in'),
    timeoutMs: 2000,
  }
}
function available() {
  assert.equal(typeof runner.runArtifacts, 'function')
  assert.equal(typeof runner.runStdout, 'function')
}

test('stdout-only preserves exact output and manager UUID without pause, archive or fake host output', async () => {
  available()
  fixture.exitCode = 2
  const result = await runner.runStdout(request(), ID)
  assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'stderr', 'stdout'])
  assert.equal(result.exitCode, 2)
  assert.equal(result.stdout.toString(), 'ok')
  assert.deepEqual(fixture.events, [
    'volume',
    'create',
    'start',
    'upload',
    'exec',
    'remove-container',
    'remove-volume',
  ])
  assert.equal(fixture.volumeConfig?.Name, `lope-clsi-job-${ID}`)
  assert.equal(
    fixture.containerConfig?.Labels?.['org.lope.overleaf.compiler-job'],
    ID
  )
  assert.deepEqual(await fs.readdir(root), ['in'])
  assert.equal(fixture.ownedContainer || fixture.ownedVolume, false)
})
test('artifact mode collects generated PDF and exact captured diagnostics via the upload manifest', async () => {
  available()
  const result = await runner.runArtifacts(
    { ...request(), outputDirectory: path.join(root, 'out') },
    ID
  )
  assert.equal(
    await fs.readFile(path.join(root, 'out/result.pdf'), 'utf8'),
    'synthetic-pdf'
  )
  assert.equal(
    await fs.readFile(path.join(root, 'out/output.stdout'), 'utf8'),
    'ok'
  )
  assert.equal(result.output.generated.bytes, 15)
  assert.equal(result.output.retained.bytes, 15)
  assert.equal(fixture.volumeConfig?.Name, `lope-clsi-job-${ID}`)
  assert.deepEqual(fixture.events.slice(-5), [
    'pause',
    'collect',
    'unpause',
    'remove-container',
    'remove-volume',
  ])
  assert.equal(fixture.ownedContainer || fixture.ownedVolume, false)
})
test('a JavaScript stdout caller supplying outputDirectory is rejected before API actions', async () => {
  available()
  await assert.rejects(async () => {
    await Reflect.apply(runner.runStdout, runner, [
      { ...request(), outputDirectory: path.join(root, 'fake') },
    ])
  }, /outputDirectory/)
  assert.deepEqual(fixture.events, [])
  assert.deepEqual(await fs.readdir(root), ['in'])
})
for (const mode of ['stdout', 'artifacts'] as const) {
  test(`${mode} rejects invalid manager identity before create`, async () => {
    available()
    await assert.rejects(
      mode === 'stdout'
        ? runner.runStdout(request(), 'bad')
        : runner.runArtifacts(
            { ...request(), outputDirectory: path.join(root, 'out') },
            'bad'
          ),
      /identity/
    )
    assert.deepEqual(fixture.events, [])
  })
  test(`${mode} cancellation joins late create and exact cleanup before return`, async () => {
    available()
    const held = gate()
    fixture.holds.set('create', held.promise)
    const abort = new AbortController()
    let settled = false
    const pending = (
      mode === 'stdout'
        ? runner.runStdout({ ...request(), signal: abort.signal }, ID)
        : runner.runArtifacts(
            {
              ...request(),
              signal: abort.signal,
              outputDirectory: path.join(root, 'out'),
            },
            ID
          )
    ).then(
      () => {
        settled = true
        throw new Error('unexpected success')
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    await waitForEvent(fixture, 'create')
    abort.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    held.release()
    assert.ok((await pending) instanceof Error)
    assert.equal(fixture.ownedContainer || fixture.ownedVolume, false)
    assert.deepEqual(fixture.events.slice(-2), [
      'remove-container',
      'remove-volume',
    ])
  })
}
test('stdout cleanup errors remain visible and volume cleanup still runs', async () => {
  available()
  fixture.failures.add('remove-container')
  fixture.failures.add('remove-volume')
  await assert.rejects(runner.runStdout(request(), ID), AggregateError)
  assert.deepEqual(fixture.events.slice(-2), [
    'remove-container',
    'remove-volume',
  ])
})
test('stdout retains the existing aggregate exec output cap and cleans resources', async () => {
  available()
  fixture.output = Buffer.alloc(1024 * 1024 + 1)
  await assert.rejects(runner.runStdout(request(), ID), /output/)
  assert.equal(fixture.ownedContainer || fixture.ownedVolume, false)
})
