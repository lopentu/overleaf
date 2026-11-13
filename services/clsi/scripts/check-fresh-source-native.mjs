// @ts-check
import assert from 'node:assert/strict'
import process from 'node:process'
assert.equal(process.versions.node, '24.18.1')
assert.equal(
  process.execArgv.some(arg => arg.includes('experimental-transform-types')),
  false
)
assert.equal(
  (process.env.NODE_OPTIONS ?? '').includes('experimental-transform-types'),
  false
)
const { parseFullSourcePlan, materializeFullSource } =
  await import('../app/js/FreshCompileInput.ts')
const { CompileSourcePlanCache } =
  await import('../app/js/CompileSourcePlanCache.ts')
assert.equal(typeof parseFullSourcePlan, 'function')
assert.equal(typeof materializeFullSource, 'function')
assert.equal(typeof CompileSourcePlanCache.open, 'function')
console.log('Node24.18.1 strip-only fresh source import PASS')
