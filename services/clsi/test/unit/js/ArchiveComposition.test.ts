import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar, { type Headers } from 'tar-stream'
import { test } from 'vitest'
import * as archive from '../../../app/js/BoundedProjectArchive.ts'

type Entry = {
  name: string
  size?: number
  fill?: number
  data?: Buffer
  type?: Headers['type']
  linkname?: string
}
async function sandbox(work: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-composition-'))
  try {
    await work(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}
function zeros(size: number, fill = 0): Readable {
  return Readable.from(
    (function* () {
      const chunk = Buffer.alloc(64 * 1024, fill)
      while (size > 0) {
        const count = Math.min(size, chunk.length)
        yield chunk.subarray(0, count)
        size -= count
      }
    })()
  )
}
function fixture(entries: Entry[]): {
  stream: Readable
  completion: Promise<void>
} {
  const pack = tar.pack()
  const completion = (async () => {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'compile/', type: 'directory' }, error =>
        error ? reject(error) : resolve()
      )
    })
    for (const e of entries) {
      const size = e.data?.length ?? e.size ?? 0
      const sink = pack.entry({
        name: e.name,
        type: e.type ?? 'file',
        size,
        ...(e.linkname === undefined ? {} : { linkname: e.linkname }),
      })
      await pipeline(
        e.data === undefined ? zeros(size, e.fill) : Readable.from([e.data]),
        sink
      )
    }
    pack.finalize()
  })()
  void completion.catch((error: unknown) =>
    pack.destroy(error instanceof Error ? error : new Error(String(error)))
  )
  return { stream: pack, completion }
}
async function manifest(input: string) {
  assert.equal(typeof archive.createManifestInputArchiveBundle, 'function')
  const bundle = archive.createManifestInputArchiveBundle(input)
  const transfer = pipeline(bundle.stream, discard())
  const results = await Promise.allSettled([transfer, bundle.completion])
  const result = results[1]
  assert.equal(result?.status, 'fulfilled')
  if (result?.status !== 'fulfilled')
    throw new Error('manifest producer failed')
  return result.value
}
async function extract(
  input: string,
  output: string,
  entries: Entry[],
  diagnostics: { stdout?: Buffer; stderr?: Buffer } = {}
) {
  assert.equal(typeof archive.extractCompileOutputArchive, 'function')
  const trusted = await manifest(input)
  const bundle = fixture(entries)
  try {
    return await archive.extractCompileOutputArchive(
      bundle.stream,
      output,
      trusted,
      diagnostics
    )
  } finally {
    bundle.stream.destroy()
    await Promise.allSettled([bundle.completion])
  }
}
const MiB = 1024 * 1024

