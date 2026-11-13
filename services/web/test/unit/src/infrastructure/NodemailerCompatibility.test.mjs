// @ts-check
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(
  new URL('./fixtures/nodemailer-compatibility.cjs', import.meta.url)
)
const scenarios = [
  'smtp-delivery',
  'smtp-logger-redaction',
  'smtp-utf8',
  'smtp-auth-rejection',
  'smtp-recipient-rejection',
  'smtp-abort',
  'smtp-timeout',
  'smtp-tls-verified',
  'smtp-tls-rejected',
  'stream-message',
  'esm-default',
  'raw-file-denied',
  'raw-url-denied',
  'address-flat-work',
  'address-fallback',
]
describe('Nodemailer major compatibility with isolated synthetic transports', () => {
  for (const scenario of scenarios)
    it(
      scenario,
      () => {
        const result = spawnSync(
          process.execPath,
          ['--max-old-space-size=128', fixture, scenario],
          { env: process.env, encoding: 'utf8', timeout: 6000 }
        )
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.signal, result.stderr).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe('PASS')
      },
      10000
    )
})
