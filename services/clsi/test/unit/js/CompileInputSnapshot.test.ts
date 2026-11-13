import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import type { PathLike } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type { CompileInputSnapshotRequest } from '../../../app/js/CompileInputSnapshot.ts'

type SnapshotHelper =
  typeof import('../../../app/js/CompileInputSnapshot.ts').withCompileInputSnapshot
const exec = promisify(execFile)
const MiB = 1024 * 1024
function onlyAbortErrors(error: unknown): boolean {
  if (error instanceof AggregateError) {
    const causes: readonly unknown[] = error.errors
    return causes.length > 0 && causes.every(onlyAbortErrors)
  }
  return error instanceof Error && error.name === 'AbortError'
}
let base: string
let request: CompileInputSnapshotRequest
let sourceFile: string
let snapshot: SnapshotHelper
async function removeFixture(directory: string): Promise<void> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await fs.chmod(directory, 0o700)
  for await (const entry of await fs.opendir(directory)) {
    const child = path.join(directory, entry.name)
    const childStat = await fs.lstat(child)
    if (childStat.isDirectory() && !childStat.isSymbolicLink())
      await removeFixture(child)
  }
}
async function sparse(name: string, size: number): Promise<void> {
  const file = await fs.open(
    path.join(request.sourceDirectory, name),
    'w',
    0o600
  )
  try {
    await file.truncate(size)
  } finally {
    await file.close()
  }
}
async function load(): Promise<SnapshotHelper> {
  vi.resetModules()
  return (await import('../../../app/js/CompileInputSnapshot.ts'))
    .withCompileInputSnapshot
}
beforeEach(async () => {
  vi.doUnmock('node:fs/promises')
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'compile-snapshot-test-'))
  const sourceRoot = path.join(base, 'sources')
  const sourceDirectory = path.join(sourceRoot, 'project')
  const stagingRoot = path.join(base, 'staging')
  for (const dir of [sourceRoot, sourceDirectory, stagingRoot])
    await fs.mkdir(dir, { mode: 0o700 })
  request = { sourceRoot, sourceDirectory, stagingRoot }
  sourceFile = path.join(sourceDirectory, 'main.tex')
  await fs.writeFile(sourceFile, Buffer.from([0, 255, 65, 13, 10]), {
    mode: 0o600,
  })
  snapshot = await load()
})
afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  await removeFixture(base)
  await fs.rm(base, { recursive: true, force: true })
})

