import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('CLSI listener source passes actual Node native import and HTTP lifecycle regressions', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      fileURLToPath(new URL('./ClsiListener.native.ts', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 20_000 }
  )
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
}, 25_000)
