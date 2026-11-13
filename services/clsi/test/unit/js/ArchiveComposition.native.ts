import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import tar from 'tar-stream'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import { DockerApiFixture } from './DockerApiFixture.ts'
import {
  createManifestInputArchiveBundle,
  extractCompileOutputArchive,
} from '../../../app/js/BoundedProjectArchive.ts'
const mode = process.argv[2]
assert.ok(
  [
    'adapter-artifacts',
    'adapter-artifacts-close-error',
    'adapter-stdout',
    'adapter-stdout-close-error',
    'diagnostic-allocation',
    'output-root-replaced',
    'producer-partial',
    'diagnostic-close-error',
    'producer-read',
    'producer-close',
    'producer-close-error',
    'write-abort',
    'write-close-error',
    'commit-error',
    'cleanup-error',
    'tar',
  ].includes(mode ?? '')
)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-native-')),
  input = path.join(root, 'in'),
  output = path.join(root, 'out')
await fs.mkdir(input, { mode: 0o700 })
const inputFile = path.join(input, 'output.pdf')
await fs.writeFile(inputFile, Buffer.from([0, 255, 10]))
const originalOpen = fs.open,
  originalLink = fs.link,
  originalRm = fs.rm
const entered = Promise.withResolvers<void>(),
  held = Promise.withResolvers<void>()
const sentinel = new Error('synthetic real-close failure'),
  commitError = new Error('synthetic commit failure'),
  cleanupError = new Error('synthetic cleanup failure')
let closes = 0,
  published = false,
  settled = false,
  operation: Promise<unknown> | undefined
let fixture: DockerApiFixture | undefined
const discard = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
const contains = (error: unknown, wanted: unknown): boolean =>
  error === wanted ||
  (error instanceof AggregateError &&
    error.errors.some((nested: unknown) => contains(nested, wanted)))
