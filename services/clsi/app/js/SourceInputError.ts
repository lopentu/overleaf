export type SourceInputCode =
  | 'INVALID_SOURCE_REQUEST'
  | 'INPUT_LIMIT'
  | 'SOURCE_CANCELLED'
  | 'SOURCE_IO_FAILED'
  | 'SOURCE_DOWNLOAD_FAILED'
  | 'SOURCE_CACHE_CAPACITY'
  | 'SOURCE_CACHE_UNSAFE'
/** Deliberately contains no source URL/path/content or original exception cause. */
export class SourceInputError extends Error {
  readonly code: SourceInputCode
  readonly phase: string | undefined
  constructor(code: SourceInputCode, phase?: string) {
    super(`Source input preparation: ${code}`)
    this.code = code
    this.phase = phase
  }
}
export function checkSourceSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new SourceInputError('SOURCE_CANCELLED')
}

/** Aggregate only sanitized owned-operation failures, never a transport cause. */
export class SourceInputAggregateError extends AggregateError {
  constructor(errors: readonly unknown[], phase: string) {
    super(
      errors.map(error =>
        error instanceof SourceInputError ||
        error instanceof SourceInputAggregateError
          ? error
          : new SourceInputError('SOURCE_IO_FAILED')
      ),
      `Source input preparation: ${phase}`
    )
    Object.freeze(this.errors)
  }
}
