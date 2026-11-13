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

// The unselected publisher must use Node's native strip-only module semantics,
// and the legacy CJS/ESM forwarding must preserve the exact error constructor.
const { openCompileOutputPublisher } =
  await import('../app/js/CompileOutputPublisher.ts')
const { BuildIdConflictError } =
  await import('../app/js/BuildIdConflictError.ts')
const errors = await import('../app/js/Errors.js')
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const cjsErrors = require('../app/js/Errors.js')
assert.equal(typeof openCompileOutputPublisher, 'function')
assert.equal(errors.BuildIdConflictError, BuildIdConflictError)
assert.equal(errors.default.BuildIdConflictError, BuildIdConflictError)
assert.equal(cjsErrors.BuildIdConflictError, BuildIdConflictError)
assert.equal(cjsErrors.default.BuildIdConflictError, BuildIdConflictError)
assert.equal(
  new cjsErrors.BuildIdConflictError() instanceof BuildIdConflictError,
  true
)
console.log('Node24.18.1 strip-only publication and CJS error identity PASS')
