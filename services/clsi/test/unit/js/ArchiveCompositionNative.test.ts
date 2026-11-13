import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
for (const mode of [
  'adapter-artifacts',
  'adapter-artifacts-close-error',
  'adapter-stdout',
  'adapter-stdout-close-error',
  'diagnostic-allocation',
  'output-root-replaced',
  'producer-partial',
  'diagnostic-close-error',
  'producer-read',
  'producer-close',
  'producer-close-error',
  'write-abort',
  'write-close-error',
  'commit-error',
  'cleanup-error',
  'tar',
]) {
  test(`${mode} native owner and true TAR boundary`, () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./ArchiveComposition.native.ts', import.meta.url)
        ),
        mode,
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `${mode} native composition PASS`)
  })
}
