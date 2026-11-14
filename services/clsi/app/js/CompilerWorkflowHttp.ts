import express from 'express'
import { z, zz } from '@overleaf/validation-tools'
import {
  AdmissionError,
  type CompilerAdmission,
  type WorkflowMetadata,
} from './CompilerAdmission.ts'
import type { CompilerWorkflow } from './CompilerWorkflow.ts'
import {
  createWorkflowJsonHandler,
  createWorkflowReadHandler,
  createWorkflowControlHandler,
  type WorkflowHttpRequest,
  type WorkflowHttpResult,
} from './WorkflowAdmissionHttp.ts'
import { SourceInputError } from './SourceInputError.ts'
import Errors from './Errors.js'
import { OutputReadError } from './PublishedOutputReader.ts'

interface ResponseConfiguration {
  downloadHost: string
  outputUrlPrefix: string
}
const params = z.strictObject({
  project_id: zz.objectId().or(zz.submissionId()),
  user_id: zz.objectId().optional(),
})
const wordcount = z.strictObject({
  file: zz.filepath().default('main.tex'),
  image: z.string().optional(),
  compileBackendClass: zz.compileBackendClass().optional(),
  compileGroup: zz.compileGroup().optional(),
  clsiserverid: zz.clsiServerId().optional(),
})
function responseFor(request: WorkflowHttpRequest) {
  const response = request.res
  if (response === undefined) throw new Error('Missing workflow response')
  return response
}
function logical(request: WorkflowHttpRequest) {
  const value = params.parse({
    project_id: request.params.project_id,
    ...(request.params.user_id === undefined
      ? {}
      : { user_id: request.params.user_id }),
  })
  return {
    projectId: value.project_id,
    ...(value.user_id === undefined ? {} : { userId: value.user_id }),
  }
}
function failure(
  error: unknown,
  kind: 'compile' | 'wordcount'
): WorkflowHttpResult {
  const collision = Errors.buildIdConflictResponse(error)
  if (collision) return { statusCode: 409, body: collision }
  let statusCode = 500,
    status = 'error',
    code = 'WORKFLOW_FAILED'
  let baseHistoryVersion: number | undefined
  if (error instanceof AdmissionError) {
    statusCode =
      error.code === 'PROJECT_BUSY'
        ? 423
        : error.code === 'INVALID_REQUEST'
          ? 400
          : 503
    status =
      statusCode === 423
        ? 'compile-in-progress'
        : statusCode === 503
          ? 'unavailable'
          : 'error'
    code = error.code
  } else if (error instanceof Errors.FilesOutOfSyncError) {
    statusCode = 409
    status = 'conflict'
    code = 'FULL_SOURCE_REQUIRED'
  } else if (error instanceof Errors.MissingUpdatesError) {
    statusCode = 409
    status = 'missing-updates'
    code = 'FULL_SOURCE_REQUIRED'
    const info = error.info
    if (
      info !== undefined &&
      'baseHistoryVersion' in info &&
      typeof info.baseHistoryVersion === 'number'
    )
      baseHistoryVersion = info.baseHistoryVersion
  } else if (error instanceof Errors.NotFoundError) {
    statusCode = 404
    code = 'NOT_FOUND'
  } else if (error instanceof SourceInputError) {
    statusCode =
      error.code === 'INPUT_LIMIT'
        ? 413
        : error.code === 'INVALID_SOURCE_REQUEST'
          ? 400
          : error.code === 'SOURCE_CACHE_CAPACITY'
            ? 503
            : 500
    code = error.code
  } else if (error instanceof OutputReadError) {
    statusCode =
      error.code === 'OUTPUT_NOT_FOUND'
        ? 404
        : error.code === 'INVALID_OUTPUT'
          ? 400
          : 500
    code = error.code
  } else if (error instanceof z.ZodError) {
    statusCode = 400
    code = 'INVALID_REQUEST'
  } else if (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    [400, 413, 415].includes(error.status)
  ) {
    statusCode = error.status
    code = 'INVALID_BODY'
  }
  return {
    statusCode,
    body:
      kind === 'compile'
        ? {
            compile: {
              status,
              error: code,
              outputFiles: [],
              ...(baseHistoryVersion === undefined
                ? {}
                : { baseHistoryVersion }),
            },
          }
        : baseHistoryVersion === undefined
          ? { error: code }
          : { baseHistoryVersion },
  }
}
/** Real internal workflow routes. Runtime construction/qualification is a separate
 * startup boundary; this factory never creates a Docker client or legacy fallback. */
