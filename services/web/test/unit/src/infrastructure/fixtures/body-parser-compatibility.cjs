// @ts-check
const nodeAssert = require('node:assert/strict')
const nodeCrypto = require('node:crypto')
const http = require('node:http')
const { once } = require('node:events')
const { createRequire } = require('node:module')
const zlib = require('node:zlib')

process.env.REQ_LOCKDOWN_MODE = 'throw'
const express = require('express')
const expressRequire = createRequire(require.resolve('express'))
/**
 * @typedef {'json' | 'raw' | 'text' | 'urlencoded'} Format
 * @typedef {{ limit?: string | number | null, extended?: boolean, verify?: () => void }} ParserOptions
 * @typedef {{ status: number | undefined, body: string, headers: import('node:http').IncomingHttpHeaders }} Response
 * @typedef {Record<Format, (options?: ParserOptions) => import('express').RequestHandler>} BodyParser
 */
/** @type {BodyParser} */
const bodyParser = expressRequire('body-parser')
const rawBody = Symbol.for('overleaf.lockdown.rawBody')
const lockdown = Symbol.for('overleaf.lockdown.installed')

/** @param {number} port @param {string} contentType @param {string} encoding @param {Buffer} body @param {string} [requestPath] @returns {Promise<Response>} */
function request(port, contentType, encoding, body, requestPath = '/') {
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: requestPath,
        agent: false,
        headers: {
          'Content-Type': contentType,
          'Content-Encoding': encoding,
          'Content-Length': body.length,
        },
      },
      res => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          })
        )
      }
    )
    client.on('error', reject)
    client.setTimeout(1800, () =>
      client.destroy(new Error('synthetic parser request timeout'))
    )
    client.end(body)
  })
}

/** @param {Format} format @param {boolean} large */
function input(format, large = false) {
  if (format === 'json')
    return {
      type: 'application/json',
      source: JSON.stringify({
        value: large ? 'x'.repeat(102400) : 'synthetic',
      }),
      expected: { value: 'synthetic' },
    }
  if (format === 'urlencoded')
    return {
      type: 'application/x-www-form-urlencoded',
      source: `value=${large ? 'x'.repeat(102400) : 'synthetic'}`,
      expected: { value: 'synthetic' },
    }
  const text = large ? 'x'.repeat(102401) : 'synthetic café'
  return {
    type:
      format === 'raw'
        ? 'application/octet-stream'
        : 'text/plain; charset=utf-8',
    source: text,
    expected: format === 'raw' ? Buffer.from(text).toString('base64') : text,
  }
}

/** @param {string} scenario */
async function main(scenario) {
  /** @type {Format[]} */
  const formats = ['json', 'raw', 'text', 'urlencoded']
  const format =
    scenario === 'lockdown-query'
      ? 'json'
      : formats.find(value => scenario.split('-').includes(value))
  nodeAssert.ok(format)
  if (scenario.startsWith('invalid-limit-')) {
    for (const limit of ['not-a-size', NaN, '']) {
      nodeAssert.throws(() => bodyParser[format]({ extended: true, limit }), {
        name: 'TypeError',
        message: /option limit .* is invalid/,
      })
    }
    console.log('PASS')
    return
  }
  const limited = scenario.startsWith('wire-limit-')
  const defaultLimited = scenario.startsWith('default-limit-')
  const trailing = scenario.endsWith('-trailing')
  const hashing = scenario.endsWith('-hash') || trailing
  const charset = scenario.endsWith('-charset')
  const array = scenario.endsWith('-array')
  /** @type {ParserOptions} */
  const options = { extended: true }
  if (limited) options.limit = 4
  if (defaultLimited)
    options.limit = scenario.endsWith('-null') ? null : undefined
  if (charset) options.verify = () => {}
  const sample = input(format, defaultLimited)
  if (array)
    sample.source = Array.from(
      { length: 105 },
      (_, i) => `items[${i}]=${i}`
    ).join('&')
  const encoding = scenario.includes('-gzip')
    ? 'gzip'
    : scenario.includes('-deflate')
      ? 'deflate'
      : 'identity'
  const source = Buffer.from(sample.source)
  const encoded =
    encoding === 'gzip'
      ? zlib.gzipSync(source)
      : encoding === 'deflate'
        ? zlib.deflateSync(source)
        : source
  const wire = trailing
    ? Buffer.concat([encoded, Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)])
    : encoded
  const expectedHash = nodeCrypto
    .createHash('sha256')
    .update(wire)
    .digest('hex')
  const parser = bodyParser[format](options)
  const app = express()
  app.set('query parser', 'extended')
  app.use((req, res) => {
    const hash = hashing ? nodeCrypto.createHash('sha256') : undefined
    const finishedHash = hash ? once(hash, 'finish') : Promise.resolve()
    if (hash) req.pipe(hash)
    parser(req, res, error => {
      if (error) {
        const status =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number'
            ? error.status
            : 500
        res.status(status).end()
        return
      }
      finishedHash
        .then(() => {
          nodeAssert.equal(Reflect.get(req, lockdown), true)
          if (scenario === 'lockdown-query') {
            nodeAssert.throws(
              () => Reflect.get(req, 'query'),
              /raw request input is forbidden/
            )
            nodeAssert.deepEqual(
              Reflect.get(req, Symbol.for('overleaf.lockdown.rawQuery')),
              { filter: { status: 'ready' }, items: ['a', 'b'] }
            )
          }
          nodeAssert.throws(
            () => Reflect.get(req, 'body'),
            /raw request input is forbidden/
          )
          /** @type {unknown} */
          const parsed = Reflect.get(req, rawBody)
          if (hash) res.setHeader('X-Body-SHA256', hash.read().toString('hex'))
          res.json(Buffer.isBuffer(parsed) ? parsed.toString('base64') : parsed)
        })
        .catch(error => {
          res.status(500).end()
        })
    })
  })
  // Contextual Express handler types do not require app-only Request extensions.
  /** @type {import('express').ErrorRequestHandler} */
  const errorHandler = (error, req, res, next) => {
    res.status(500).end()
  }
  app.use(errorHandler)
  const server = http.createServer(app)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    nodeAssert.ok(address && typeof address !== 'string')
    const response = await request(
      address.port,
      charset ? 'text/plain; charset=utf-999' : sample.type,
      encoding,
      wire,
      scenario === 'lockdown-query'
        ? '/?filter%5Bstatus%5D=ready&items%5B0%5D=a&items%5B1%5D=b'
        : '/'
    )
    nodeAssert.equal(
      response.status,
      limited || defaultLimited ? 413 : charset ? 415 : 200
    )
    if (!limited && !defaultLimited && !charset) {
      const parsed = JSON.parse(response.body)
      if (array)
        nodeAssert.deepEqual(parsed, {
          items: Array.from({ length: 105 }, (_, i) => String(i)),
        })
      else nodeAssert.deepEqual(parsed, sample.expected)
      if (hashing)
        nodeAssert.equal(response.headers['x-body-sha256'], expectedHash)
    }
    await new Promise(resolve => setTimeout(resolve, 75))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
  console.log('PASS')
}

const scenario = process.argv[2]
nodeAssert.ok(scenario)
main(scenario).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