test('manifest records exact uploaded binary/unicode/empty bytes and freezes records', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(path.join(input, '文'), { recursive: true })
    await fs.writeFile(path.join(input, '文', 'x'), Buffer.from([0, 255, 10]))
    await fs.writeFile(path.join(input, 'empty'), '')
    const result = await manifest(input)
    assert.deepEqual(result.summary, { entries: 3, files: 2, bytes: 3 })
    assert.deepEqual(result.directories, ['文'])
    assert.deepEqual(
      result.files
        .map(f => ({ ...f }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      [
        {
          path: 'empty',
          size: 0,
          sha256:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        {
          path: '文/x',
          size: 3,
          sha256: createHash('sha256')
            .update(Buffer.from([0, 255, 10]))
            .digest('hex'),
        },
      ]
    )
    assert.ok(
      Object.isFrozen(result) &&
        Object.isFrozen(result.files) &&
        result.files.every(Object.isFrozen) &&
        Object.isFrozen(result.directories) &&
        Object.isFrozen(result.summary)
    )
  })
})
for (const size of [40 * MiB, 50 * MiB]) {
  test(`unchanged ${size / MiB}MiB original is hashed and omitted while a small PDF is retained`, async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      await fs.writeFile(path.join(input, 'resource'), '')
      await fs.truncate(path.join(input, 'resource'), size)
      const result = await extract(input, path.join(root, 'out'), [
        { name: 'compile/resource', size },
        { name: 'compile/output.pdf', data: Buffer.from('pdf') },
      ])
      assert.deepEqual(await fs.readdir(path.join(root, 'out')), ['output.pdf'])
      assert.equal(
        await fs.readFile(path.join(root, 'out/output.pdf'), 'utf8'),
        'pdf'
      )
      assert.equal(result.original.bytes, size)
      assert.equal(result.generated.bytes, 3)
      assert.equal(result.retained.bytes, 3)
      assert.deepEqual((await fs.readdir(root)).sort(), ['in', 'out'])
    })
  })
}
for (const [before, after, retained] of [
  ['old', 'new', true],
  ['old', 'old', false],
  ['old', 'longer', true],
  ['', '', false],
] as const) {
  test(`output.pdf ${JSON.stringify(before)}→${JSON.stringify(after)} classifies by bytes`, async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      await fs.writeFile(path.join(input, 'output.pdf'), before)
      const result = await extract(input, path.join(root, 'out'), [
        { name: 'compile/output.pdf', data: Buffer.from(after) },
      ])
      assert.deepEqual(
        await fs.readdir(path.join(root, 'out')),
        retained ? ['output.pdf'] : []
      )
      assert.equal(result.generated.files, retained ? 1 : 0)
      assert.equal(result.original.files, retained ? 0 : 1)
      assert.deepEqual((await fs.readdir(root)).sort(), ['in', 'out'])
    })
  })
}
test('same-size large changed original rejects with no materialized or provisional tree', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    await fs.writeFile(path.join(input, 'resource'), '')
    await fs.truncate(path.join(input, 'resource'), 17 * MiB)
    await assert.rejects(
      extract(input, path.join(root, 'out'), [
        { name: 'compile/resource', size: 17 * MiB, fill: 1 },
      ]),
      /generated file limit/
    )
    assert.deepEqual(await fs.readdir(root), ['in'])
  })
})
for (const size of [16 * MiB, 16 * MiB + 1]) {
  test(`generated file size ${size} enforces exact16MiB boundary`, async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      const pending = extract(input, path.join(root, 'out'), [
        { name: 'compile/new', size },
      ])
      if (size > 16 * MiB) {
        await assert.rejects(pending, /file limit/)
        assert.deepEqual(await fs.readdir(root), ['in'])
      } else {
        const result = await pending
        assert.equal(result.generated.bytes, size)
        assert.equal((await fs.stat(path.join(root, 'out/new'))).size, size)
      }
    })
  })
}
for (const extra of [0, 1]) {
  test(`generated aggregate64MiB plus ${extra} bytes is bounded`, async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      const entries: Entry[] = Array.from({ length: 4 }, (_, i) => ({
        name: `compile/${i}`,
        size: 16 * MiB,
      }))
      if (extra) entries.push({ name: 'compile/extra', size: extra })
      const pending = extract(input, path.join(root, 'out'), entries)
      if (extra) {
        await assert.rejects(pending, /total byte limit/)
        assert.deepEqual(await fs.readdir(root), ['in'])
      } else assert.equal((await pending).generated.bytes, 64 * MiB)
    })
  })
}
test('full generated budget accepts an unchanged provisional candidate but rejects a changed one', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    await fs.writeFile(path.join(input, 'output.pdf'), 'old')
    const full: Entry[] = Array.from({ length: 4 }, (_, i) => ({
      name: `compile/${i}`,
      size: 16 * MiB,
    }))
    assert.equal(
      (
        await extract(input, path.join(root, 'good'), [
          ...full,
          { name: 'compile/output.pdf', data: Buffer.from('old') },
        ])
      ).original.bytes,
      3
    )
    await assert.rejects(
      extract(input, path.join(root, 'bad'), [
        ...full,
        { name: 'compile/output.pdf', data: Buffer.from('new') },
      ]),
      /total byte limit/
    )
    assert.deepEqual((await fs.readdir(root)).sort(), ['good', 'in'])
  })
})
test('shared implicit original parents charge both ledgers and accept one later explicit directory', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(path.join(input, 'a/b'), { recursive: true })
    await fs.writeFile(path.join(input, 'a/b/original'), 'same')
    const result = await extract(input, path.join(root, 'out'), [
      { name: 'compile/a/b/original', data: Buffer.from('same') },
      { name: 'compile/a/b/new', size: 1 },
      { name: 'compile/a', type: 'directory' },
      { name: 'compile/a/b', type: 'directory' },
    ])
    assert.deepEqual(result.original, { entries: 3, files: 1, bytes: 4 })
    assert.deepEqual(result.generated, { entries: 4, files: 1, bytes: 1 })
    assert.equal(result.namespaceEntries, 5)
  })
})
for (const entries of [
  [
    { name: 'compile/a', size: 0 },
    { name: 'compile/a/child', size: 0 },
  ],
  [
    { name: 'compile/a', type: 'directory' },
    { name: 'compile/a/', type: 'directory' },
  ],
  [{ name: 'compile/../outside', size: 0 }],
  [{ name: 'compile/link', type: 'symlink', linkname: 'target' }],
] satisfies Entry[][]) {
  test(`compile mode rejects unsafe namespace ${entries.map(e => e.name).join(',')}`, async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      await assert.rejects(
        extract(input, path.join(root, 'out'), entries),
        /Unsafe project archive:/
      )
      assert.deepEqual(await fs.readdir(root), ['in'])
    })
  })
}
test('nonempty captured diagnostics replace exact files while obsolete generated bytes remain charged', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    const result = await extract(
      input,
      path.join(root, 'out'),
      [
        { name: 'compile/output.stdout', data: Buffer.from('obsolete') },
        { name: 'compile/.hidden', size: 2 },
      ],
      { stdout: Buffer.from([0, 255, 10]), stderr: Buffer.alloc(0) }
    )
    assert.deepEqual(
      await fs.readFile(path.join(root, 'out/output.stdout')),
      Buffer.from([0, 255, 10])
    )
    assert.equal(result.generated.bytes, 13)
    assert.equal(result.retained.bytes, 5)
  })
})
for (const entries of [
  [{ name: 'compile/output.stdout', type: 'directory' }],
  [{ name: 'compile/output.stdout/child', size: 0 }],
] satisfies Entry[][]) {
  test('captured diagnostic names cannot replace directories or ancestors', async () => {
    await sandbox(async root => {
      const input = path.join(root, 'in')
      await fs.mkdir(input)
      await assert.rejects(
        extract(input, path.join(root, 'out'), entries, {
          stdout: Buffer.from('log'),
        }),
        /diagnostic/
      )
      assert.deepEqual(await fs.readdir(root), ['in'])
    })
  })
}
test('captured bytes reserve aggregate allowance before obsolete TAR files are consumed', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    await assert.rejects(
      extract(
        input,
        path.join(root, 'out'),
        Array.from({ length: 4 }, (_, i) => ({
          name: `compile/${i}`,
          size: 16 * MiB,
        })),
        { stdout: Buffer.from('x') }
      ),
      /total byte limit/
    )
    assert.deepEqual(await fs.readdir(root), ['in'])
  })
})

