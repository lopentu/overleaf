import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test, vi } from 'vitest'
import tar from 'tar-stream'

type FileObserver = {
  closeCalls: number
  closeErrors: unknown[]
  closed: Promise<void>
  written: Promise<void>
}
function observeClose(file: FileHandle): FileObserver {
  const closed = Promise.withResolvers<undefined>()
  const written = Promise.withResolvers<undefined>()
  const observer: FileObserver = {
    closeCalls: 0,
    closeErrors: [],
    closed: closed.promise,
    written: written.promise,
  }
  const write = file.write.bind(file)
  Object.defineProperty(file, 'write', {
    configurable: true,
    value: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const result = await write(buffer, offset, length, position)
      if (result.bytesWritten > 0) written.resolve(undefined)
      return result
    },
  })
  const close = file.close.bind(file)
  file.close = async () => {
    observer.closeCalls++
    try {
      await close()
    } catch (error) {
      observer.closeErrors.push(error)
      throw error
    } finally {
      closed.resolve(undefined)
    }
  }
  return observer
}
async function fixture(
  run: (base: string, opened: Promise<FileObserver>) => Promise<void>,
  configure: (file: FileHandle) => void = () => {}
): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-owner-test-'))
  const observed = Promise.withResolvers<FileObserver>()
  vi.resetModules()
  vi.doMock('node:fs/promises', () => ({
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      observed.resolve(observeClose(file))
      configure(file)
      return file
    },
  }))
  try {
    await run(base, observed.promise)
  } finally {
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    await fs.rm(base, { recursive: true, force: true })
  }
}
async function waitForBytes(
  filename: string,
  observed: Promise<FileObserver>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Output did not receive any bytes within 2 seconds'))
    }, 2000)
  })
  try {
    await Promise.race([observed.then(owner => owner.written), deadline])
    assert.ok((await fs.stat(filename)).size > 0)
  } finally {
    clearTimeout(timer)
  }
}
async function assertClosedOnce(
  observed: Promise<FileObserver>
): Promise<void> {
  const owner = await observed
  await owner.closed
  assert.equal(owner.closeCalls, 1)
  assert.deepEqual(owner.closeErrors, [])
}

test('cancelling input after body bytes closes its owner once without a hidden close error', async () => {
  await fixture(async (base, observed) => {
    const { createInputArchive } =
      await import('../../../app/js/BoundedProjectArchive.ts')
    await fs.writeFile(path.join(base, 'input'), Buffer.alloc(1024 * 1024))
    let transferred = 0
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length
        callback(
          transferred > 512
            ? new Error('sentinel input consumer cancelled')
            : undefined
        )
      },
    })
    await assert.rejects(
      pipeline(createInputArchive(base), sink),
      /sentinel input consumer cancelled/
    )
    assert.ok(transferred > 512)
    await assertClosedOnce(observed)
  })
})

for (const failure of ['upstream error', 'abort'] as const) {
  test(`output ${failure} after body bytes closes its owner once without hidden finalization errors`, async () => {
    await fixture(async (base, observed) => {
      const { extractOutputArchive } =
        await import('../../../app/js/BoundedProjectArchive.ts')
      const pack = tar.pack()
      const controller = new AbortController()
      const output = path.join(base, 'output')
      const extraction = extractOutputArchive(pack, output, {
        signal: controller.signal,
      })
      const rejected =
        failure === 'abort'
          ? assert.rejects(extraction, { name: 'AbortError' })
          : assert.rejects(extraction, /sentinel output upstream failed/)
      const entry = pack.entry({
        name: 'file',
        type: 'file',
        size: 1024 * 1024,
      })
      entry.on('error', () => {})
      entry.write(Buffer.alloc(64 * 1024))
      await waitForBytes(path.join(output, 'file'), observed)
      if (failure === 'abort') controller.abort()
      else pack.destroy(new Error('sentinel output upstream failed'))
      await rejected
      await assertClosedOnce(observed)
      assert.deepEqual(await fs.readdir(base), [])
    })
  })
}

test('input cancellation waits for a pending FileHandle read before owner close', async () => {
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  try {
    await fixture(
      async (base, observed) => {
        const { createInputArchive } =
          await import('../../../app/js/BoundedProjectArchive.ts')
        await fs.writeFile(path.join(base, 'input'), Buffer.alloc(1024 * 1024))
        const controller = new AbortController()
        const rejected = assert.rejects(
          pipeline(
            createInputArchive(base, { signal: controller.signal }),
            new Writable({
              write(_chunk, _encoding, callback) {
                callback()
              },
            })
          ),
          { name: 'AbortError' }
        )
        await started.promise
        controller.abort()
        await rejected
        assert.equal((await observed).closeCalls, 0)
        release.resolve(undefined)
        await assertClosedOnce(observed)
      },
      file => {
        const read = file.read.bind(file)
        Object.defineProperty(file, 'read', {
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null
          ) => {
            const result = await read(buffer, offset, length, position)
            started.resolve(undefined)
            await release.promise
            return result
          },
        })
      }
    )
  } finally {
    release.resolve(undefined)
  }
})

for (const failure of ['upstream error', 'abort'] as const) {
  test(`output ${failure} waits for a pending FileHandle write before owner close`, async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await fixture(
        async (base, observed) => {
          const { extractOutputArchive } =
            await import('../../../app/js/BoundedProjectArchive.ts')
          const pack = tar.pack()
          const controller = new AbortController()
          const extraction = extractOutputArchive(
            pack,
            path.join(base, 'output'),
            { signal: controller.signal }
          )
          const rejected =
            failure === 'abort'
              ? assert.rejects(extraction, { name: 'AbortError' })
              : assert.rejects(extraction, /sentinel held write failure/)
          const entry = pack.entry({
            name: 'file',
            type: 'file',
            size: 1024 * 1024,
          })
          entry.on('error', () => {})
          entry.write(Buffer.alloc(64 * 1024))
          await started.promise
          if (failure === 'abort') controller.abort()
          else pack.destroy(new Error('sentinel held write failure'))
          await new Promise<void>(resolve => {
            setImmediate(resolve)
          })
          assert.equal((await observed).closeCalls, 0)
          release.resolve(undefined)
          await rejected
          await assertClosedOnce(observed)
          assert.deepEqual(await fs.readdir(base), [])
        },
        file => {
          const write = file.write.bind(file)
          Object.defineProperty(file, 'write', {
            value: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => {
              const result = await write(buffer, offset, length, position)
              started.resolve(undefined)
              await release.promise
              return result
            },
          })
        }
      )
    } finally {
      release.resolve(undefined)
    }
  })
}

test('output handles partial FileHandle writes without losing bytes and closes once', async () => {
  await fixture(
    async (base, observed) => {
      const { extractOutputArchive } =
        await import('../../../app/js/BoundedProjectArchive.ts')
      const pack = tar.pack()
      const output = path.join(base, 'output')
      const extraction = extractOutputArchive(pack, output)
      pack.entry(
        { name: 'file', type: 'file' },
        Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789')
      )
      pack.finalize()
      await extraction
      await assertClosedOnce(observed)
      assert.equal(
        await fs.readFile(path.join(output, 'file'), 'utf8'),
        'abcdefghijklmnopqrstuvwxyz0123456789'
      )
    },
    file => {
      const write = file.write.bind(file)
      Object.defineProperty(file, 'write', {
        value: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => write(buffer, offset, Math.min(7, length), position),
      })
    }
  )
})
