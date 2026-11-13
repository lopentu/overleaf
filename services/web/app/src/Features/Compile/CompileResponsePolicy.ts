/** Recognize only the exact wire collision pair. Never propagate attached
 * output identities into a failed attempt or turn it into a resync retry. */
export function buildIdConflictResponse(body: unknown) {
  if (!body || typeof body !== 'object' || !('compile' in body))
    return undefined
  const compile = body.compile
  if (
    !compile ||
    typeof compile !== 'object' ||
    !('status' in compile) ||
    !('error' in compile) ||
    compile.status !== 'error' ||
    compile.error !== 'build-id-conflict'
  )
    return undefined
  return {
    compile: { status: 'error', error: 'build-id-conflict', outputFiles: [] },
  }
}
