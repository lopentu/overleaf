/** Explicit startup selection. No configured object or returned value qualifies
 * an isolated daemon/kernel; those native deployment gates remain unearned. */
export function compilerWorkflowMode(
  value: unknown
): 'legacy-trusted' | 'isolated' {
  if (value === undefined || value === 'legacy-trusted') return 'legacy-trusted'
  if (value === 'isolated') return 'isolated'
  throw new Error('INVALID_COMPILER_WORKFLOW_MODE')
}
export function requireLegacyCompilerStartup(value: unknown): void {
  if (compilerWorkflowMode(value) === 'isolated')
    throw new Error('ISOLATED_RUNTIME_UNQUALIFIED')
}
