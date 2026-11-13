// @ts-check
import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** @typedef {{ to: string, subject: string, html: string }} MailOptions */
/** @typedef {{ promises: { sendEmail: (options: MailOptions, type: string) => Promise<void> } }} EmailSender */

const modulePath = '../../../../app/src/Features/Email/EmailSender.mjs'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.resetModules()
})

describe('email transport credential logging', () => {
  for (const transport of ['smtp', 'ses', 'disabled']) {
    const sensitiveContent =
      transport === 'disabled'
        ? 'disabled message content'
        : `${transport} credentials`
    it(`keeps ${sensitiveContent} out of console and logger output`, async () => {
      const sentinel = `synthetic-${crypto.randomUUID()}`
      /** @type {unknown[][]} */
      const records = []
      /** @param {...unknown} args */
      const capture = (...args) => {
        records.push(args)
      }
      /** @type {Array<'log' | 'info' | 'warn' | 'error' | 'debug' | 'dir' | 'trace' | 'table'>} */
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

      const sendMail = vi.fn(async (/** @type {MailOptions} */ options) => {
        expect(options.to).toBe('recipient@example.invalid')
      })
      const createTransport = vi.fn(() => ({ sendMail }))
      const SESv2Client = vi.fn(class {})
      vi.doMock('nodemailer', () => ({ default: { createTransport } }))
      vi.doMock('@aws-sdk/client-sesv2', () => ({
        SESv2Client,
        SendEmailCommand: class {},
      }))
      vi.doMock('@overleaf/settings', () => ({
        default: {
          email: {
            driver: transport,
            parameters:
              transport === 'disabled'
                ? undefined
                : transport === 'smtp'
                  ? {
                      host: 'smtp.example.invalid',
                      auth: { user: 'fixture', pass: sentinel },
                    }
                  : {
                      region: 'test-region',
                      AWSAccessKeyID: 'fixture-access',
                      AWSSecretKey: sentinel,
                    },
          },
        },
      }))
      vi.doMock('@overleaf/logger', () => ({
        default: Object.fromEntries(
          ['debug', 'info', 'log', 'warn', 'err', 'error', 'fatal'].map(
            level => [level, vi.fn(capture)]
          )
        ),
      }))
      vi.doMock('@overleaf/metrics', () => ({ default: { inc: vi.fn() } }))
      vi.doMock('../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
        RateLimiter: class {
          consume = vi.fn().mockResolvedValue(undefined)
        },
      }))

      /** @type {EmailSender} */
      const sender = (await import(modulePath)).default
      await sender.promises.sendEmail(
        {
          to: 'recipient@example.invalid',
          subject: 'Synthetic credential regression',
          html: `<a href="https://example.invalid/reset?token=${sentinel}">Reset</a>`,
        },
        'fixture'
      )
      expect(createTransport).toHaveBeenCalledTimes(
        transport === 'disabled' ? 0 : 1
      )
      expect(sendMail).toHaveBeenCalledTimes(transport === 'disabled' ? 0 : 1)
      expect(SESv2Client).toHaveBeenCalledTimes(transport === 'ses' ? 1 : 0)
      // Assert a boolean so failures never echo even the synthetic sentinel.
      expect(JSON.stringify(records).includes(sentinel)).toBe(false)
    })
  }
})

it('records deferred queue failures without logging private message options or error content', async () => {
  const sentinel = `synthetic-${crypto.randomUUID()}`
  const warn = vi.fn()
  const createScheduledJob = vi.fn().mockRejectedValue(new Error(sentinel))
  vi.doMock('@overleaf/logger', () => ({ default: { warn } }))
  vi.doMock('@overleaf/settings', () => ({ default: { email: {} } }))
  vi.doMock('../../../../app/src/Features/Email/EmailBuilder.mjs', () => ({
    default: { buildEmail: vi.fn() },
  }))
  vi.doMock('../../../../app/src/Features/Email/EmailSender.mjs', () => ({
    default: { promises: { sendEmail: vi.fn() } },
  }))
  vi.doMock('../../../../app/src/infrastructure/Queues.mjs', () => ({
    default: { createScheduledJob },
  }))
  const handlerModulePath =
    '../../../../app/src/Features/Email/EmailHandler.mjs'
  /** @type {{ sendDeferredEmail: (type: string, options: Record<string, unknown>, delay: number) => void }} */
  const handler = (await import(handlerModulePath)).default
  handler.sendDeferredEmail('team_invite', { token: sentinel }, 10)
  await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
  expect(createScheduledJob).toHaveBeenCalledOnce()
  const contents = JSON.stringify(
    warn.mock.calls,
    (/** @type {string} */ key, /** @type {unknown} */ value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
  )
  expect(contents.includes(sentinel)).toBe(false)
})
