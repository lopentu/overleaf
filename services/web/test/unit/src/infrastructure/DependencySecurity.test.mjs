// @ts-check
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(
  new URL('./fixtures/dependency-security.cjs', import.meta.url)
)

const scenarios = [
  'proxy-trust',
  'mongoose-inherited-properties',
  'mongoose-connection-sanitize-filter',
  'multer-lockdown-and-filename',
  'multer-array-index',
  'multer-late-filter',
  'compression-abort',
  'body-delayed-deflate',
  'body-second-consumer',
  'body-trailing-gzip',
  'body-unsupported-charset',
  'body-valid-identity',
  'body-valid-gzip',
  'body-valid-deflate',
]

describe('production dependency security regressions', () => {
  for (const scenario of scenarios) {
    it(
      scenario,
      () => {
        // Isolate crash/prototype-pollution regressions from the test worker.
        const result = spawnSync(
          process.execPath,
          ['--max-old-space-size=128', fixture, scenario],
          { env: process.env, encoding: 'utf8', timeout: 5000 }
        )

        expect(result.error, result.stderr).toBeUndefined()
        expect(result.signal, result.stderr).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe('PASS')
      },
      10000
    )
  }
})
