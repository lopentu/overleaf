import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { withCompileInputSnapshot } from '../../../app/js/CompileInputSnapshot.ts'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import { DockerApiFixture } from './DockerApiFixture.ts'

// Run in a separate native process: the builtin hook cannot leak between Vitest
// files under isolate:false. Only delay the result of an actual FileHandle read.
const mode = process.argv[2]
assert.ok(mode === 'snapshot' || mode === 'adapter')
const closeFails = process.argv[3] === 'close-error'
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'input-producer-life-'))
const sourceRoot = path.join(base, 'sources')
const sourceDirectory = path.join(sourceRoot, 'project')
const stagingRoot = path.join(base, 'staging')
for (const directory of [sourceRoot, sourceDirectory, stagingRoot])
  await fs.mkdir(directory, { mode: 0o700 })
const sourceFile = path.join(sourceDirectory, 'main.tex')
await fs.writeFile(sourceFile, Buffer.alloc(128 * 1024), { mode: 0o600 })
const originalOpen = fs.open
const entered = Promise.withResolvers<void>()
const held = Promise.withResolvers<void>()
let readPending = false
let closes = 0
let used = false
const closeError = new Error('sentinel source close failed after real close')
Object.defineProperty(fs, 'open', {
  configurable: true,
  value: async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args)
    if (args[0] === sourceFile) {
      const read = file.read.bind(file)
      const close = file.close.bind(file)
      Object.defineProperty(file, 'read', {
        value: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => {
          const result = await read(buffer, offset, length, position)
          readPending = true
          entered.resolve()
          await held.promise
          readPending = false
          return result
        },
      })
      file.close = async () => {
        closes++
        await close()
        if (closeFails) throw closeError
      }
    }
    return file
  },
})
syncBuiltinESMExports()
const abort = new AbortController()
const fixture = mode === 'adapter' ? new DockerApiFixture() : undefined
let task: Promise<unknown> | undefined
let settled = false
try {
  const image = `sha256:${'a'.repeat(64)}`
  const run =
    fixture === undefined
      ? withCompileInputSnapshot(
          { sourceRoot, sourceDirectory, stagingRoot, signal: abort.signal },
          async () => {
            used = true
          }
        )
      : new EphemeralDockerJob(await fixture.open(), {
          trustedStagingRoot: sourceRoot,
          allowedImages: [image],
          allowedExecutables: ['/usr/bin/pdflatex'],
        }).run({
          image,
          argv: ['/usr/bin/pdflatex'],
          cwd: '/compile',
          inputDirectory: sourceDirectory,
          outputDirectory: path.join(sourceRoot, 'output'),
          timeoutMs: 5000,
          signal: abort.signal,
        })
  task = run.then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    }
  )
  await entered.promise
  abort.abort()
  await delay(50)
  const before = {
    settled,
    readPending,
    closes,
    jobDirectories: await fs.readdir(stagingRoot),
    resourcesOwned: fixture?.ownedContainer === true && fixture.ownedVolume,
    resourcesRemoved: fixture?.events.some(event =>
      event.startsWith('remove-')
    ),
  }
  held.resolve()
  const outcome = await task
  // Assertions follow release so even a baseline failure leaves no held I/O.
  assert.equal(before.settled, false, 'caller settled before producer read')
  assert.equal(before.readPending, true)
  assert.equal(before.closes, 0)
  if (mode === 'snapshot') assert.equal(before.jobDirectories.length, 1)
  else {
    assert.equal(before.resourcesOwned, true)
    assert.equal(before.resourcesRemoved, false)
  }
  assert.ok(outcome instanceof Error)
  assert.equal(closes, 1)
  assert.equal(readPending, false)
  assert.equal(used, false)
  assert.deepEqual(await fs.readdir(stagingRoot), [])
  assert.equal(
    fixture?.ownedContainer === true || fixture?.ownedVolume === true,
    false
  )
  assert.equal(fixture?.events.includes('exec') ?? false, false)
  const containsAbort = (error: unknown): boolean =>
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof AggregateError && error.errors.some(containsAbort))
  assert.ok(containsAbort(outcome), 'primary cancellation error was lost')
  if (closeFails) {
    const contains = (error: unknown): boolean =>
      error === closeError ||
      (error instanceof AggregateError && error.errors.some(contains))
    assert.ok(contains(outcome), 'late producer close error was lost')
  }
  console.log(
    `${mode}${closeFails ? ' close-error' : ''} producer lifetime PASS`
  )
} finally {
  held.resolve()
  await task
  Object.defineProperty(fs, 'open', { configurable: true, value: originalOpen })
  syncBuiltinESMExports()
  await fixture?.close()
  await fs.rm(base, { recursive: true, force: true })
}
