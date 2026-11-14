// @ts-check
import assert from 'node:assert/strict'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
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

// Importing the new workflow graph in explicitly isolated mode must never load
// a legacy local/Docker backend or its constructor/expiry monitor. This checks
// native module composition only; it cannot qualify a daemon, kernel or image.
const isolatedModules = [
  'CompilerWorkflow.ts',
  'CompilerWorkflowHttp.ts',
  'PublishedOutputReader.ts',
  'PreparedCompilerInput.ts',
  'PreparedSyncTexInput.ts',
].map(name => new URL('../app/js/' + name, import.meta.url).href)
const isolated = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    `import Settings from '@overleaf/settings'; if (Settings.compilerWorkflowMode !== 'isolated') throw new Error('isolated selection mismatch'); for (const name of ${JSON.stringify(isolatedModules)}) await import(name); process.stdout.write('isolated-workflow-import-ok\\n')`,
  ],
  {
    env: { ...process.env, CLSI_COMPILER_WORKFLOW_MODE: 'isolated' },
    encoding: 'utf8',
    timeout: 10000,
  }
)
assert.equal(isolated.error, undefined)
assert.equal(isolated.status, 0, isolated.stderr)
assert.equal(
  isolated.stdout
    .split('\n')
    .filter(line => line === 'isolated-workflow-import-ok').length,
  1
)
console.log('Node24.18.1 strip-only isolated workflow graph import PASS')
