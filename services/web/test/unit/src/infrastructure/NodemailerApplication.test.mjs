// @ts-check
import nodeAssert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/nodemailer-compatibility.cjs'

const localRequire = createRequire(import.meta.url)
/** @type {typeof import('nodemailer')} */
const realNodemailer = localRequire('nodemailer')
/** @type {typeof import('@aws-sdk/client-sesv2')} */
const sdk = localRequire('@aws-sdk/client-sesv2')
/** @typedef {import('nodemailer').SendMailOptions & {sendingUser_id?: string, category?: string}} AppMessage */
/** @typedef {{promises:{sendEmail:(options:AppMessage,type:string)=>Promise<void>},sendEmail:(options:AppMessage,type:string,done:(error:Error|null)=>void)=>void}} Sender */
const senderPath = '../../../../app/src/Features/Email/EmailSender.mjs'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.resetModules()
})

/** @param {Record<string,unknown>} settings @param {Record<string,unknown>} [mockSdk] */
async function loadSender(settings, mockSdk = {}) {
  /** @type {unknown[][]} */
  const records = []
  /** @param {...unknown} values */
  const capture = (...values) => {
    records.push(values)
  }
  /** @type {Array<'log'|'info'|'warn'|'error'|'debug'|'dir'|'trace'|'table'>} */
  const methods = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'dir',
    'trace',
    'table',
  ]
  for (const method of methods)
    vi.spyOn(console, method).mockImplementation(capture)
  vi.doMock('nodemailer', () => ({ default: realNodemailer }))
  vi.doMock('@aws-sdk/client-sesv2', () => ({ ...sdk, ...mockSdk }))
  vi.doMock('@overleaf/settings', () => ({ default: settings }))
  vi.doMock('@overleaf/logger', () => ({
    default: Object.fromEntries(
      ['debug', 'info', 'log', 'warn', 'err', 'error', 'fatal'].map(level => [
        level,
        vi.fn(capture),
      ])
    ),
  }))
  vi.doMock('@overleaf/metrics', () => ({ default: { inc: vi.fn() } }))
  vi.doMock('../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
    RateLimiter: class {
      consume = vi.fn().mockResolvedValue(undefined)
    },
  }))
  /** @type {Sender} */
  const sender = (await import(senderPath)).default
  return { sender, records }
}

/** @returns {AppMessage} */
function appMessage() {
  return {
    ...fixture.message(),
    category: 'fixture-category',
    raw: Buffer.from('synthetic ignored raw field'),
    attachments: [
      { filename: 'ignored.txt', content: 'synthetic ignored attachment' },
    ],
  }
}

describe('actual EmailSender with real Nodemailer transport implementations', () => {
  for (const api of ['promise', 'callback'])
    it(`preserves ${api} SMTP delivery and credential redaction`, async () => {
      const sentinel = `synthetic-${crypto.randomUUID()}`
      await fixture.withSmtp({ password: sentinel }, async smtp => {
        const { sender, records } = await loadSender({
          email: {
            textEncoding: 'quoted-printable',
            parameters: {
              host: '127.0.0.1',
              port: smtp.port,
              secure: false,
              ignoreTLS: true,
              auth: { user: 'fixture', pass: sentinel },
              name: 'fixture.invalid',
            },
          },
        })
        if (api === 'promise')
          await sender.promises.sendEmail(appMessage(), 'fixture')
        else
          await new Promise((resolve, reject) =>
            sender.sendEmail(appMessage(), 'fixture', error =>
              error ? reject(error) : resolve(undefined)
            )
          )
        expect(smtp.state.authenticated).toBe(true)
        expect(smtp.state.delivered).toBe(1)
        fixture.assertMessage(smtp.state.message)
        expect(
          /Content-Disposition: attachment/i.test(smtp.state.message)
        ).toBe(false)
        expect(smtp.state.message.includes('synthetic ignored raw field')).toBe(
          false
        )
        // Only booleans are asserted, so failures cannot print the sentinel.
        expect(JSON.stringify(records).includes(sentinel)).toBe(false)
      })
    })

  it('preserves the public generic rejection when real SMTP rejects a recipient', async () => {
    const sentinel = `synthetic-${crypto.randomUUID()}`
    await fixture.withSmtp(
      { password: sentinel, rejectRecipient: true },
      async smtp => {
        const { sender, records } = await loadSender({
          email: {
            parameters: {
              host: '127.0.0.1',
              port: smtp.port,
              secure: false,
              ignoreTLS: true,
              auth: { user: 'fixture', pass: sentinel },
              name: 'fixture.invalid',
            },
          },
        })
        await nodeAssert.rejects(
          sender.promises.sendEmail(appMessage(), 'fixture'),
          { message: 'error sending message' }
        )
        expect(smtp.state.delivered).toBe(0)
        expect(JSON.stringify(records).includes(sentinel)).toBe(false)
      }
    )
  })

  it('constructs real SESv2 commands with a mocked SDK client and preserves rejection', async () => {
    const sentinel = `synthetic-${crypto.randomUUID()}`
    /** @type {import('@aws-sdk/client-sesv2').SendEmailCommandInput[]} */
    const commands = []
    let credentialMatched = false
    let reject = false
    class LocalSESClient {
      config = { region: async () => 'us-test-1' }
      /** @param {{region:string,credentials:{accessKeyId:string,secretAccessKey:string}}} options */
      constructor(options) {
        credentialMatched =
          options.region === 'us-test-1' &&
          options.credentials.accessKeyId === 'fixture-access' &&
          options.credentials.secretAccessKey === sentinel
      }
      /** @param {unknown} command */
      async send(command) {
        nodeAssert.ok(command instanceof sdk.SendEmailCommand)
        commands.push(command.input)
        if (reject) throw new Error('synthetic SES rejection')
        return { MessageId: 'fixture-message-id' }
      }
    }
    const { sender, records } = await loadSender(
      {
        email: {
          driver: 'ses',
          textEncoding: 'quoted-printable',
          parameters: {
            region: 'us-test-1',
            AWSAccessKeyID: 'fixture-access',
            AWSSecretKey: sentinel,
          },
        },
      },
      { SESv2Client: LocalSESClient, SendEmailCommand: sdk.SendEmailCommand }
    )
    await sender.promises.sendEmail(appMessage(), 'fixture')
    expect(credentialMatched).toBe(true)
    expect(commands.length).toBe(1)
    expect(commands[0].Destination?.ToAddresses?.slice().sort()).toEqual([
      'copy@example.invalid',
      'recipient@example.invalid',
    ])
    expect(
      commands[0].FromEmailAddress?.includes('sender@xn--bcher-kva.example')
    ).toBe(true)
    const raw = commands[0].Content?.Raw?.Data
    nodeAssert.ok(raw instanceof Uint8Array)
    fixture.assertMessage(Buffer.from(raw).toString('utf8'))
    reject = true
    await nodeAssert.rejects(
      sender.promises.sendEmail(appMessage(), 'fixture'),
      { message: 'error sending message' }
    )
    expect(commands.length).toBe(2)
    expect(JSON.stringify(records).includes(sentinel)).toBe(false)
  })
})