export function createCompilerWorkflowRouter(
  manager: CompilerAdmission,
  workflow: CompilerWorkflow,
  configuration: ResponseConfiguration
) {
  const { downloadHost, outputUrlPrefix } = configuration
  const host = new URL(downloadHost)
  if (
    !['http:', 'https:'].includes(host.protocol) ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    typeof outputUrlPrefix !== 'string'
  )
    throw new Error('Invalid compiler response configuration')
  const router = express.Router()
  for (const base of [
    '/project/:project_id',
    '/project/:project_id/user/:user_id',
  ]) {
    const metadata = (
      request: WorkflowHttpRequest,
      kind: WorkflowMetadata['kind']
    ) => ({ ...logical(request), kind })
    router.post(
      base + '/compile',
      createWorkflowJsonHandler(
        manager,
        request => metadata(request, 'compile'),
        async (_request, scope, decodedBytes) => {
          const result = await workflow.compile(scope, decodedBytes)
          const status =
            result.check === 'validate'
              ? `validation-${result.exitCode === 0 ? 'pass' : 'fail'}`
              : result.exitCode === 0 &&
                  result.outputFiles.some(
                    file => file.path === 'output.pdf' && (file.size ?? 0) > 0
                  )
                ? 'success'
                : result.stopOnFirstError
                  ? 'stopped-on-first-error'
                  : 'failure'
          const prefix =
            downloadHost +
            '/project/' +
            scope.metadata.projectId +
            (scope.metadata.userId === undefined
              ? ''
              : '/user/' + scope.metadata.userId)
          return {
            statusCode: 200,
            body: {
              compile: {
                status,
                stats: {},
                timings: {},
                buildId: result.buildId,
                ...(result.baseHistoryVersion === undefined
                  ? {}
                  : { baseHistoryVersion: result.baseHistoryVersion }),
                outputUrlPrefix,
                outputFiles: result.outputFiles.map(file => ({
                  ...file,
                  url: prefix + '/build/' + file.build + '/output/' + file.path,
                })),
              },
            },
          }
        },
        { failureResponse: error => failure(error, 'compile') }
      )
    )
    router.get(
      base + '/wordcount',
      createWorkflowReadHandler(
        manager,
        request => metadata(request, 'wordcount'),
        async (request, scope) => {
          const query = wordcount.parse(request.query)
          return {
            statusCode: 200,
            body: {
              texcount: await workflow.wordcount(scope, {
                mainFile: query.file,
                ...(query.image === undefined ? {} : { image: query.image }),
              }),
            },
          }
        },
        { failureResponse: error => failure(error, 'wordcount') }
      )
    )
    router.post(
      base + '/wordcount',
      createWorkflowJsonHandler(
        manager,
        request => metadata(request, 'wordcount'),
        async (request, scope, decodedBytes) => {
          const query = wordcount.parse(request.query)
          return {
            statusCode: 200,
            body: {
              texcount: await workflow.wordcount(
                scope,
                {
                  mainFile: query.file,
                  ...(query.image === undefined ? {} : { image: query.image }),
                },
                decodedBytes
              ),
            },
          }
        },
        { failureResponse: error => failure(error, 'wordcount') }
      )
    )
    for (const kind of ['code', 'pdf'])
      router.get(
        base + '/sync/' + kind,
        createWorkflowReadHandler(
          manager,
          request => metadata(request, 'output-read'),
          async (request, scope) => {
            const common = {
              buildId: zz.buildId(),
              imageName: z.string().optional(),
              editorId: z.uuid().optional(),
              compileFromClsiCache: z.stringbool().default(false),
              compileBackendClass: zz.compileBackendClass().optional(),
              compileGroup: zz.compileGroup().optional(),
              clsiserverid: zz.clsiServerId().optional(),
            }
            if (kind === 'code') {
              const query = z
                .strictObject({
                  ...common,
                  file: zz.filepath(),
                  line: z.coerce.number().int(),
                  column: z.coerce.number().int(),
                })
                .parse(request.query)
              if (query.compileFromClsiCache)
                throw new SourceInputError(
                  'INVALID_SOURCE_REQUEST',
                  'unsupported-cache'
                )
              return {
                statusCode: 200,
                body: await workflow.synctex(
                  scope,
                  query.buildId,
                  {
                    kind: 'code',
                    file: query.file,
                    line: query.line,
                    column: query.column,
                  },
                  query.imageName
                ),
              }
            }
            const query = z
              .strictObject({
                ...common,
                page: z.coerce.number().int(),
                h: z.coerce.number().finite(),
                v: z.coerce.number().finite(),
              })
              .parse(request.query)
            if (query.compileFromClsiCache)
              throw new SourceInputError(
                'INVALID_SOURCE_REQUEST',
                'unsupported-cache'
              )
            return {
              statusCode: 200,
              body: await workflow.synctex(
                scope,
                query.buildId,
                { kind: 'pdf', page: query.page, h: query.h, v: query.v },
                query.imageName
              ),
            }
          },
          { failureResponse: error => failure(error, 'wordcount') }
        )
      )
    router.get(
      base + '/build/:build_id/output/output.zip',
      createWorkflowReadHandler(
        manager,
        request => metadata(request, 'output-read'),
        async (request, scope) => {
          const buildId = zz.buildId().parse(request.params.build_id)
          await workflow.reader.zip(scope, buildId, responseFor(request))
          return { statusCode: 204, body: undefined }
        },
        { failureResponse: error => failure(error, 'wordcount') }
      )
    )
    router.get(
      base + '/build/:build_id/output/*',
      createWorkflowReadHandler(
        manager,
        request => metadata(request, 'output-read'),
        async (request, scope) => {
          const buildId = zz.buildId().parse(request.params.build_id),
            name = zz.filepath().parse(request.params['0'])
          await workflow.reader.file(
            scope,
            buildId,
            name,
            request,
            responseFor(request)
          )
          return { statusCode: 204, body: undefined }
        },
        { failureResponse: error => failure(error, 'wordcount') }
      )
    )
    router.post(
      base + '/compile/stop',
      createWorkflowControlHandler(filter => workflow.stop(filter), logical)
    )
    router.delete(
      base,
      createWorkflowControlHandler(filter => workflow.reset(filter), logical)
    )
    router.all(base + '/status', (_request, response) => {
      response.send('OK')
    })
  }
  // A selected worker never falls through into legacy readers or conversion.
  router.use(['/project', '/convert'], (_request, response) => {
    response.status(503).json({ error: 'ISOLATED_OPERATION_UNSUPPORTED' })
  })
  return router
}
