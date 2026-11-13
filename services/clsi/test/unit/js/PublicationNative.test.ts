import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
for (const mode of [
  'read-abort',
  'write-abort',
  'rename-abort',
  'rollback-retry',
  'rename-reject',
  'parent-create-reject',
  'read-return',
  'rename-return',
  'read-reset',
  'foreign-target',
  'committed-abort',
  'close-abort',
  'device-guard',
  'one-open-directory',
  'read-revision',
  'rename-revision',
  'copy-revision',
]) {
  test(`${mode} actual publication ownership`, () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./PublicationOwners.native.ts', import.meta.url)
        ),
        mode,
      ],
      { encoding: 'utf8', timeout: 15000 }
    )
    assert.equal(result.error, undefined, result.stderr)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.stdout.trim().split('\n').at(-1),
      `${mode} native publication owner PASS`
    )
  }, 20000)
}