try {
  if (mode === 'diagnostic-allocation') {
    const bundle = createManifestInputArchiveBundle(input),
      transfer = pipeline(bundle.stream, discard()),
      manifest = await bundle.completion
    await transfer
    const oversized = Buffer.alloc(1024 * 1024 + 1),
      originalFrom = Buffer.from
    let copied = false
    Object.defineProperty(Buffer, 'from', {
      configurable: true,
      value: (value: unknown, ...rest: unknown[]): Buffer => {
        if (value === oversized) copied = true
        return Reflect.apply(originalFrom, Buffer, [value, ...rest])
      },
    })
    try {
      await assert.rejects(
        extractCompileOutputArchive(Readable.from([]), output, manifest, {
          stdout: oversized,
        }),
        /diagnostic byte limit/
      )
      assert.equal(
        copied,
        false,
        'oversized diagnostic copied before limit rejection'
      )
      assert.deepEqual(await fs.readdir(root), ['in'])
    } finally {
      Object.defineProperty(Buffer, 'from', {
        configurable: true,
        value: originalFrom,
      })
    }
  } else if (mode === 'producer-partial') {
    Object.defineProperty(fs, 'open', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...args)
        if (args[0] === inputFile) {
          const read = file.read.bind(file)
          Object.defineProperty(file, 'read', {
            value: (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null
            ) => read(buffer, offset, Math.min(1, length), position),
          })
        }
        return file
      },
    })
    syncBuiltinESMExports()
    const bundle = createManifestInputArchiveBundle(input),
      extract = tar.extract(),
      uploaded = createHash('sha256')
    let bytes = 0
    extract.on('entry', (_header, body, next) => {
      body.on('data', (chunk: Buffer) => {
        uploaded.update(chunk)
        bytes += chunk.length
      })
      body.on('end', next)
    })
    const transfer = pipeline(bundle.stream, extract)
    void transfer.catch(() => {})
    const manifest = await bundle.completion
    await transfer
    assert.equal(bytes, 3)
    assert.equal(manifest.files[0]?.sha256, uploaded.digest('hex'))
    assert.equal(manifest.summary.bytes, 3)
  } else if (mode?.startsWith('producer-') || mode?.startsWith('adapter-')) {
    Object.defineProperty(fs, 'open', {
      configurable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...args)
        if (args[0] === inputFile) {
          const read = file.read.bind(file),
            close = file.close.bind(file)
          if (mode === 'producer-read' || mode?.startsWith('adapter-'))
            Object.defineProperty(file, 'read', {
              value: async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null
              ) => {
                const result = await read(buffer, offset, length, position)
                entered.resolve()
                await held.promise
                return result
              },
            })
          file.close = async () => {
            closes++
            await close()
            if (mode !== 'producer-read' && !mode?.startsWith('adapter-')) {
              entered.resolve()
              await held.promise
            }
            if (
              mode === 'producer-close-error' ||
              mode?.endsWith('-close-error')
            )
              throw sentinel
          }
        }
        return file
      },
    })
    syncBuiltinESMExports()
    const abort = new AbortController()
    let transfer: Promise<void> | undefined
    const work = mode?.startsWith('adapter-')
      ? (async () => {
          fixture = new DockerApiFixture()
          const image = `sha256:${'a'.repeat(64)}`
          const runner = new EphemeralDockerJob(await fixture.open(), {
            trustedStagingRoot: root,
            allowedImages: [image],
            allowedExecutables: ['/usr/bin/pdflatex'],
          })
          const request = {
            image,
            argv: ['/usr/bin/pdflatex'],
            cwd: '/compile',
            inputDirectory: input,
            timeoutMs: 5000,
            signal: abort.signal,
          }
          return mode.startsWith('adapter-artifacts')
            ? runner.runArtifacts({ ...request, outputDirectory: output })
            : runner.runStdout(request)
        })()
      : (async () => {
          const bundle = createManifestInputArchiveBundle(input, {
            signal: abort.signal,
          })
          transfer = pipeline(bundle.stream, discard())
          void transfer.catch(() => {})
          return bundle.completion
        })()
    operation = work.then(
      value => {
        published = true
        settled = true
        return value
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    await entered.promise
    if (mode === 'producer-read' || mode?.startsWith('adapter-')) abort.abort()
    await delay(50)
    const before = { settled, published, closes }
    if (fixture) {
      assert.equal(fixture.ownedContainer && fixture.ownedVolume, true)
      assert.equal(fixture.events.includes('exec'), false)
      assert.equal(
        fixture.events.some(event => event.startsWith('remove-')),
        false
      )
    }
    held.resolve()
    const outcome = await operation
    await Promise.allSettled([transfer])
    assert.equal(
      before.settled,
      false,
      'manifest settled before real I/O owner'
    )
    assert.equal(before.published, false)
    assert.equal(
      before.closes,
      mode === 'producer-read' || mode?.startsWith('adapter-') ? 0 : 1
    )
    assert.equal(closes, 1)
    if (
      mode === 'producer-read' ||
      mode === 'producer-close-error' ||
      mode?.startsWith('adapter-')
    ) {
      assert.ok(outcome instanceof Error)
      assert.equal(published, false)
      if (mode === 'producer-close-error' || mode?.endsWith('-close-error'))
        assert.ok(contains(outcome, sentinel))
      if (fixture)
        assert.equal(fixture.ownedContainer || fixture.ownedVolume, false)
    } else {
      assert.equal(published, true)
      assert.ok(!(outcome instanceof Error))
    }
  } else {
    const bundle = createManifestInputArchiveBundle(input),
      transfer = pipeline(bundle.stream, discard())
    const manifest = await bundle.completion
    await transfer
    if (mode?.startsWith('write-') || mode === 'diagnostic-close-error') {
      Object.defineProperty(fs, 'open', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.open>) => {
          const file = await originalOpen(...args)
          if (
            args[0] ===
            path.join(
              output,
              mode === 'diagnostic-close-error' ? 'output.stdout' : 'generated'
            )
          ) {
            const write = file.write.bind(file),
              close = file.close.bind(file)
            Object.defineProperty(file, 'write', {
              value: async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null
              ) => {
                const result = await write(buffer, offset, length, position)
                entered.resolve()
                await held.promise
                return result
              },
            })
            file.close = async () => {
              closes++
              await close()
              if (
                mode === 'write-close-error' ||
                mode === 'diagnostic-close-error'
              )
                throw sentinel
            }
          }
          return file
        },
      })
      syncBuiltinESMExports()
    }
    if (mode === 'output-root-replaced') {
      let replaced = false
      Object.defineProperty(fs, 'rm', {
        configurable: true,
        value: async (...args: Parameters<typeof fs.rm>) => {
          const result = await originalRm(...args)
          if (
            !replaced &&
            typeof args[0] === 'string' &&
            path.basename(args[0]).startsWith('.compile-provisional-')
          ) {
            replaced = true
            await fs.rename(output, path.join(root, 'moved-output'))
            await fs.mkdir(output, { mode: 0o700 })
            await fs.writeFile(path.join(output, 'foreign'), 'preserved')
          }
          return result
        },
      })
      syncBuiltinESMExports()
    }
    if (mode === 'commit-error' || mode === 'cleanup-error') {
      Object.defineProperty(fs, 'link', {
        configurable: true,
        value: async () => {
          throw commitError
        },
      })
      if (mode === 'cleanup-error')
        Object.defineProperty(fs, 'rm', {
          configurable: true,
          value: async (...args: Parameters<typeof fs.rm>) => {
            if (
              typeof args[0] === 'string' &&
              path.basename(args[0]).startsWith('.compile-provisional-')
            )
              throw cleanupError
            return originalRm(...args)
          },
        })
      syncBuiltinESMExports()
    }
    const pack = tar.pack(),
      abort = new AbortController()
    operation = extractCompileOutputArchive(
      pack,
      output,
      manifest,
      mode === 'diagnostic-close-error'
        ? { stdout: Buffer.from('diagnostic') }
        : {},
      { signal: abort.signal }
    ).then(
      value => {
        settled = true
        return value
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )
    pack.entry({ name: 'compile/', type: 'directory' })
    if (mode === 'commit-error' || mode === 'cleanup-error')
      pack.entry({ name: 'compile/output.pdf' }, Buffer.from([0, 255, 11]))
    else if (mode === 'output-root-replaced') {
      pack.entry({ name: 'compile/output.pdf' }, Buffer.from([0, 255, 10]))
    } else if (mode === 'tar') {
      pack.entry({ name: 'compile/output.pdf' }, Buffer.from([0, 255, 10]))
      pack.entry({ name: 'compile/文/empty' }, Buffer.alloc(0))
      pack.entry({ name: 'compile/文/', type: 'directory' })
    } else pack.entry({ name: 'compile/generated' }, Buffer.alloc(2048, 7))
    pack.finalize()
    if (mode?.startsWith('write-') || mode === 'diagnostic-close-error') {
      await entered.promise
      abort.abort()
      await delay(50)
      const before = {
        settled,
        closes,
        exists: await fs.stat(output).then(
          () => true,
          () => false
        ),
      }
      held.resolve()
      const error = await operation
      assert.equal(before.settled, false)
      assert.equal(before.closes, 0)
      assert.equal(before.exists, true)
      assert.ok(error instanceof Error)
      assert.equal(closes, 1)
      if (mode === 'write-close-error' || mode === 'diagnostic-close-error')
        assert.ok(contains(error, sentinel))
      assert.deepEqual(await fs.readdir(root), ['in'])
    } else {
      const outcome = await operation
      if (mode === 'output-root-replaced') {
        assert.ok(outcome instanceof Error, 'foreign output root was accepted')
        assert.equal(
          await fs.readFile(path.join(output, 'foreign'), 'utf8'),
          'preserved'
        )
        assert.ok(await fs.stat(path.join(root, 'moved-output')))
      } else if (mode === 'tar') {
        assert.ok(!(outcome instanceof Error))
        assert.deepEqual(await fs.readdir(output), ['文'])
        assert.equal((await fs.stat(path.join(output, '文/empty'))).size, 0)
      } else {
        assert.ok(contains(outcome, commitError))
        if (mode === 'cleanup-error') {
          assert.ok(contains(outcome, cleanupError))
          assert.ok(outcome instanceof AggregateError)
        } else assert.deepEqual(await fs.readdir(root), ['in'])
      }
    }
  }
  console.log(`${mode} native composition PASS`)
} finally {
  held.resolve()
  await operation
  Object.defineProperty(fs, 'open', { configurable: true, value: originalOpen })
  Object.defineProperty(fs, 'link', { configurable: true, value: originalLink })
  Object.defineProperty(fs, 'rm', { configurable: true, value: originalRm })
  syncBuiltinESMExports()
  await fixture?.close()
  await fs.rm(root, { recursive: true, force: true })
}
