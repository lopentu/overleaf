/** One existing result-envelope error; never attach paths, IDs or source data. */
export class BuildIdConflictError extends Error {
  constructor() {
    super('build-id-conflict')
    this.name = 'BuildIdConflictError'
  }
}

/** Normalize only this exact internal error; attached fields are never output. */
export function buildIdConflictResponse(error: unknown) {
  if (!(error instanceof BuildIdConflictError)) return undefined
  return {
    compile: { status: 'error', error: 'build-id-conflict', outputFiles: [] },
  }
}
