import assert from 'node:assert/strict'
import process from 'node:process'
import console from 'node:console'

assert.equal(
  process.versions.node,
  '24.18.1',
  'Run native import with the pinned Node24.18.1'
)
assert.equal(
  process.execArgv.some(arg => arg.includes('experimental-transform-types')),
  false
)
assert.equal(
  (process.env.NODE_OPTIONS ?? '').includes('experimental-transform-types'),
  false
)
const { EphemeralDockerJob } = await import('../app/js/EphemeralDockerJob.ts')
assert.equal(typeof EphemeralDockerJob, 'function')
console.log('Node24.18.1 strip-only native import PASS')
