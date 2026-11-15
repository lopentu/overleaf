// @ts-check
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(
  new URL('./fixtures/send-client-disconnect.cjs', import.meta.url)
)

const scenarios = [
  'normal',
  'disconnect-before-stat',
  'disconnect-at-stream',
  'disconnect-after-start',
  'read-error',
  'pipeline-unexpected-error',
]

describe('send static-file client cancellation', () => {
  for (const scenario of scenarios) {
    it(scenario, () => {
      const result = spawnSync(process.execPath, [fixture, scenario], {
        env: process.env,
        encoding: 'utf8',
        timeout: 5000,
      })
      // The fixture emits only a fixed success marker or an allowlisted code.
      // Never include child stderr in assertions: real crash output is unneeded.
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stdout).toBe(
        scenario === 'pipeline-unexpected-error' ? 1 : 0
      )
      expect(result.stdout.trim()).toBe(
        scenario === 'pipeline-unexpected-error' ? 'UNCAUGHT:EIO' : 'PASS'
      )
    })
  }
})
