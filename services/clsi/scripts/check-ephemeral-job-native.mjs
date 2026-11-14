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
const { withCompileInputSnapshot } =
  await import('../app/js/CompileInputSnapshot.ts')
assert.equal(typeof withCompileInputSnapshot, 'function')
const { CompilerAdmission } = await import('../app/js/CompilerAdmission.ts')
const { createWorkflowJsonHandler } =
  await import('../app/js/WorkflowAdmissionHttp.ts')
assert.equal(typeof CompilerAdmission, 'function')
assert.equal(typeof createWorkflowJsonHandler, 'function')
assert.equal(typeof EphemeralDockerJob.prototype.runArtifacts, 'function')
assert.equal(typeof EphemeralDockerJob.prototype.runStdout, 'function')
const { createManifestInputArchiveBundle, extractCompileOutputArchive } =
  await import('../app/js/BoundedProjectArchive.ts')
assert.equal(typeof createManifestInputArchiveBundle, 'function')
assert.equal(typeof extractCompileOutputArchive, 'function')

// Pure command/environment extraction must also import under native strip-only
// semantics. This does not import a runner or execute a compiler/image command.
const { buildLatexCommand, deriveCompileEnvironment } =
  await import('../app/js/LatexCommand.ts')
const { configuredCompilerEnvironment } =
  await import('../app/js/CompileEnvironment.ts')
const { createCompilerCommandPlanner } =
  await import('../app/js/CompilerCommandPlan.ts')
assert.equal(typeof createCompilerCommandPlanner, 'function')
assert.deepEqual(
  buildLatexCommand(
    '文 $COMPILE_DIR.tex',
    { compiler: 'pdflatex' },
    {},
    { directory: '/compile', executable: '/synthetic/latexmk' }
  ),
  [
    '/synthetic/latexmk',
    '-cd',
    '-jobname=output',
    '-auxdir=/compile',
    '-outdir=/compile',
    '-synctex=1',
    '-interaction=batchmode',
    '-time',
    '-f',
    '-pdf',
    '/compile/文 $COMPILE_DIR.tex',
  ]
)
assert.deepEqual(
  configuredCompilerEnvironment({
    HOME: '/tmp',
    TEXMFVAR: '/tmp/texmf-var',
    TEXMFCONFIG: '/tmp/texmf-config',
    CLSI: 1,
  }),
  {}
)
assert.equal(
  deriveCompileEnvironment({
    projectId: 'synthetic',
    mainFile: 'main.tex',
    check: 'validate',
  }).CHKTEX_VALIDATE,
  1
)
console.log('Node24.18.1 strip-only native import PASS')
