import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import path from 'node:path'
import { test, vi } from 'vitest'
import express from 'express'
import Errors from '../../../app/js/Errors.js'
import { BuildIdConflictError } from '../../../app/js/BuildIdConflictError.ts'

const PROJECT = '1234567890abcdef12345678'
const root = path.resolve(import.meta.dirname, '../../../..')
const web = path.join(root, 'web/app/src')
const webRequire = createRequire(path.join(root, 'web/package.json'))
async function serve(
  handler: http.RequestListener,
  work: (url: string) => Promise<void>
) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await work(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
}
function quiet() {}
function mockDefault(id: string, value: unknown) {
  vi.doMock(id, () => ({ default: value }))
}

// Genuine Express and parser; only the compiler/storage/metrics side effects are
// replaced. The error is the same typed class that the publisher actually emits.
test('the actual controller returns exact build collision HTTP 409 without output/build identity', async () => {
  mockDefault('@overleaf/settings', { apis: { clsi: { outputUrlPrefix: '' } } })
  mockDefault('@overleaf/logger', { debug: quiet, warn: quiet, error: quiet })
  mockDefault('@overleaf/metrics', {
    Timer: class {
      done() {}
    },
  })
  mockDefault('../../../app/js/Errors.js', Errors)
  mockDefault('../../../app/js/ProjectPersistenceManager.js', {
    markProjectAsJustAccessed(_id: string, done: (error?: Error) => void) {
      done()
    },
  })
  mockDefault('../../../app/js/CLSICacheHandler.js', {
    notifyCLSICacheAboutBuild: quiet,
  })
  mockDefault('../../../app/js/CompileManager.js', {
    doCompileWithLock(
      _request: unknown,
      _stats: unknown,
      _timings: unknown,
      done: (error: Error) => void
    ) {
      done(
        Object.assign(new BuildIdConflictError(), {
          message: 'decorated-not-for-client',
          buildId: 'must-not-escape',
          outputFiles: [{ path: 'must-not-escape' }],
        })
      )
    },
  })
  const controllerPath = path.join(
    import.meta.dirname,
    '../../../app/js/CompileController.js'
  )
  const loaded: unknown = await import(controllerPath)
  assert.ok(loaded && typeof loaded === 'object' && 'default' in loaded)
  const controller = loaded.default
  assert.ok(
    controller &&
      typeof controller === 'object' &&
      'compile' in controller &&
      typeof controller.compile === 'function'
  )
  const compile = controller.compile
  const app = express()
  app.use(express.json())
  app.post('/project/:project_id/compile', (req, res, next) => {
    Reflect.apply(compile, controller, [req, res, next])
  })
  await serve(app, async url => {
    const response = await fetch(`${url}/project/${PROJECT}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compile: { resources: [], options: {} } }),
    })
    const body: unknown = await response.json()
    assert.equal(response.status, 409)
    assert.ok(body && typeof body === 'object' && 'compile' in body)
    const compile = body.compile
    assert.ok(compile && typeof compile === 'object')
    assert.ok(
      'status' in compile && 'error' in compile && 'outputFiles' in compile
    )
    assert.equal(compile.status, 'error')
    assert.equal(compile.error, 'build-id-conflict')
    assert.deepEqual(compile.outputFiles, [])
    assert.equal('buildId' in compile, false)
  })
})

for (const status of [
  'collision',
  'generic',
  'missing-updates',
  'wrong-error',
] as const) {
  test(`real web fetch and sendRequest preserves ${status} retry semantics`, async () => {
    let requests = 0
    await serve(
      async (request, response) => {
        for await (const chunk of request) {
          assert.ok(Buffer.isBuffer(chunk))
        }
        requests++
        response.setHeader('content-type', 'application/json')
        if (requests === 1 || status === 'collision') {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              compile:
                status === 'collision'
                  ? {
                      status: 'error',
                      error: 'build-id-conflict',
                      buildId: 'must-not-escape',
                      outputFiles: [{ path: 'must-not-escape' }],
                    }
                  : status === 'missing-updates'
                    ? { status: 'missing-updates', baseHistoryVersion: 1 }
                    : {
                        status: 'error',
                        error:
                          status === 'wrong-error' ? 'different' : undefined,
                      },
            })
          )
        } else
          response.end(
            JSON.stringify({ compile: { status: 'success', outputFiles: [] } })
          )
      },
      async url => {
        const project = {
          _id: PROJECT,
          compiler: 'pdflatex',
          rootDoc_id: 'main',
          overleaf: { history: { id: 1 } },
          rootFolder: [{ docs: [], files: [], folders: [] }],
        }
        const settings = {
          apis: { clsi: { url, standardCompileBackendClass: 'free' } },
          clsiCookie: { key: '' },
          safeCompilers: ['pdflatex'],
          defaultLatexCompiler: 'pdflatex',
        }
        mockDefault(webRequire.resolve('@overleaf/settings'), settings)
        mockDefault(webRequire.resolve('@overleaf/logger'), {
          debug: quiet,
          warn: quiet,
          error: quiet,
        })
        mockDefault(webRequire.resolve('@overleaf/metrics'), {
          Timer: class {
            done() {}
          },
          inc: quiet,
          count: quiet,
          histogram: quiet,
        })
        const mocks: ReadonlyArray<readonly [string, unknown]> = [
          [
            'Features/Project/ProjectGetter.mjs',
            { promises: { getProject: async () => project } },
          ],
          [
            'Features/Project/ProjectEntityHandler.mjs',
            {
              promises: {
                getAllDocs: async () => ({
                  '/main.tex': { _id: 'main', lines: ['synthetic'] },
                }),
                getAllFiles: async () => ({}),
              },
            },
          ],
          [
            'Features/Compile/ClsiCookieManager.mjs',
            () => ({
              promises: {
                getServerId: async () => null,
                setServerId: async () => {},
                clearServerId: async () => {},
              },
            }),
          ],
          [
            'Features/Compile/ClsiStateManager.mjs',
            { computeHash: () => '0123456789abcdef' },
          ],
          [
            'Features/Compile/ClsiFormatChecker.mjs',
            { checkRecoursesForProblems: () => undefined },
          ],
          ['Features/Compile/ClsiCacheHandler.mjs', {}],
          [
            'Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
            {
              promises: {
                flushProjectToMongo: async () => {},
                getProjectDocsIfMatch: async () => ({}),
              },
            },
          ],
          ['Features/History/HistoryManager.mjs', {}],
          ['Features/SplitTests/SplitTestHandler.mjs', {}],
          ['Features/Analytics/AnalyticsManager.mjs', {}],
          [
            'infrastructure/RedisWrapper.mjs',
            {
              client: () => ({
                get: async () => null,
                setex: async () => {},
                del: async () => {},
              }),
            },
          ],
        ]
        for (const [relative, value] of mocks) {
          mockDefault(path.join(web, relative), value)
          mockDefault(await fs.realpath(path.join(web, relative)), value)
        }
        // The copied module is the actual web source in its genuine declared PnP
        // dependency graph. Fetch-utils stays real and reaches only this loopback.
        const managerPath = path.join(web, 'Features/Compile/ClsiManager.mjs')
        const loaded: unknown = await import(managerPath)
        assert.ok(loaded && typeof loaded === 'object' && 'default' in loaded)
        const manager = loaded.default
        assert.ok(
          manager && typeof manager === 'object' && 'promises' in manager
        )
        const promises = manager.promises
        assert.ok(
          promises &&
            typeof promises === 'object' &&
            'sendRequest' in promises &&
            typeof promises.sendRequest === 'function'
        )
        const result: unknown = await Reflect.apply(
          promises.sendRequest,
          promises,
          [
            project,
            PROJECT,
            null,
            { syncType: 'full', compileBackendClass: 'free' },
          ]
        )
        assert.ok(
          result &&
            typeof result === 'object' &&
            'status' in result &&
            'outputFiles' in result &&
            'buildId' in result
        )
        assert.equal(
          result.status,
          status === 'collision' ? 'error' : 'success'
        )
        assert.equal(requests, status === 'collision' ? 1 : 2)
        assert.deepEqual(result.outputFiles, [])
        assert.equal(result.buildId, undefined)
      }
    )
  })
}
