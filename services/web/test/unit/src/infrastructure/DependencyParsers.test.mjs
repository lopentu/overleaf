// @ts-check
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(
  new URL('./fixtures/dependency-parsers.cjs', import.meta.url)
)
const scenarios = [
  'xml-element-name',
  'xml-attribute-name',
  'xml-processing-instruction-target',
  'xml-doctype-name',
  'xml-valid-namespaced-unicode',
  'xml-namespace-memory-budget',
  'xml-many-attributes-budget',
  'xml-malformed-end-tag-budget',
  'xml-malformed-recovery-budget',
  'zod-oversized-invalid-array',
  'zod-oversized-array-skips-elements',
  'zod-oversized-set-skips-elements',
  'zod-valid-boundaries-and-errors',
]

describe('bounded XML and collection dependency regressions', () => {
  for (const scenario of scenarios) {
    it(
      scenario,
      () => {
        // Isolate memory/event-loop regressions; no network or real integrations.
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
