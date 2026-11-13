// @ts-check
const nodeAssert = require('node:assert/strict')
const nodeCrypto = require('node:crypto')
const http = require('node:http')
const { createRequire } = require('node:module')
const zlib = require('node:zlib')

const expressRequire = createRequire(require.resolve('express'))
/** @type {{ json: (options?: {verify?: () => void}) => HttpMiddleware }} */
const bodyParser = expressRequire('body-parser')
/** @type {(req: import('node:http').IncomingMessage, done: () => void) => void} */
const onFinished = createRequire(expressRequire.resolve('body-parser'))(
  'on-finished'
)

/**
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: Error & {status?: number}) => void) => void} HttpMiddleware
 * @typedef {{ status: number | undefined, body: string, headers: import('node:http').IncomingHttpHeaders }} SyntheticResponse
 * @typedef {{ name: string, value: string, filename?: string, file?: boolean }} MultipartPart
 */

/**
 * @param {number} port
 * @param {import('node:http').OutgoingHttpHeaders} headers
 * @param {string | Buffer} body
 * @returns {Promise<SyntheticResponse>}
 */
function request(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', agent: false, headers },
      res => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.setTimeout(1500, () =>
      req.destroy(new Error('synthetic request timeout'))
    )
    req.end(body)
  })
}

