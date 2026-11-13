import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
for (const mode of [
  'root-authority',
  'source-identity-capture',
  'source-registration-validation',
  'source-late-allocation',
  'source-abort-allocation',
  'source-late-identity',
  'cache-identity-capture',
  'cache-unawaited-rename',
  'cache-rename-abort',
  'cache-read-abort',
  'cache-read-close-error',
  'cache-close-abort',
  'cache-write-abort',
  'cache-backup-link-error',
  'cache-backup-cleanup-error',
  'source-write-abort',
  'source-write-close-error',
]) {
  test(`${mode} native real-I/O owner`, () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./FreshInputOwners.native.ts', import.meta.url)),
        mode,
      ],
      { encoding: 'utf8', timeout: 15000 }
    )
    assert.equal(child.error, undefined, child.stderr)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(
      child.stdout.trim().split('\n').at(-1),
      `${mode} native source owner PASS`
    )
  }, 20000)
}
for (const mode of [
  'history-parity',
  'history404',
  'cjs-import',
  'history-sibling-join',
]) {
  test(`${mode} native source compatibility`, () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./SourceHistoryCompatibility.native.ts', import.meta.url)
        ),
        mode,
      ],
      { encoding: 'utf8', timeout: 15000 }
    )
    assert.equal(child.error, undefined, child.stderr)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(
      child.stdout.trim().split('\n').at(-1),
      `${mode} native source compatibility PASS`
    )
  }, 20000)
}
test('concurrent pending and committed cache bytes share one aggregate budget', () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./SourceCacheQuota.native.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 15000 }
  )
  assert.equal(child.error, undefined, child.stderr)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(
    child.stdout.trim().split('\n').at(-1),
    'concurrent pending quota native PASS'
  )
}, 20000)
test('the real Metrics shorthand and explicit positional signatures preserve labels and counts', () => {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./SourceMetricsParity.native.ts', import.meta.url)
      ),
    ],
    { encoding: 'utf8', timeout: 15000 }
  )
  assert.equal(child.error, undefined, child.stderr)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(
    child.stdout.trim().split('\n').at(-1),
    'actual Metrics positional parity PASS'
  )
}, 20000)
