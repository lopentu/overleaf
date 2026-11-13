// @ts-check
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(
  new URL('./fixtures/body-parser-compatibility.cjs', import.meta.url)
)
const formats = ['json', 'raw', 'text', 'urlencoded']
const scenarios = [
  ...formats.flatMap(format =>
    ['identity', 'gzip', 'deflate'].map(
      encoding => `lockdown-${format}-${encoding}`
    )
  ),
  ...formats.map(format => `invalid-limit-${format}`),
  ...formats.map(format => `wire-limit-${format}`),
  ...formats.flatMap(format =>
    ['null', 'undefined'].map(value => `default-limit-${format}-${value}`)
  ),
  'lockdown-json-gzip-trailing',
  'lockdown-text-deflate-hash',
  'lockdown-text-gzip-charset',
  'lockdown-urlencoded-array',
  'lockdown-query',
]

describe('body-parser upstream and request-lockdown compatibility', () => {
  for (const scenario of scenarios) {
    it(
      scenario,
      () => {
        const result = spawnSync(
          process.execPath,
          ['--max-old-space-size=128', fixture, scenario],
          {
            env: process.env,
            encoding: 'utf8',
            timeout: 5000,
          }
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