test('JavaScript options cannot raise the fixed manifest upload file ceiling', async () => {
  await sandbox(async root => {
    await fs.writeFile(path.join(root, 'large'), '')
    await fs.truncate(path.join(root, 'large'), 50 * MiB + 1)
    const bundle: ReturnType<typeof archive.createManifestInputArchiveBundle> =
      Reflect.apply(archive.createManifestInputArchiveBundle, undefined, [
        root,
        { limits: { maxFileBytes: 51 * MiB } },
      ])
    const transfer = pipeline(bundle.stream, discard())
    void transfer.catch(() => {})
    await assert.rejects(bundle.completion, /file limit/)
    await Promise.allSettled([transfer])
  })
})
test('a deserialized or caller-forged manifest cannot grant an original-file allowance', async () => {
  await sandbox(async root => {
    const packed = fixture([])
    await assert.rejects(
      archive.extractCompileOutputArchive(
        packed.stream,
        path.join(root, 'out'),
        {
          files: [],
          directories: [],
          summary: { entries: 0, files: 0, bytes: 0 },
        }
      ),
      /manifest is not from/
    )
    await Promise.allSettled([packed.completion])
    assert.deepEqual(await fs.readdir(root), [])
  })
})
test('100MiB original payload plus64MiB generated payload streams under the combined wire bound', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    for (const name of ['one', 'two']) {
      await fs.writeFile(path.join(input, name), '')
      await fs.truncate(path.join(input, name), 50 * MiB)
    }
    const result = await extract(input, path.join(root, 'out'), [
      { name: 'compile/one', size: 50 * MiB },
      { name: 'compile/two', size: 50 * MiB },
      ...Array.from({ length: 4 }, (_, i) => ({
        name: `compile/new-${i}`,
        size: 16 * MiB,
      })),
    ])
    assert.equal(result.original.bytes, 100 * MiB)
    assert.equal(result.generated.bytes, 64 * MiB)
    assert.deepEqual((await fs.readdir(path.join(root, 'out'))).sort(), [
      'new-0',
      'new-1',
      'new-2',
      'new-3',
    ])
  })
})

