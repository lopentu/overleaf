import express from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { AdmissionError } from './CompilerAdmission.ts'
import type {
  CompilerAdmission,
  WorkflowFilter,
  WorkflowMetadata,
  WorkflowScope,
} from './CompilerAdmission.ts'

type Params = Record<string, string>
export type WorkflowHttpRequest = Request<Params, unknown, unknown>
type WorkflowResponse = Response<unknown>
export interface WorkflowHttpResult {
  statusCode: number
  body: unknown
}
interface Options {
  queueTimeoutMs?: number
  bodyLimitBytes?: number
}

function sendFailure(
  request: WorkflowHttpRequest,
  response: WorkflowResponse,
  error: unknown
): void {
  if (response.destroyed || response.writableEnded) return
  let status = 500,
    code = 'WORKFLOW_FAILED'
  if (error instanceof AdmissionError) {
    status =
      error.code === 'PROJECT_BUSY'
        ? 423
        : error.code === 'INVALID_REQUEST'
          ? 400
          : 503
    code = error.code
  } else if (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    [400, 413, 415].includes(error.status)
  ) {
    status = error.status
    code = status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_BODY'
  }
  response.setHeader('connection', 'close')
  response.once('finish', () => {
    if (!request.complete) request.destroy()
  })
  response.status(status).json({ error: code })
}
/** Internal unmounted JSON workflow boundary. The waiting caller owns a paused
 * HTTP stream, not parsed project contents. Queue entries contain metadata only.
 * The work promise and its registered workspace cleanup precede the response.
 */
export function createWorkflowJsonHandler(
  admission: CompilerAdmission,
  metadata: (request: WorkflowHttpRequest) => WorkflowMetadata,
  work: (
    request: WorkflowHttpRequest,
    scope: WorkflowScope
  ) => Promise<WorkflowHttpResult>,
  options: Options = {}
): RequestHandler<Params, unknown, unknown> {
  const bodyLimitBytes = options.bodyLimitBytes ?? 7 * 1024 * 1024
  if (
    !Number.isSafeInteger(bodyLimitBytes) ||
    bodyLimitBytes < 1 ||
    bodyLimitBytes > 7 * 1024 * 1024
  )
    throw new AdmissionError('INVALID_REQUEST')
  const parse = express.json({ limit: bodyLimitBytes, strict: true })
  return (request, response) => {
    request.pause()
    const controller = new AbortController()
    const cancel = () => controller.abort(new AdmissionError('CANCELLED'))
    const disconnected = () => {
      if (!response.writableFinished) cancel()
    }
    request.once('aborted', cancel)
    request.on('error', cancel)
    response.once('close', disconnected)
    if (request.aborted || response.destroyed) cancel()
    void (async () => {
      let removeActiveAbort: (() => void) | undefined
      try {
        const lease = await admission.acquire(metadata(request), {
          signal: controller.signal,
          ...(options.queueTimeoutMs === undefined
            ? {}
            : { queueTimeoutMs: options.queueTimeoutMs }),
        })
        const abortInput = () => {
          if (!request.complete) request.destroy()
        }
        lease.signal.addEventListener('abort', abortInput, { once: true })
        if (lease.signal.aborted) abortInput()
        removeActiveAbort = () =>
          lease.signal.removeEventListener('abort', abortInput)
        const result = await lease.run(async scope => {
          scope.signal.throwIfAborted()
          if (!request.is('application/json'))
            throw Object.assign(new Error('JSON body required'), {
              status: 415,
            })
          await new Promise<void>((resolve, reject) => {
            parse(request, response, (error: unknown) =>
              error === undefined ? resolve() : reject(error)
            )
            request.resume()
          })
          scope.signal.throwIfAborted()
          return await work(request, scope)
        })
        if (!response.destroyed && !response.writableEnded)
          response.status(result.statusCode).json(result.body)
      } catch (error) {
        sendFailure(request, response, error)
      } finally {
        removeActiveAbort?.()
        request.removeListener('aborted', cancel)
        response.removeListener('close', disconnected)
        // Destroy may schedule an error before close. Retain its listener until
        // that actual stream lifetime ends; never turn it into an unhandled error.
        if (request.destroyed && !request.closed)
          request.once('close', () => request.removeListener('error', cancel))
        else request.removeListener('error', cancel)
      }
    })()
  }
}
function controlHandler(
  action: (filter: WorkflowFilter) => Promise<void>,
  scope: (request: WorkflowHttpRequest) => WorkflowFilter
): RequestHandler<Params, unknown, unknown> {
  return (request, response) => {
    // Control bypasses the work queue and does not parse or retain a body.
    response.setHeader('connection', 'close')
    response.once('finish', () => {
      if (!request.complete) request.destroy()
    })
    void Promise.resolve()
      .then(() => action(scope(request)))
      .then(
        () => {
          if (!response.destroyed) response.sendStatus(204)
        },
        error => sendFailure(request, response, error)
      )
  }
}
export function createWorkflowStopHandler(
  admission: CompilerAdmission,
  scope: (request: WorkflowHttpRequest) => WorkflowFilter
): RequestHandler<Params, unknown, unknown> {
  return controlHandler(filter => admission.cancelAndWait(filter), scope)
}
export function createWorkflowResetHandler(
  admission: CompilerAdmission,
  scope: (request: WorkflowHttpRequest) => WorkflowFilter,
  clear: (filter: WorkflowFilter) => Promise<void>
): RequestHandler<Params, unknown, unknown> {
  return controlHandler(
    filter => admission.reset(filter, () => clear(filter)),
    scope
  )
}
