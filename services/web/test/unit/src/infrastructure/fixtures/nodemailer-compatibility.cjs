// @ts-check
const nodeAssert = require('node:assert/strict')
const nodeCrypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { spawnSync } = require('node:child_process')
const { pathToFileURL, domainToASCII } = require('node:url')
const nodemailer = require('nodemailer')

/**
 * @typedef {{ authenticated: boolean, sender: string, recipients: string[], message: string, delivered: number, smtpUtf8: boolean }} SmtpState
 * @typedef {{ password?: string, rejectAuth?: boolean, rejectRecipient?: boolean, abortData?: boolean, noGreeting?: boolean, secure?: boolean }} FixtureOptions
 * @typedef {{ port: number, state: SmtpState, password: string, certificate?: Buffer }} SmtpFixture
 */

/** Test-only protocol peer, never production SMTP implementation.
 * @template T
 * @param {FixtureOptions} options
 * @param {(fixture: SmtpFixture) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSmtp(options, run) {
  const password = options.password || nodeCrypto.randomUUID()
  /** @type {SmtpState} */
  const state = {
    authenticated: false,
    sender: '',
    recipients: [],
    message: '',
    delivered: 0,
    smtpUtf8: false,
  }
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  let directory
  /** @type {Buffer | undefined} */
  let certificate
  /** @type {import('node:tls').TlsOptions | undefined} */
  let tlsOptions
  /** @param {import('node:net').Socket} socket */
  const connected = socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    if (!options.noGreeting) socket.write('220 fixture.invalid ESMTP\r\n')
    let buffer = ''
    let data = false
    socket.on('data', chunk => {
      buffer += chunk.toString()
      for (;;) {
        if (data) {
          if (options.abortData && buffer.length) {
            socket.destroy()
            return
          }
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          state.message = buffer.slice(0, end + 2).replace(/^\.\./gm, '.')
          state.delivered++
          buffer = buffer.slice(end + 5)
          data = false
          socket.write('250 2.0.0 synthetic message accepted\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (/^(EHLO|HELO) /i.test(line))
          socket.write(
            '250-fixture.invalid\r\n250-AUTH PLAIN\r\n250-SMTPUTF8\r\n250-8BITMIME\r\n250 SIZE 1048576\r\n'
          )
        else if (/^AUTH PLAIN /i.test(line)) {
          const parts = Buffer.from(line.slice(11), 'base64')
            .toString('utf8')
            .split('\0')
          state.authenticated =
            !options.rejectAuth &&
            parts[1] === 'fixture' &&
            parts[2] === password
          socket.write(
            state.authenticated
              ? '235 2.7.0 fixture authenticated\r\n'
              : '535 5.7.8 fixture authentication rejected\r\n'
          )
        } else if (/^MAIL FROM:/i.test(line)) {
          if (!state.authenticated)
            socket.write('530 authentication required\r\n')
          else {
            state.smtpUtf8 = / SMTPUTF8(?: |$)/i.test(line)
            state.sender = line.slice(10).split('>')[0].replace(/^</, '')
            socket.write('250 2.1.0 sender accepted\r\n')
          }
        } else if (/^RCPT TO:/i.test(line)) {
          if (options.rejectRecipient)
            socket.write('550 5.1.1 synthetic recipient rejected\r\n')
          else {
            state.recipients.push(line.slice(8).split('>')[0].replace(/^</, ''))
            socket.write('250 2.1.5 recipient accepted\r\n')
          }
        } else if (/^DATA$/i.test(line)) {
          data = true
          socket.write('354 end with dot\r\n')
        } else if (/^QUIT$/i.test(line)) {
          socket.end('221 2.0.0 bye\r\n')
          return
        } else if (/^(RSET|NOOP)$/i.test(line)) socket.write('250 2.0.0 OK\r\n')
        else socket.write('500 unknown fixture command\r\n')
      }
    })
  }
  /** @type {import('node:net').Server | undefined} */
  let server
  try {
    if (options.secure) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lope-mail-tls-'))
      fs.chmodSync(directory, 0o700)
      const key = path.join(directory, 'key.pem')
      const cert = path.join(directory, 'cert.pem')
      const created = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { timeout: 5000, stdio: 'ignore' }
      )
      nodeAssert.equal(
        created.status,
        0,
        'ephemeral TLS fixture certificate generation failed'
      )
      certificate = fs.readFileSync(cert)
      tlsOptions = {
        key: fs.readFileSync(key),
        cert: certificate,
        minVersion: 'TLSv1.2',
      }
    }
    server = tlsOptions
      ? tls.createServer(tlsOptions, connected)
      : net.createServer(connected)
    server.on('tlsClientError', () => {})
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    nodeAssert.ok(address && typeof address !== 'string')
    return await run({
      port: address.port,
      state,
      password,
      ...(certificate ? { certificate } : {}),
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server) {
      const started = server
      await new Promise(resolve => started.close(() => resolve(undefined)))
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** @returns {import('nodemailer').SendMailOptions} */
function message() {
  return {
    from: 'Jöhn Dœ <sender@bücher.example>',
    to: 'Recipient <recipient@example.invalid>',
    cc: 'Copy <copy@example.invalid>',
    replyTo: 'Reply <reply@example.invalid>',
    subject: 'Synthetic café message',
    text: 'synthetic café text',
    html: '<b>synthetic café HTML</b>',
    textEncoding: 'quoted-printable',
    headers: { 'X-SMTPAPI': JSON.stringify({ category: 'fixture-category' }) },
  }
}

/** Decode only fixture-generated RFC2047 words; this helper is not application parsing code.
 * @param {string} value
 */
function decodeFixtureWords(value) {
  return value
    .replace(/(\?=)\s+(=\?UTF-8\?)/gi, '$1$2')
    .replace(
      /=\?UTF-8\?([BQ])\?([^?]*)\?=/gi,
      (
        /** @type {string} */ word,
        /** @type {string} */ kind,
        /** @type {string} */ data
      ) => {
        if (kind.toUpperCase() === 'B')
          return Buffer.from(data, 'base64').toString('utf8')
        const bytes = data
          .replace(/_/g, ' ')
          .replace(
            /=([0-9A-F]{2})/gi,
            (/** @type {string} */ pair, /** @type {string} */ hex) =>
              String.fromCharCode(parseInt(hex, 16))
          )
        return Buffer.from(bytes, 'binary').toString('utf8')
      }
    )
}

/** @param {string} raw */
function assertMessage(raw) {
  const header = decodeFixtureWords(
    raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ')
  )
  nodeAssert.match(header, /^From: Jöhn Dœ <sender@xn--bcher-kva\.example>/im)
  nodeAssert.match(header, /^To: Recipient <recipient@example\.invalid>/im)
  nodeAssert.match(header, /^Cc: Copy <copy@example\.invalid>/im)
  nodeAssert.match(header, /^Reply-To: Reply <reply@example\.invalid>/im)
  nodeAssert.match(header, /^Subject: Synthetic café message$/im)
  const category = header.match(/^X-SMTPAPI: (.*)$/im)?.[1]
  nodeAssert.ok(category)
  nodeAssert.deepEqual(JSON.parse(category), { category: 'fixture-category' })
  nodeAssert.match(header, /^MIME-Version: 1\.0/im)
  nodeAssert.match(raw, /multipart\/alternative/i)
  nodeAssert.match(raw, /text\/plain; charset=utf-8/i)
  nodeAssert.match(raw, /text\/html; charset=utf-8/i)
  nodeAssert.match(raw, /caf=C3=A9/)
}

/** @param {SmtpFixture} fixture @param {boolean} secure */
function transportOptions(fixture, secure = false) {
  return {
    host: '127.0.0.1',
    port: fixture.port,
    secure,
    ignoreTLS: !secure,
    name: 'fixture.invalid',
    auth: { user: 'fixture', pass: fixture.password },
    logger: false,
    debug: false,
    connectionTimeout: 700,
    greetingTimeout: 500,
    socketTimeout: 900,
    ...(fixture.certificate
      ? { tls: { ca: fixture.certificate, servername: 'localhost' } }
      : {}),
  }
}

/** @param {string} scenario */
async function runScenario(scenario) {
  if (scenario.startsWith('smtp-')) {
    const secure = scenario.includes('-tls-')
    await withSmtp(
      {
        secure,
        rejectAuth: scenario === 'smtp-auth-rejection',
        rejectRecipient: scenario === 'smtp-recipient-rejection',
        abortData: scenario === 'smtp-abort',
        noGreeting: scenario === 'smtp-timeout',
      },
      async fixture => {
        /** @type {import('nodemailer').SMTPTransportOptions} */
        const options = transportOptions(fixture, secure)
        /** @type {unknown[][]} */
        const logs = []
        if (scenario === 'smtp-logger-redaction') {
          /** @param {...unknown} values */
          const capture = (...values) => {
            logs.push(values)
          }
          options.logger = Object.fromEntries(
            ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log'].map(
              level => [level, capture]
            )
          )
          options.debug = true
        }
        if (scenario === 'smtp-tls-rejected') delete options.tls
        const transport = nodemailer.createTransport(options)
        try {
          if (
            [
              'smtp-auth-rejection',
              'smtp-recipient-rejection',
              'smtp-abort',
              'smtp-timeout',
              'smtp-tls-rejected',
            ].includes(scenario)
          ) {
            await nodeAssert.rejects(transport.sendMail(message()), error => {
              if (!(error instanceof Error)) return false
              const code = 'code' in error ? error.code : undefined
              if (scenario === 'smtp-auth-rejection')
                return (
                  code === 'EAUTH' &&
                  'responseCode' in error &&
                  error.responseCode === 535
                )
              if (scenario === 'smtp-recipient-rejection')
                return (
                  code === 'EENVELOPE' &&
                  'responseCode' in error &&
                  error.responseCode === 550
                )
              if (scenario === 'smtp-tls-rejected')
                return /self-signed certificate|certificate chain/i.test(
                  error.message
                )
              if (scenario === 'smtp-timeout') return code === 'ETIMEDOUT'
              return code === 'ECONNECTION' || code === 'ESOCKET'
            })
            nodeAssert.equal(fixture.state.delivered, 0)
          } else {
            const mail = message()
            if (scenario === 'smtp-utf8')
              mail.to = 'International <δοκιμή@bücher.example>'
            const result = await transport.sendMail(mail)
            nodeAssert.equal(fixture.state.authenticated, true)
            nodeAssert.equal(fixture.state.delivered, 1)
            nodeAssert.equal(
              fixture.state.sender,
              'sender@xn--bcher-kva.example'
            )
            if (scenario === 'smtp-utf8') {
              const recipients = fixture.state.recipients.map(address => {
                const at = address.lastIndexOf('@')
                return (
                  address.slice(0, at + 1) +
                  domainToASCII(address.slice(at + 1))
                )
              })
              nodeAssert.deepEqual(recipients.sort(), [
                'copy@example.invalid',
                'δοκιμή@xn--bcher-kva.example',
              ])
              nodeAssert.equal(fixture.state.smtpUtf8, true)
              nodeAssert.match(fixture.state.message, /δοκιμή@/)
            } else
              nodeAssert.deepEqual([...fixture.state.recipients].sort(), [
                'copy@example.invalid',
                'recipient@example.invalid',
              ])
            nodeAssert.equal(result.accepted.length, 2)
            if (scenario !== 'smtp-utf8') assertMessage(fixture.state.message)
            if (scenario === 'smtp-logger-redaction') {
              const rendered = JSON.stringify(logs)
              nodeAssert.equal(rendered.includes(fixture.password), false)
              nodeAssert.equal(
                rendered.includes(
                  Buffer.from(`\0fixture\0${fixture.password}`).toString(
                    'base64'
                  )
                ),
                false
              )
            }
          }
        } finally {
          transport.close()
        }
      }
    )
  } else if (scenario === 'stream-message' || scenario === 'esm-default') {
    let mailer = nodemailer
    if (scenario === 'esm-default') {
      const filename = require.resolve('nodemailer/package.json')
      const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'))
      const entry = pkg.exports?.['.']?.import
        ? path.resolve(path.dirname(filename), pkg.exports['.'].import)
        : require.resolve('nodemailer')
      mailer = (await import(pathToFileURL(entry).href)).default
      nodeAssert.equal(typeof mailer.createTransport, 'function')
    }
    const transport = mailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'windows',
    })
    try {
      const result = await transport.sendMail(message())
      nodeAssert.ok(Buffer.isBuffer(result.message))
      assertMessage(result.message.toString())
    } finally {
      transport.close()
    }
  } else if (scenario === 'raw-file-denied') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lope-mail-raw-'))
    fs.chmodSync(directory, 0o700)
    const filename = path.join(directory, 'synthetic.eml')
    fs.writeFileSync(
      filename,
      'From: sender@example.invalid\r\nTo: recipient@example.invalid\r\n\r\nsynthetic file\r\n',
      { mode: 0o600 }
    )
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    })
    try {
      await nodeAssert.rejects(
        transport.sendMail({
          raw: { path: filename },
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        error =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'EFILEACCESS'
      )
    } finally {
      transport.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  } else if (scenario === 'raw-url-denied') {
    let requests = 0
    const server = http.createServer((req, res) => {
      requests++
      res.end('From: sender@example.invalid\r\n\r\nsynthetic URL\r\n')
    })
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      nodeAssert.ok(address && typeof address !== 'string')
      await nodeAssert.rejects(
        transport.sendMail({
          raw: { href: `http://127.0.0.1:${address.port}/synthetic` },
          disableUrlAccess: true,
          disableFileAccess: true,
        }),
        error =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'EURLACCESS'
      )
      nodeAssert.equal(requests, 0)
    } finally {
      transport.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(() => resolve(undefined)))
    }
  } else if (
    scenario === 'address-flat-work' ||
    scenario === 'address-fallback'
  ) {
    /** @type {typeof import('nodemailer/lib/addressparser').default} */
    const addressparser = require('node:module').createRequire(__filename)(
      'nodemailer/lib/addressparser'
    )
    if (scenario === 'address-fallback') {
      const parsed = addressparser('[x]'.repeat(2048))
      nodeAssert.ok(Array.isArray(parsed) && parsed.length <= 1)
    } else {
      const count = 2000
      const descriptor = Object.getOwnPropertyDescriptor(
        Array.prototype,
        'concat'
      )
      nodeAssert.ok(descriptor)
      const concat = Array.prototype.concat
      let copied = 0
      Object.defineProperty(Array.prototype, 'concat', {
        ...descriptor,
        /** @this {unknown[]} @param {...unknown} args */
        value(...args) {
          copied += this.length
          return concat.apply(this, args)
        },
      })
      try {
        const parsed = addressparser('recipient@example.invalid,'.repeat(count))
        nodeAssert.equal(parsed.length, count)
        nodeAssert.equal(
          copied <= count * 8,
          true,
          'address-list accumulation copies remain linear in this bounded input'
        )
      } finally {
        Object.defineProperty(Array.prototype, 'concat', descriptor)
      }
    }
  } else throw new Error('unknown mail compatibility scenario')
}

module.exports = { withSmtp, message, assertMessage, transportOptions }
if (require.main === module) {
  const scenario = process.argv[2]
  nodeAssert.ok(scenario)
  runScenario(scenario)
    .then(() => console.log('PASS'))
    .catch(error => {
      console.error(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'mail fixture failed'
      )
      process.exitCode = 1
    })
}