/**
 * @template T
 * @param {import('node:http').RequestListener} handler
 * @param {(port: number) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    const address = server.address()
    nodeAssert.ok(address && typeof address !== 'string')
    return await run(address.port)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
}

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** @param {MultipartPart[]} parts */
function multipart(parts) {
  const boundary = 'lope-synthetic-dependency-test'
  const body =
    parts
      .map(
        part =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.file ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n${part.value}\r\n`
      )
      .join('') + `--${boundary}--\r\n`
  return {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  }
}

/** @param {string} scenario */
async function multerScenario(scenario) {
  process.env.REQ_LOCKDOWN_MODE = 'throw'
  const express = require('express')
  const multer = require('multer')
  // Multer 2.5 implements this limit; @types/multer 2.1 predates it.
  /** @type {import('multer').Options & { limits: NonNullable<import('multer').Options['limits']> & { fieldArrayIndexLimit: number } }} */
  const options = {
    storage: multer.memoryStorage(),
    limits: { fieldArrayIndexLimit: 100, fileSize: 1024, parts: 8 },
  }
  if (scenario === 'multer-late-filter') {
    options.fileFilter = (req, file, cb) => {
      if (file.fieldname === 'reject')
        return cb(new Error('synthetic filter rejection'))
      setTimeout(() => cb(null, true), 30)
    }
  }
  const upload = multer(options).any()
  const app = express()
  app.use((req, res) =>
    upload(req, res, (/** @type {unknown} */ err) => {
      if (err) {
        const code =
          err instanceof Error && 'code' in err && typeof err.code === 'string'
            ? err.code
            : 'FILTER_ERROR'
        return res.status(400).json({ code })
      }
      /** @type {{ metadata?: string } | undefined} */
      const body = Reflect.get(req, Symbol.for('overleaf.lockdown.rawBody'))
      nodeAssert.ok(Array.isArray(req.files))
      res.json({
        value: body?.metadata,
        files: req.files.map(file => ({
          name: file.originalname,
          value: file.buffer.toString(),
        })),
      })
    })
  )
  await withServer(app, async port => {
    /** @type {MultipartPart[]} */
    let parts
    if (scenario === 'multer-array-index')
      parts = [
        { name: 'items[4294967294]', value: 'x' },
        { name: 'items[x]', value: 'y' },
      ]
    else if (scenario === 'multer-late-filter')
      parts = [
        { name: 'pending', filename: 'pending.txt', file: true, value: 'x' },
        { name: 'reject', filename: 'reject.txt', file: true, value: 'y' },
      ]
    else
      parts = [
        { name: 'metadata', value: 'synthetic' },
        { name: 'qqfile', file: true, value: 'synthetic-source' },
      ]
    const { headers, body } = multipart(parts)
    const response = await request(port, headers, body)
    const parsed = JSON.parse(response.body)
    if (scenario === 'multer-array-index') {
      nodeAssert.equal(response.status, 400)
      nodeAssert.equal(parsed.code, 'LIMIT_FIELD_ARRAY_INDEX')
    } else if (scenario === 'multer-late-filter') {
      nodeAssert.equal(response.status, 400)
      await delay(100)
    } else {
      nodeAssert.equal(response.status, 200)
      nodeAssert.equal(parsed.value, 'synthetic')
      nodeAssert.deepEqual(parsed.files, [
        { name: 'undefined', value: 'synthetic-source' },
      ])
      const named = multipart([
        { name: 'metadata', value: 'synthetic' },
        {
          name: 'qqfile',
          filename: 'normal.txt',
          file: true,
          value: 'normal-source',
        },
      ])
      const namedResponse = await request(port, named.headers, named.body)
      nodeAssert.equal(namedResponse.status, 200)
      nodeAssert.deepEqual(JSON.parse(namedResponse.body).files, [
        { name: 'normal.txt', value: 'normal-source' },
      ])
    }
  })
}

/** @param {string} scenario */
async function bodyScenario(scenario) {
  const delayed = ['body-delayed-deflate', 'body-second-consumer'].includes(
    scenario
  )
  const encoding =
    scenario === 'body-valid-identity'
      ? 'identity'
      : scenario === 'body-valid-deflate' || delayed
        ? 'deflate'
        : 'gzip'
  const source = Buffer.from('{"a":1}')
  const encoded =
    encoding === 'identity'
      ? source
      : encoding === 'gzip'
        ? zlib.gzipSync(source)
        : zlib.deflateSync(source)
  const first = delayed ? Buffer.concat([encoded, Buffer.from([0])]) : encoded
  const trailing = delayed
    ? Buffer.alloc(1024)
    : scenario.startsWith('body-valid-')
      ? Buffer.alloc(0)
      : Buffer.concat([Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)])
  const expectedHash = nodeCrypto
    .createHash('sha256')
    .update(first)
    .update(trailing)
    .digest('hex')
  const parser = bodyParser.json(
    scenario === 'body-unsupported-charset' ? { verify() {} } : {}
  )
  /** @type {import('node:http').ClientRequest | undefined} */
  let client
  await withServer(
    (req, res) => {
      /** @type {import('node:crypto').Hash | undefined} */
      let hash
      if (scenario === 'body-second-consumer') {
        hash = nodeCrypto.createHash('sha256')
        req.pipe(hash)
      }
      parser(req, res, err => {
        if (err) {
          res.writeHead(err.status || 500)
          res.end()
          return
        }
        const respond = () => res.end(JSON.stringify(Reflect.get(req, 'body')))
        if (scenario === 'body-second-consumer') {
          nodeAssert.ok(hash)
          const bodyHash = hash
          bodyHash.once('finish', () => {
            res.setHeader('X-Body-SHA256', bodyHash.read().toString('hex'))
            respond()
          })
        } else if (delayed) onFinished(req, respond)
        else respond()
        if (delayed) {
          nodeAssert.ok(client)
          client.end(trailing)
        }
      })
    },
    async port => {
      const headers = {
        'Content-Type':
          scenario === 'body-unsupported-charset'
            ? 'application/json; charset=utf-999'
            : 'application/json',
        'Content-Encoding': encoding,
        'Content-Length': first.length + trailing.length,
      }
      const response = delayed
        ? await /** @type {Promise<SyntheticResponse>} */ (
            new Promise((resolve, reject) => {
              client = http.request(
                {
                  host: '127.0.0.1',
                  port,
                  method: 'POST',
                  agent: false,
                  headers,
                },
                res => {
                  /** @type {Buffer[]} */
                  const chunks = []
                  res.on('data', chunk => chunks.push(chunk))
                  res.on('end', () =>
                    resolve({
                      status: res.statusCode,
                      body: Buffer.concat(chunks).toString(),
                      headers: res.headers,
                    })
                  )
                  res.on('error', reject)
                }
              )
              client.on('error', reject)
              client.setTimeout(1500, () =>
                client?.destroy(new Error('delayed body timeout'))
              )
              client.write(first)
            })
          )
        : await request(port, headers, Buffer.concat([first, trailing]))
      await delay(250)
      nodeAssert.equal(
        response.status,
        scenario === 'body-unsupported-charset' ? 415 : 200
      )
      if (scenario !== 'body-unsupported-charset')
        nodeAssert.equal(response.body, '{"a":1}')
      if (scenario === 'body-second-consumer')
        nodeAssert.equal(response.headers['x-body-sha256'], expectedHash)
    }
  )
}

function proxyScenario() {
  /** @type {{compile: (subnet: string) => ((address: string, index: number) => boolean)}} */
  const proxyaddr = expressRequire('proxy-addr')
  const malformed = proxyaddr.compile('::ffff:10.0.0.0/8')
  nodeAssert.equal(malformed('203.0.113.10', 0), false)
  nodeAssert.equal(malformed('::ffff:203.0.113.10', 0), false)
  nodeAssert.equal(proxyaddr.compile('::/1')('203.0.113.10', 0), false)
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet)
    nodeAssert.equal(trust('10.1.2.3', 0), true)
    nodeAssert.equal(trust('203.0.113.10', 0), false)
  }
  nodeAssert.equal(proxyaddr.compile('loopback')('127.0.0.1', 0), true)
}

/** @param {string} scenario */
async function mongooseScenario(scenario) {
  const mongoose = require('mongoose')
  const schema = new mongoose.Schema({
    meta: {},
    value: mongoose.Schema.Types.Mixed,
  })
  if (scenario === 'mongoose-inherited-properties') {
    const Model = mongoose.model('DependencyRegression', schema)
    try {
      new Model(JSON.parse('{"meta.toString.call":1}'))
    } catch {
      /* rejection is safe */
    }
    nodeAssert.equal(typeof Object.prototype.toString.call, 'function')
    try {
      Model.hydrate(JSON.parse('{"toString":{"call":1}}'))
    } catch {
      // Rejecting the stored document is safe if shared prototypes stay intact.
    }
    nodeAssert.equal(typeof Object.prototype.toString.call, 'function')
  } else {
    const connection = mongoose.createConnection()
    connection.config.sanitizeFilter = true
    const Model = connection.model('DependencyRegression', schema)
    /** @type {Record<string, unknown> | undefined} */
    let observed
    // Stub the driver's collection call without inventing a partial cursor type.
    const sinon = require('sinon')
    const cursor = sinon.createStubInstance(mongoose.mongo.FindCursor)
    cursor.toArray.resolves([])
    const find = sinon.stub(Model.collection, 'find').callsFake(filter => {
      observed = filter
      return cursor
    })
    await Model.find({ value: { $ne: null } }).exec()
    nodeAssert.deepEqual(observed, { value: { $eq: { $ne: null } } })
    find.restore()
    await connection.destroy()
  }
}

async function compressionScenario() {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip')
  nodeAssert.ok(descriptor && typeof descriptor.value === 'function')
  /** @type {typeof zlib.createGzip} */
  const createGzip = descriptor.value
  let compressorClosed = false
  Object.defineProperty(zlib, 'createGzip', {
    ...descriptor,
    /** @param {import('node:zlib').ZlibOptions} [options] */
    value(options) {
      const stream = createGzip(options)
      stream.once('close', () => {
        compressorClosed = true
      })
      return stream
    },
  })
  const metricsRequire = createRequire(require.resolve('@overleaf/metrics'))
  /** @type {HttpMiddleware} */
  const compression = metricsRequire('compression')({ threshold: 0 })
  try {
    await withServer(
      (req, res) =>
        compression(req, res, () => {
          res.setHeader('Content-Type', 'text/plain')
          res.write(Buffer.alloc(32 * 1024, 0x58))
          /** @type {unknown} */
          const flush = Reflect.get(res, 'flush')
          nodeAssert.ok(typeof flush === 'function')
          flush.call(res)
        }),
      async port => {
        await new Promise((resolve, reject) => {
          const req = http.get(
            {
              host: '127.0.0.1',
              port,
              agent: false,
              headers: { 'Accept-Encoding': 'gzip' },
            },
            res => {
              res.once('data', () => {
                res.destroy()
                resolve(undefined)
              })
              res.on('error', () => {})
            }
          )
          req.on('error', reject)
          req.setTimeout(1500, () =>
            req.destroy(new Error('compression timeout'))
          )
        })
        await delay(100)
        nodeAssert.equal(compressorClosed, true)
      }
    )
  } finally {
    Object.defineProperty(zlib, 'createGzip', descriptor)
  }
}

async function main() {
  const scenario = process.argv[2]
  nodeAssert.ok(scenario, 'scenario is required')
  if (scenario.startsWith('body-')) await bodyScenario(scenario)
  else if (scenario.startsWith('multer-')) await multerScenario(scenario)
  else if (scenario.startsWith('mongoose-')) await mongooseScenario(scenario)
  else if (scenario === 'proxy-trust') proxyScenario()
  else if (scenario === 'compression-abort') await compressionScenario()
  else throw new Error('unknown dependency regression')
  console.log('PASS')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