describe('private active compile input snapshot', () => {
  it('copies binary content into a sealed private job and cleans only it after consumer success', async () => {
    const foreign = path.join(request.stagingRoot, 'foreign')
    await fs.mkdir(foreign, { mode: 0o700 })
    await fs.writeFile(path.join(foreign, 'keep'), 'foreign')
    await fs.mkdir(path.join(request.sourceDirectory, 'include'), {
      mode: 0o750,
    })
    await fs.writeFile(
      path.join(request.sourceDirectory, 'include', 'defs.tex'),
      'abc',
      { mode: 0o600 }
    )
    let job = ''
    const result = await snapshot(request, async staged => {
      job = path.dirname(staged.inputDirectory)
      assert.equal((await fs.stat(job)).mode & 0o777, 0o700)
      assert.equal((await fs.stat(staged.inputDirectory)).mode & 0o777, 0o500)
      assert.equal(
        (await fs.stat(path.join(staged.inputDirectory, 'main.tex'))).mode &
          0o777,
        0o400
      )
      assert.deepEqual(
        await fs.readFile(path.join(staged.inputDirectory, 'main.tex')),
        Buffer.from([0, 255, 65, 13, 10])
      )
      assert.equal(
        (await fs.stat(path.join(staged.inputDirectory, 'include'))).mode &
          0o777,
        0o500
      )
      assert.equal(
        (await fs.stat(path.join(staged.inputDirectory, 'include', 'defs.tex')))
          .mode & 0o777,
        0o400
      )
      assert.equal(staged.input.files, 2)
      assert.equal(staged.input.bytes, 8)
      await assert.rejects(fs.lstat(staged.outputDirectory), { code: 'ENOENT' })
      await fs.mkdir(staged.outputDirectory, { mode: 0o700 })
      await fs.writeFile(
        path.join(staged.outputDirectory, 'output.pdf'),
        'synthetic'
      )
      return 17
    })
    assert.equal(result, 17)
    await assert.rejects(fs.lstat(job), { code: 'ENOENT' })
    assert.equal(
      await fs.readFile(path.join(foreign, 'keep'), 'utf8'),
      'foreign'
    )
    assert.deepEqual(
      await fs.readFile(sourceFile),
      Buffer.from([0, 255, 65, 13, 10])
    )
    assert.equal((await fs.stat(sourceFile)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(request.stagingRoot)).mode & 0o777, 0o700)
  })
  it('preserves callback errors and cleans the job while leaving source and root untouched', async () => {
    const failure = new Error('synthetic work failed')
    await assert.rejects(
      snapshot(request, async () => {
        throw failure
      }),
      error => error === failure
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
    assert.equal((await fs.stat(sourceFile)).size, 5)
  })
  it('creates nothing for an already cancelled job', async () => {
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(
      snapshot({ ...request, signal: abort.signal }, async () => 0),
      { name: 'AbortError' }
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  it('aborts during real source file reading and removes partial staging', async () => {
    await fs.writeFile(sourceFile, Buffer.alloc(2 * MiB), { mode: 0o600 })
    const abort = new AbortController()
    let bytes = 0
    let used = false
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    vi.doMock('node:fs/promises', () => ({
      ...actual,
      async open(target: PathLike, flags: string | number, mode?: number) {
        const file = await actual.open(target, flags, mode)
        if (target === sourceFile) {
          const read = file.read.bind(file)
          Object.defineProperty(file, 'read', {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => {
              const result = await read(buffer, offset, length, position)
              bytes += result.bytesRead
              if (result.bytesRead > 0) abort.abort()
              return result
            },
          })
        }
        return file
      },
    }))
    snapshot = await load()
    await assert.rejects(
      snapshot({ ...request, signal: abort.signal }, async () => {
        used = true
      }),
      onlyAbortErrors
    )
    assert.ok(bytes > 0)
    assert.equal(used, false)
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
    assert.equal((await fs.stat(sourceFile)).size, 2 * MiB)
  })
  it('waits for an active consumer to settle before cancellation cleanup', async () => {
    const abort = new AbortController()
    let job = ''
    let completed = false
    await assert.rejects(
      snapshot({ ...request, signal: abort.signal }, async staged => {
        job = path.dirname(staged.inputDirectory)
        abort.abort()
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        await fs.stat(staged.inputDirectory)
        completed = true
        return 1
      }),
      { name: 'AbortError' }
    )
    assert.equal(completed, true)
    await assert.rejects(fs.lstat(job), { code: 'ENOENT' })
  })
  it('accepts two 40 MiB inputs under the input policy rather than output 16/64 MiB limits', async () => {
    for (const name of ['large-a.tex', 'large-b.tex'])
      await sparse(name, 40 * MiB)
    await snapshot(request, async staged => {
      for (const name of ['large-a.tex', 'large-b.tex'])
        assert.equal(
          (await fs.stat(path.join(staged.inputDirectory, name))).size,
          40 * MiB
        )
      assert.equal(staged.input.bytes, 80 * MiB + 5)
      return 0
    })
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  it('rejects files above 50 MiB before executing the consumer', async () => {
    await sparse('too-large', 50 * MiB + 1)
    let used = false
    await assert.rejects(
      snapshot(request, async () => {
        used = true
      }),
      /limit|length/i
    )
    assert.equal(used, false)
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  it('rejects total input above 100 MiB and removes already extracted partial files', async () => {
    for (const n of ['a', 'b', 'c']) await sparse(n, 40 * MiB)
    await assert.rejects(
      snapshot(request, async () => 0),
      /limit/i
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  it('bounds metadata traversal at 4096 input entries', async () => {
    for (let first = 0; first < 4096; first += 64)
      await Promise.all(
        Array.from({ length: Math.min(64, 4096 - first) }, (_, i) =>
          fs.writeFile(
            path.join(request.sourceDirectory, `item-${first + i}`),
            '',
            { mode: 0o600 }
          )
        )
      )
    await assert.rejects(
      snapshot(request, async () => 0),
      /entry.*limit/i
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  for (const kind of ['symlink', 'hardlink', 'fifo', 'control-name'] as const) {
    it(`rejects unsafe ${kind} input without changing the source`, async () => {
      const unsafe = path.join(
        request.sourceDirectory,
        kind === 'control-name' ? 'bad\nname' : 'unsafe'
      )
      if (kind === 'symlink') await fs.symlink(sourceFile, unsafe)
      else if (kind === 'hardlink') await fs.link(sourceFile, unsafe)
      else if (kind === 'fifo') await exec('mkfifo', ['-m', '600', unsafe])
      else await fs.writeFile(unsafe, 'bad', { mode: 0o600 })
      await assert.rejects(snapshot(request, async () => 0))
      await fs.lstat(unsafe)
      assert.deepEqual(await fs.readdir(request.stagingRoot), [])
    })
  }
  it('rejects a group-writable source file rather than silently fixing it', async () => {
    await fs.chmod(sourceFile, 0o660)
    await assert.rejects(
      snapshot(request, async () => 0),
      /protect|writ/i
    )
    assert.equal((await fs.stat(sourceFile)).mode & 0o777, 0o660)
  })
  it('rejects a different source-file owner using complete real stat metadata', async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    vi.doMock('node:fs/promises', () => ({
      ...actual,
      async lstat(target: PathLike) {
        const stat = await actual.lstat(target)
        if (target === sourceFile) stat.uid += 1
        return stat
      },
    }))
    snapshot = await load()
    await assert.rejects(
      snapshot(request, async () => 0),
      /owner|protect/i
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  for (const which of [
    'sourceRoot',
    'sourceDirectory',
    'stagingRoot',
  ] as const) {
    it(`rejects a ${which} symlink alias`, async () => {
      const alias = path.join(base, `alias-${which}`)
      await fs.symlink(request[which], alias)
      await assert.rejects(
        snapshot({ ...request, [which]: alias }, async () => 0)
      )
      assert.deepEqual(await fs.readdir(request.stagingRoot), [])
    })
  }
  it('rejects nonprivate staging roots without chmodding them', async () => {
    await fs.chmod(request.stagingRoot, 0o755)
    await assert.rejects(
      snapshot(request, async () => 0),
      /private|protect/i
    )
    assert.equal((await fs.stat(request.stagingRoot)).mode & 0o777, 0o755)
  })
  it('rejects a source outside its configured root and overlapping staging', async () => {
    const outside = path.join(base, 'outside')
    await fs.mkdir(outside, { mode: 0o700 })
    await assert.rejects(
      snapshot({ ...request, sourceDirectory: outside }, async () => 0)
    )
    await assert.rejects(
      snapshot(
        { ...request, stagingRoot: request.sourceDirectory },
        async () => 0
      )
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), [])
  })
  it('creates distinct job directories and preserves unrelated collision-like names', async () => {
    const foreign = path.join(request.stagingRoot, 'job-existing')
    await fs.mkdir(foreign, { mode: 0o700 })
    const jobs: string[] = []
    for (let n = 0; n < 2; n++)
      await snapshot(request, async staged => {
        jobs.push(path.dirname(staged.inputDirectory))
        return 0
      })
    assert.notEqual(jobs[0], jobs[1])
    assert.deepEqual(await fs.readdir(request.stagingRoot), ['job-existing'])
  })
  it('preserves an atomic directory-creation failure without deleting an existing path', async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    const failure = Object.assign(new Error('synthetic collision'), {
      code: 'EEXIST',
    })
    const foreign = path.join(request.stagingRoot, 'job-existing')
    await fs.mkdir(foreign, { mode: 0o700 })
    vi.doMock('node:fs/promises', () => ({
      ...actual,
      async mkdtemp() {
        throw failure
      },
    }))
    snapshot = await load()
    await assert.rejects(
      snapshot(request, async () => 0),
      error => error === failure
    )
    assert.deepEqual(await fs.readdir(request.stagingRoot), ['job-existing'])
  })
  it('aggregates original consumer and cleanup errors without deleting source/root', async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    const primary = new Error('synthetic callback failure')
    const cleanup = new Error('synthetic cleanup failure')
    let job = ''
    const rm: typeof actual.rm = async (target, options) => {
      if (target === job) throw cleanup
      return actual.rm(target, options)
    }
    vi.doMock('node:fs/promises', () => ({ ...actual, rm }))
    snapshot = await load()
    const error: unknown = await snapshot(request, async staged => {
      job = path.dirname(staged.inputDirectory)
      throw primary
    }).catch((error: unknown) => error)
    assert.ok(error instanceof AggregateError)
    const causes: readonly unknown[] = error.errors
    assert.ok(causes.includes(primary) && causes.includes(cleanup))
    await fs.stat(job)
    await fs.stat(sourceFile)
  })
  it('preserves a cleanup failure after successful work instead of reporting success', async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      )
    const cleanup = new Error('synthetic cleanup failed after success')
    let job = ''
    const rm: typeof actual.rm = async (target, options) => {
      if (target === job) throw cleanup
      return actual.rm(target, options)
    }
    vi.doMock('node:fs/promises', () => ({ ...actual, rm }))
    snapshot = await load()
    await assert.rejects(
      snapshot(request, async staged => {
        job = path.dirname(staged.inputDirectory)
        return 0
      }),
      error => error === cleanup
    )
    await fs.stat(job)
    await fs.stat(sourceFile)
  })
  it('preserves a foreign replacement of the job path and reports incomplete cleanup', async () => {
    let foreign = ''
    const moved = path.join(base, 'moved-owned-job')
    await assert.rejects(
      snapshot(request, async staged => {
        foreign = path.dirname(staged.inputDirectory)
        await fs.rename(foreign, moved)
        await fs.mkdir(foreign, { mode: 0o700 })
        await fs.writeFile(path.join(foreign, 'keep'), 'foreign')
        return 0
      }),
      /identity|replaced|owned/i
    )
    assert.equal(
      await fs.readFile(path.join(foreign, 'keep'), 'utf8'),
      'foreign'
    )
    await fs.stat(path.join(moved, 'input', 'main.tex'))
    await fs.stat(sourceFile)
  })
})
