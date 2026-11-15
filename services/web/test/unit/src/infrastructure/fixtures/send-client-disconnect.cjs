// @ts-check
'use strict'
const assertThat = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { once, EventEmitter } = require('node:events')
const { pipeline } = require('node:stream')
const streams = require('node:stream')

/** @typedef {import('node:http').ServerResponse} Response */
/** @typedef {import('node:fs').ReadStream} ReadStream */
/** @typedef {Error & {code?: string}} CodedError */
/** @typedef {EventEmitter & {pipe(response: Response): Response}} SendStream */
/** @typedef {(request: import('node:http').IncomingMessage, file: string, options: {root: string}) => SendStream} Send */
const expressRequire = createRequire(require.resolve('express'))
const send = /** @type {Send} */ (expressRequire('send'))
const scenario = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'send-disconnect-'))
const filename = path.join(directory, 'fixture.txt')
const content = Buffer.alloc(512 * 1024, 65)
fs.writeFileSync(filename, content, { mode: 0o600 })
process.once('exit', () =>
  fs.rmSync(directory, { recursive: true, force: true })
)

process.on('uncaughtExceptionMonitor', error => {
  const code = /** @type {CodedError} */ (error).code
  process.stdout.write(
    `UNCAUGHT:${code === 'ERR_STREAM_UNABLE_TO_PIPE' || code === 'EIO' ? code : 'OTHER'}\n`
  )
})

/** @type {ReadStream[]} */
const opened = []
/** @type {string[]} */
const sendErrors = []
/** @type {Response | undefined} */
let response
/** @type {import('node:http').ClientRequest | undefined} */
let client
const events = new EventEmitter()
const originalStat = fs.stat

if (scenario === 'disconnect-before-stat') {
  /** @type {(file: import('node:fs').PathLike, callback: (error: NodeJS.ErrnoException | null, stat: import('node:fs').Stats) => void) => void} */
  const delayedStat = (file, callback) => {
    originalStat(file, (error, stat) => {
      if (file !== filename) return callback(error, stat)
      assertThat.ok(response)
      response.once('close', () => {
        assertThat.equal(response?.destroyed, true)
        callback(error, stat)
      })
      assertThat.ok(client)
      client.destroy()
    })
  }
  // Narrow only this actual file's stat callback to make the disconnect race
  // deterministic. All filesystem I/O and HTTP socket cancellation stay real.
  fs.stat = /** @type {typeof fs.stat} */ (delayedStat)
}

if (scenario === 'pipeline-unexpected-error') {
  streams.pipeline = new Proxy(pipeline, {
    apply() {
      throw Object.assign(new Error('synthetic pipeline failure'), {
        code: 'EIO',
      })
    },
  })
}

const server = http.createServer((request, res) => {
  response = res
  const transfer = send(request, '/fixture.txt', { root: directory })
  transfer.on(
    'error',
    /** @param {CodedError} error */ error => {
      sendErrors.push(error.code ?? 'OTHER')
      res.destroy()
    }
  )
  transfer.on(
    'stream',
    /** @param {ReadStream} stream */ stream => {
      opened.push(stream)
      stream.once('close', () => events.emit('stream-closed'))
      if (scenario === 'disconnect-at-stream') res.destroy()
      if (scenario === 'read-error') fs.unlinkSync(filename)
    }
  )
  transfer.pipe(res)
})

async function exerciseTransfer() {
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  )
  const address = server.address()
  assertThat.ok(address && typeof address !== 'string')
  /** @type {Buffer[]} */
  const received = []
  const clientFinished = new Promise(resolve => {
    client = http.get(
      { host: '127.0.0.1', port: address.port, path: '/fixture.txt' },
      res => {
        res.on(
          'data',
          /** @param {Buffer} chunk */ chunk => {
            received.push(chunk)
            if (scenario === 'disconnect-after-start') {
              assertThat.ok(client)
              client.destroy()
            }
          }
        )
        res.once('end', () => resolve(undefined))
        res.once('close', () => resolve(undefined))
      }
    )
    client.on(
      'error',
      /** @param {CodedError} error */ error => {
        assertThat.equal(error.code, 'ECONNRESET')
        resolve(undefined)
      }
    )
  })
  await clientFinished
  // Wait for actual descriptor closure, including a stream whose open() was
  // pending when destroy() ran. A missing cleanup fails under the outer bound.
  while (opened.length === 0 || opened.some(stream => !stream.closed)) {
    await once(events, 'stream-closed')
  }
  assertThat.equal(opened.length, 1)
  assertThat.equal(opened[0]?.destroyed, true)
  if (scenario === 'normal') {
    assertThat.deepEqual(Buffer.concat(received), content)
    assertThat.deepEqual(sendErrors, [])
  } else if (scenario === 'read-error') {
    assertThat.deepEqual(sendErrors, ['ENOENT'])
  } else if (scenario === 'disconnect-after-start') {
    assertThat.ok(Buffer.concat(received).length > 0)
    assertThat.deepEqual(sendErrors, ['ERR_STREAM_PREMATURE_CLOSE'])
  } else {
    assertThat.deepEqual(sendErrors, [])
  }
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve(undefined)))
  )
  process.stdout.write('PASS\n')
}

// Bound failures without forcing a successful process exit: leftover sockets,
// streams, errors or rejected promises must still fail the isolated child.
const timeout = setTimeout(() => {
  process.stdout.write('TIMEOUT\n')
  server.closeAllConnections()
  server.close()
  process.exitCode = 1
}, 3000)
exerciseTransfer()
  .catch(() => {
    process.stdout.write('FAIL\n')
    process.exitCode = 1
    server.closeAllConnections()
    server.close()
  })
  .finally(() => {
    clearTimeout(timeout)
    fs.stat = originalStat
    streams.pipeline = pipeline
    fs.rmSync(directory, { recursive: true, force: true })
  })
