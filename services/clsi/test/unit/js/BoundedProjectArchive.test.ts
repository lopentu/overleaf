import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'vitest'
import tar, { type Headers } from 'tar-stream'
import {
  createInputArchive,
  extractOutputArchive,
} from '../../../app/js/BoundedProjectArchive.ts'

type FixtureEntry = {
  name: string
  type?: Headers['type']
  data?: Buffer
  linkname?: string
  mode?: number
}
async function fixture(entries: FixtureEntry[]): Promise<Buffer> {
  const pack = tar.pack()
  const result = collect(pack)
  for (const entry of entries) {
    const { data = Buffer.alloc(0), ...header } = entry
    await new Promise<void>((resolve, reject) => {
      pack.entry({ ...header, size: data.length }, data, error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
  pack.finalize()
  return result
}
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<unknown>) {
    assert.ok(Buffer.isBuffer(chunk))
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function sandbox(run: (base: string) => Promise<void>): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-archive-test-'))
  try {
    await run(base)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}
function source(data: Buffer): Readable {
  return Readable.from([data])
}

// Omitting the packer, content streaming, or ownership/mode normalization breaks this.
test('round-trips nested, binary, empty files and normalizes TAR ownership and modes', async () => {
  await sandbox(async base => {
    const input = path.join(base, 'input')
    await fs.mkdir(path.join(input, 'nested'), { recursive: true })
    await fs.writeFile(
      path.join(input, 'nested', 'binary.bin'),
      Buffer.from([0, 255, 10, 128])
    )
    await fs.writeFile(path.join(input, 'empty.tex'), '')
    await fs.chmod(path.join(input, 'nested', 'binary.bin'), 0o777)
    const packed = await collect(createInputArchive(input))
    const extract = tar.extract()
    const headers: Headers[] = []
    extract.on('entry', (header, body, next) => {
      headers.push(header)
      body.resume()
      body.once('end', next)
    })
    await pipeline(source(packed), extract)
    assert.equal(headers.length, 3)
    for (const header of headers) {
      assert.equal(header.uid, 33)
      assert.equal(header.gid, 33)
      assert.equal(header.mode, header.type === 'directory' ? 0o755 : 0o644)
    }
    const target = path.join(base, 'output')
    assert.deepEqual(await extractOutputArchive(source(packed), target), {
      entries: 3,
      files: 2,
      bytes: 4,
    })
    assert.deepEqual(
      await fs.readFile(path.join(target, 'nested', 'binary.bin')),
      Buffer.from([0, 255, 10, 128])
    )
    assert.equal((await fs.stat(path.join(target, 'empty.tex'))).size, 0)
    assert.equal((await fs.stat(target)).mode & 0o777, 0o700)
    assert.equal(
      (await fs.stat(path.join(target, 'nested', 'binary.bin'))).mode & 0o777,
      0o644
    )
  })
})

for (const name of [
  '/escape',
  '../escape',
  'a/../../escape',
  './file',
  'a/./b',
  'a//b',
  'a/../b',
  'file/',
  '',
  'a\\b',
  'C:/escape',
]) {
  test(`rejects noncanonical file path ${JSON.stringify(name)} without outside writes`, async () => {
    await sandbox(async base => {
      const packed = await fixture([{ name, data: Buffer.from('attack') }])
      const target = path.join(base, 'output')
      await assert.rejects(extractOutputArchive(source(packed), target))
      assert.deepEqual(await fs.readdir(base), [])
    })
  })
}
for (const type of [
  'symlink',
  'link',
  'character-device',
  'block-device',
  'fifo',
  'contiguous-file',
] as const) {
  test(`rejects ${type} entries and cancels the source`, async () => {
    await sandbox(async base => {
      const input = source(
        await fixture([{ name: 'unsafe', type, linkname: '/escape' }])
      )
      await assert.rejects(extractOutputArchive(input, path.join(base, 'out')))
      assert.equal(input.destroyed, true)
      assert.deepEqual(await fs.readdir(base), [])
    })
  })
}

test('rejects duplicate files, directories and file/directory collisions', async () => {
  for (const entries of [
    [{ name: 'x' }, { name: 'x' }],
    [
      { name: 'x', type: 'directory' as const },
      { name: 'x/', type: 'directory' as const },
    ],
    [{ name: 'x' }, { name: 'x/y' }],
    [{ name: 'x/y' }, { name: 'x' }],
  ])
    await sandbox(async base => {
      await assert.rejects(
        extractOutputArchive(
          source(await fixture(entries)),
          path.join(base, 'out')
        )
      )
      assert.deepEqual(await fs.readdir(base), [])
    })
})

test('strips only an explicit required Docker directory prefix', async () => {
  await sandbox(async base => {
    const packed = await fixture([
      { name: 'compile/', type: 'directory' },
      { name: 'compile/main.pdf', data: Buffer.from('pdf') },
    ])
    assert.deepEqual(
      await extractOutputArchive(source(packed), path.join(base, 'out'), {
        requiredPrefix: 'compile',
      }),
      { entries: 2, files: 1, bytes: 3 }
    )
    assert.equal(
      await fs.readFile(path.join(base, 'out/main.pdf'), 'utf8'),
      'pdf'
    )
    for (const entries of [
      [{ name: 'compile2/file' }],
      [{ name: 'compile' }],
      [{ name: 'compile/../escape' }],
      [{ name: 'file' }],
      [],
      [{ name: 'compile/file' }],
    ])
      await assert.rejects(
        extractOutputArchive(
          source(await fixture(entries)),
          path.join(base, 'bad'),
          { requiredPrefix: 'compile' }
        )
      )
  })
})

test('never overwrites existing output directories, files, or symlinks', async () => {
  await sandbox(async base => {
    const packed = await fixture([
      { name: 'keep', data: Buffer.from('attack') },
    ])
    const output = path.join(base, 'out')
    await fs.mkdir(output)
    await fs.writeFile(path.join(output, 'keep'), 'original')
    await assert.rejects(extractOutputArchive(source(packed), output))
    assert.equal(
      await fs.readFile(path.join(output, 'keep'), 'utf8'),
      'original'
    )
    await fs.symlink(output, path.join(base, 'link'))
    await assert.rejects(
      extractOutputArchive(source(packed), path.join(base, 'link'))
    )
    await assert.rejects(
      extractOutputArchive(source(packed), path.join(base, 'link', 'child'))
    )
    await assert.rejects(
      extractOutputArchive(source(packed), path.join(output, 'keep'))
    )
    assert.deepEqual(await fs.readdir(output), ['keep'])
  })
})

for (const [limits, entries] of [
  [
    { maxEntries: 1 },
    [
      { name: 'empty-dir', type: 'directory' },
      { name: 'another', type: 'directory' },
    ],
  ],
  [{ maxEntries: 1 }, [{ name: 'implicit/parent/file' }]],
  [{ maxFileBytes: 3 }, [{ name: 'large', data: Buffer.from('1234') }]],
  [
    { maxTotalBytes: 3 },
    [
      { name: 'one', data: Buffer.from('12') },
      { name: 'two', data: Buffer.from('34') },
    ],
  ],
] satisfies [Record<string, number>, FixtureEntry[]][]) {
  test(`enforces output limits ${JSON.stringify(limits)} before materialization`, async () => {
    await sandbox(async base => {
      await assert.rejects(
        extractOutputArchive(
          source(await fixture(entries)),
          path.join(base, 'out'),
          { limits }
        )
      )
      assert.deepEqual(await fs.readdir(base), [])
    })
  })
}

test('allows exact output limit boundaries including implicit directories', async () => {
  await sandbox(async base => {
    const packed = await fixture([
      { name: 'parent/file', data: Buffer.from('1234') },
    ])
    assert.deepEqual(
      await extractOutputArchive(source(packed), path.join(base, 'out'), {
        limits: { maxEntries: 2, maxFileBytes: 4, maxTotalBytes: 4 },
      }),
      { entries: 2, files: 1, bytes: 4 }
    )
  })
})

test('rejects unsafe pack inputs and enforces input size/count limits', async () => {
  await sandbox(async base => {
    await fs.mkdir(path.join(base, 'in'))
    await fs.writeFile(path.join(base, 'in', 'file'), '1234')
    await assert.rejects(
      collect(
        createInputArchive(path.join(base, 'in'), {
          limits: { maxFileBytes: 3 },
        })
      )
    )
    await assert.rejects(
      collect(
        createInputArchive(path.join(base, 'in'), {
          limits: { maxTotalBytes: 3 },
        })
      )
    )
    await fs.mkdir(path.join(base, 'in', 'dir'))
    await assert.rejects(
      collect(
        createInputArchive(path.join(base, 'in'), {
          limits: { maxEntries: 1 },
        })
      )
    )
    await fs.symlink('/escape', path.join(base, 'in', 'link'))
    await assert.rejects(collect(createInputArchive(path.join(base, 'in'))))
    await fs.unlink(path.join(base, 'in', 'link'))
    await fs.link(
      path.join(base, 'in', 'file'),
      path.join(base, 'in', 'hardlink')
    )
    await assert.rejects(collect(createInputArchive(path.join(base, 'in'))))
  })
})

test('rejects truncated bodies, truncated headers and declared-length mismatches', async () => {
  await sandbox(async base => {
    const packed = await fixture([
      { name: 'file', data: Buffer.alloc(2048, 65) },
    ])
    for (const length of [100, 512, 700, 2047]) {
      await assert.rejects(
        extractOutputArchive(
          source(packed.subarray(0, length)),
          path.join(base, 'out')
        )
      )
      assert.deepEqual(await fs.readdir(base), [])
    }
  })
})

test('cancels a never-ending upstream after an invalid header', async () => {
  await sandbox(async base => {
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, path.join(base, 'out'))
    input.write((await fixture([{ name: '../escape' }])).subarray(0, 512))
    await assert.rejects(extraction)
    assert.equal(input.destroyed, true)
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('aborting a stalled extraction closes upstream and removes partial output', async () => {
  await sandbox(async base => {
    const controller = new AbortController()
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, path.join(base, 'out'), {
      signal: controller.signal,
    })
    input.write(
      (await fixture([{ name: 'partial', data: Buffer.alloc(2048) }])).subarray(
        0,
        600
      )
    )
    controller.abort()
    await assert.rejects(extraction, { name: 'AbortError' })
    assert.equal(input.destroyed, true)
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('pre-aborted packing fails and downstream cancellation stops a large input stream', async () => {
  await sandbox(async base => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      collect(createInputArchive(base, { signal: controller.signal })),
      { name: 'AbortError' }
    )
    await fs.writeFile(path.join(base, 'large'), Buffer.alloc(1024 * 1024))
    const input = createInputArchive(base)
    let writes = 0
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        writes++
        callback(new Error('consumer cancelled'))
      },
    })
    await assert.rejects(pipeline(input, sink), /consumer cancelled/)
    assert.equal(input.destroyed, true)
    assert.equal(writes, 1)
  })
})

test('rejects unbounded extended-header metadata without waiting for the whole archive', async () => {
  await sandbox(async base => {
    // tar-stream consumes PAX header bodies internally. A valid header whose body
    // is deliberately withheld must still trip the wrapper's metadata budget.
    const packed = await fixture([{ name: 'a'.repeat(100000) }])
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, path.join(base, 'out'))
    input.write(packed.subarray(0, 96 * 1024))
    await assert.rejects(extraction)
    assert.equal(input.destroyed, true)
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('safe file creation refuses an injected symlink parent', async () => {
  await sandbox(async base => {
    const output = path.join(base, 'out')
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, output)
    // Feed the directory first, then adversarially replace it before its child.
    const directory = await fixture([{ name: 'parent', type: 'directory' }])
    input.write(directory.subarray(0, 512))
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fs.access(path.join(output, 'parent'), constants.F_OK)
        break
      } catch {
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    await fs.rmdir(path.join(output, 'parent'))
    await fs.symlink(base, path.join(output, 'parent'))
    input.end(
      await fixture([{ name: 'parent/escape', data: Buffer.from('attack') }])
    )
    await assert.rejects(extraction)
    await assert.rejects(fs.access(path.join(base, 'escape')))
    assert.deepEqual(await fs.readdir(base), [])
  })
})

// Losing backpressure or applying the metadata window to ordinary payload breaks this.
test('streams a multi-megabyte payload without collecting the archive', async () => {
  await sandbox(async base => {
    const input = path.join(base, 'in')
    await fs.mkdir(input)
    await fs.writeFile(
      path.join(input, 'large.bin'),
      Buffer.alloc(4 * 1024 * 1024, 171)
    )
    const summary = await extractOutputArchive(
      createInputArchive(input),
      path.join(base, 'out')
    )
    assert.deepEqual(summary, { entries: 1, files: 1, bytes: 4 * 1024 * 1024 })
    const result = await fs.readFile(path.join(base, 'out/large.bin'))
    assert.equal(result.length, 4 * 1024 * 1024)
    assert.equal(result[0], 171)
    assert.equal(result[result.length - 1], 171)
  })
})

test('handles an upstream error while filesystem setup is still pending', async () => {
  await sandbox(async base => {
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, path.join(base, 'out'))
    const rejected = assert.rejects(extraction, /upstream failed/)
    input.destroy(new Error('upstream failed'))
    await rejected
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('rejects invalid limits and pre-aborted output without leaving a directory', async () => {
  await sandbox(async base => {
    const controller = new AbortController()
    controller.abort()
    const input = new PassThrough()
    await assert.rejects(
      extractOutputArchive(input, path.join(base, 'out'), {
        signal: controller.signal,
      }),
      { name: 'AbortError' }
    )
    assert.equal(input.destroyed, true)
    for (const maxEntries of [-1, NaN, Infinity, 1.5]) {
      await assert.rejects(
        extractOutputArchive(source(Buffer.alloc(0)), path.join(base, 'out'), {
          limits: { maxEntries },
        })
      )
      await assert.rejects(
        collect(createInputArchive(base, { limits: { maxEntries } }))
      )
    }
    assert.deepEqual(await fs.readdir(base), [])
  })
})

function alterHeader(archive: Buffer, edit: (header: Buffer) => void): Buffer {
  const result = Buffer.from(archive)
  const header = result.subarray(0, 512)
  edit(header)
  header.fill(32, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return result
}

test('rejects bad checksums, unknown types, and nonzero directory bodies', async () => {
  await sandbox(async base => {
    const original = await fixture([{ name: 'file', data: Buffer.from('abc') }])
    const checksum = Buffer.from(original)
    checksum[0] = 120
    const unknownType = alterHeader(original, header => {
      header[156] = 90
    })
    const directoryBody = alterHeader(original, header => {
      header[156] = 53
    })
    for (const packed of [checksum, unknownType, directoryBody]) {
      await assert.rejects(
        extractOutputArchive(source(packed), path.join(base, 'out'))
      )
      assert.deepEqual(await fs.readdir(base), [])
    }
  })
})

test('enforces the default output per-file bound from the header before reading its body', async () => {
  await sandbox(async base => {
    const original = await fixture([{ name: 'large' }])
    const oversized = alterHeader(original, header => {
      header.write(
        (16 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0',
        124,
        'ascii'
      )
    })
    const input = new PassThrough()
    const extraction = extractOutputArchive(input, path.join(base, 'out'))
    input.write(oversized.subarray(0, 512))
    await assert.rejects(extraction, /file limit exceeded/)
    assert.equal(input.destroyed, true)
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('enforces the default input per-file bound before reading sparse file contents', async () => {
  await sandbox(async base => {
    await fs.writeFile(path.join(base, 'sparse'), '')
    await fs.truncate(path.join(base, 'sparse'), 50 * 1024 * 1024 + 1)
    await assert.rejects(
      collect(createInputArchive(base)),
      /file limit exceeded/
    )
  })
})

test('bounds default directory entry counts at 4096', async () => {
  await sandbox(async base => {
    const entries: FixtureEntry[] = Array.from(
      { length: 4097 },
      (_, index) => ({ name: `dir-${String(index)}`, type: 'directory' })
    )
    const packed = await fixture(entries)
    await assert.rejects(
      extractOutputArchive(source(packed), path.join(base, 'out')),
      /entry limit exceeded/
    )
    assert.deepEqual(await fs.readdir(base), [])
  })
})

test('supports bounded PAX unicode names and validates their decoded paths', async () => {
  await sandbox(async base => {
    const packed = await fixture([
      { name: '論文.tex', data: Buffer.from('tex') },
    ])
    await extractOutputArchive(source(packed), path.join(base, 'out'))
    assert.equal(
      await fs.readFile(path.join(base, 'out/論文.tex'), 'utf8'),
      'tex'
    )
    await assert.rejects(
      extractOutputArchive(
        source(await fixture([{ name: '../論文.tex' }])),
        path.join(base, 'bad')
      )
    )
  })
})

test('normalizes extracted file and directory permissions under a restrictive umask', async () => {
  const previous = process.umask(0o077)
  try {
    await sandbox(async base => {
      const packed = await fixture([
        { name: 'dir/file', data: Buffer.from('data') },
      ])
      const output = path.join(base, 'out')
      await extractOutputArchive(source(packed), output)
      assert.equal(
        (await fs.stat(path.join(output, 'dir'))).mode & 0o777,
        0o755
      )
      assert.equal(
        (await fs.stat(path.join(output, 'dir/file'))).mode & 0o777,
        0o644
      )
    })
  } finally {
    process.umask(previous)
  }
})

test('aborts an active pack stream before consuming the full file', async () => {
  await sandbox(async base => {
    await fs.writeFile(path.join(base, 'sparse'), '')
    await fs.truncate(path.join(base, 'sparse'), 32 * 1024 * 1024)
    const controller = new AbortController()
    const packed = createInputArchive(base, { signal: controller.signal })
    packed.once('data', () => {
      controller.abort()
    })
    await assert.rejects(collect(packed), { name: 'AbortError' })
    assert.equal(packed.destroyed, true)
  })
})

test('round-trips an empty project to a fresh empty staging directory', async () => {
  await sandbox(async base => {
    const input = path.join(base, 'in')
    await fs.mkdir(input)
    const target = path.join(base, 'out')
    assert.deepEqual(
      await extractOutputArchive(createInputArchive(input), target),
      { entries: 0, files: 0, bytes: 0 }
    )
    assert.deepEqual(await fs.readdir(target), [])
  })
})

test('enforces the default 100 MiB aggregate input budget while streaming', async () => {
  await sandbox(async base => {
    for (const name of ['one', 'two']) {
      await fs.writeFile(path.join(base, name), '')
      await fs.truncate(path.join(base, name), 50 * 1024 * 1024)
    }
    await fs.writeFile(path.join(base, 'extra'), 'x')
    const discard = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    await assert.rejects(
      pipeline(createInputArchive(base), discard),
      /total byte limit exceeded/
    )
  })
})

test('enforces the default 64 MiB aggregate output budget while streaming', async () => {
  await sandbox(async base => {
    const pack = tar.pack()
    const extraction = extractOutputArchive(pack, path.join(base, 'out'))
    const rejected = assert.rejects(extraction, /total byte limit exceeded/)
    function* zeros(size: number): Generator<Buffer> {
      const chunk = Buffer.alloc(64 * 1024)
      while (size > 0) {
        const length = Math.min(size, chunk.length)
        yield chunk.subarray(0, length)
        size -= length
      }
    }
    try {
      for (const name of ['one', 'two', 'three', 'four']) {
        const size = 16 * 1024 * 1024
        await pipeline(
          Readable.from(zeros(size)),
          pack.entry({ name, type: 'file', size })
        )
      }
      const extra = pack.entry({ name: 'extra', type: 'file', size: 1 })
      extra.on('error', () => {})
      extra.end(Buffer.from('x'))
      pack.finalize()
      await rejected
      assert.equal(pack.destroyed, true)
      assert.deepEqual(await fs.readdir(base), [])
    } finally {
      pack.destroy()
    }
  })
})