test('root plus4095 generated nodes fits but root plus4096 rejects', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    const entries: Entry[] = Array.from({ length: 4095 }, (_, i) => ({
      name: `compile/d-${i}`,
      type: 'directory',
    }))
    const result = await extract(input, path.join(root, 'good'), entries)
    assert.equal(result.generated.entries, 4096)
    assert.equal(result.namespaceEntries, 4096)
    await assert.rejects(
      extract(input, path.join(root, 'bad'), [
        ...entries,
        { name: 'compile/extra', type: 'directory' },
      ]),
      /entry limit/
    )
    assert.deepEqual((await fs.readdir(root)).sort(), ['good', 'in'])
  })
}, 15000)
test('shared original parent directories cannot exempt generated children from4096 ledger', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    const entries: Entry[] = []
    for (let i = 0; i < 2048; i++) {
      await fs.mkdir(path.join(input, `d-${i}`))
      entries.push({ name: `compile/d-${i}`, type: 'directory' })
    }
    for (let i = 0; i < 2048; i++)
      entries.push({ name: `compile/d-${i}/new`, size: 0 })
    await assert.rejects(
      extract(input, path.join(root, 'out'), entries),
      /entry limit/
    )
    assert.deepEqual(await fs.readdir(root), ['in'])
  })
}, 15000)
test('4096 original directories and4095 new directories reach8192 combined nodes including root', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    const entries: Entry[] = []
    for (let i = 0; i < 4096; i++) {
      await fs.mkdir(path.join(input, `original-${i}`))
      entries.push({ name: `compile/original-${i}`, type: 'directory' })
    }
    for (let i = 0; i < 4095; i++)
      entries.push({ name: `compile/new-${i}`, type: 'directory' })
    const result = await extract(input, path.join(root, 'good'), entries)
    assert.equal(result.original.entries, 4096)
    assert.equal(result.generated.entries, 4096)
    assert.equal(result.namespaceEntries, 8192)
    await assert.rejects(
      extract(input, path.join(root, 'bad'), [
        ...entries,
        { name: 'compile/extra', type: 'directory' },
      ]),
      /entry limit/
    )
  })
}, 20000)

test('captured diagnostic replacement still hashes and classifies a large original with no staging file', async () => {
  await sandbox(async root => {
    const input = path.join(root, 'in')
    await fs.mkdir(input)
    await fs.writeFile(path.join(input, 'output.stdout'), '')
    await fs.truncate(path.join(input, 'output.stdout'), 17 * MiB)
    const result = await extract(
      input,
      path.join(root, 'good'),
      [{ name: 'compile/output.stdout', size: 17 * MiB }],
      { stdout: Buffer.from('new') }
    )
    assert.equal(result.original.bytes, 17 * MiB)
    assert.equal(result.generated.bytes, 3)
    assert.equal(
      await fs.readFile(path.join(root, 'good/output.stdout'), 'utf8'),
      'new'
    )
    await assert.rejects(
      extract(
        input,
        path.join(root, 'bad'),
        [{ name: 'compile/output.stdout', size: 17 * MiB, fill: 1 }],
        { stdout: Buffer.from('new') }
      ),
      /generated file limit/
    )
    assert.deepEqual((await fs.readdir(root)).sort(), ['good', 'in'])
  })
})
