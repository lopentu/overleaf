import {
  compilerWorkflowMode,
  requireLegacyCompilerStartup,
} from '../../../app/js/CompilerWorkflowMode.ts'
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
afterEach(() => {
  vi.doUnmock('@overleaf/settings')
  vi.doUnmock('dockerode')
})
test('isolated selection refuses legacy local dispatch before importing any execution backend', async () => {
  vi.doMock('@overleaf/settings', () => ({
    default: {
      compilerWorkflowMode: 'isolated',
      clsi: { dockerRunner: false },
    },
  }))
  const error: unknown = await import('../../../app/js/CommandRunner.js').then(
    () => undefined,
    error => error
  )
  assert.ok(
    error instanceof Error,
    'isolated selection silently imported the local legacy runner'
  )
  assert.match(error.message, /ISOLATED_RUNTIME_UNQUALIFIED/)
})
test('isolated selection refuses a legacy Docker client and its expiry monitor before construction', async () => {
  let clients = 0
  vi.doMock('@overleaf/settings', () => ({
    default: { compilerWorkflowMode: 'isolated', clsi: { dockerRunner: true } },
  }))
  vi.doMock('dockerode', () => ({
    default: class RefusedDocker {
      constructor() {
        clients++
      }
    },
  }))
  const loaded = await import('../../../app/js/DockerRunner.mjs').then(
    module => {
      module.default.stopContainerMonitor()
      return undefined
    },
    error => error
  )
  assert.equal(clients, 0, 'isolated selection created a legacy Docker client')
  assert.ok(loaded instanceof Error)
  assert.match(loaded.message, /ISOLATED_RUNTIME_UNQUALIFIED/)
})

test('startup selection is a closed vocabulary, never a caller eligibility flag', () => {
  assert.equal(compilerWorkflowMode(undefined), 'legacy-trusted')
  assert.equal(compilerWorkflowMode('legacy-trusted'), 'legacy-trusted')
  assert.equal(compilerWorkflowMode('isolated'), 'isolated')
  assert.doesNotThrow(() => requireLegacyCompilerStartup('legacy-trusted'))
  for (const invalid of [
    '',
    'legacy',
    'true',
    'isolated-ready',
    false,
    {},
    { qualified: true },
  ])
    assert.throws(
      () => compilerWorkflowMode(invalid),
      /INVALID_COMPILER_WORKFLOW_MODE/
    )
  assert.throws(
    () => requireLegacyCompilerStartup('isolated'),
    /ISOLATED_RUNTIME_UNQUALIFIED/
  )
})
