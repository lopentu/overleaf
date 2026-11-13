import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import Settings from '@overleaf/settings'
import RequestParser from '../../../app/js/RequestParser.js'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import {
  historySourceBlobUrl,
  resolveSourceDownloadUrls,
} from '../../../app/js/SourceDownloadUrls.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
const mode = process.argv[2]
assert.ok(
  mode === 'history-parity' ||
    mode === 'history404' ||
    mode === 'cjs-import' ||
    mode === 'history-sibling-join'
)
if (mode === 'history-sibling-join') {
  const TEXT = '1234567890123456789012345678901234567890',
    RANGE = '3234567890123456789012345678901234567890'
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>()
  let textFailures = 0,
    rangeClosed = false
  const server = http.createServer((req, res) => {
    if (req.url?.includes(RANGE)) {
      res.on('close', () => {
        rangeClosed = true
      })
      res.write('[]')
      entered.resolve()
      void held.promise.then(() => res.end())
      return
    }
    res.statusCode = 500
    res.end('synthetic failure')
    if (++textFailures === 3) entered.resolve()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  Settings.apis.filestore.url = `http://127.0.0.1:${address.port}`
  try {
    await withSourceFixture(async (root, manager) => {
      const lease = await manager.acquire({
        projectId: '1234567890abcdef12345678',
        kind: 'compile',
      })
      let settled = false
      const work = lease
        .run(async scope => {
          const bytes = Buffer.from(
            JSON.stringify({
              compile: {
                options: {
                  syncType: 'history-full',
                  historyId: '1234567890abcdef12345678',
                },
                baseHistoryVersion: 0,
                rawSnapshot: {
                  files: {
                    'main.tex': {
                      hash: TEXT,
                      rangesHash: RANGE,
                      stringLength: 6,
                    },
                  },
                },
                rawChangeOperations: [],
                globalBlobs: [],
              },
            })
          )
          const plan = await parseFullSourcePlan(scope, bytes)
          await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
        })
        .finally(() => {
          settled = true
        })
      void work.catch(() => {})
      try {
        await entered.promise
        for (let i = 0; i < 100 && textFailures < 3; i++) await delay(5)
        assert.equal(textFailures, 3)
        await delay(30)
        assert.equal(
          settled,
          false,
          'failed text load settled before its real ranges sibling stream'
        )
        assert.equal(manager.status().active, 1)
        assert.equal(rangeClosed, false)
      } finally {
        held.resolve()
        await assert.rejects(work)
        await lease.closed
      }
      assert.equal(rangeClosed, true)
    })
  } finally {
    held.resolve()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
} else if (mode === 'cjs-import') {
  const loaded: unknown = createRequire(import.meta.url)(
    '../../../app/js/SourceDownloadUrls.ts'
  )
  assert.ok(
    loaded &&
      typeof loaded === 'object' &&
      'historySourceBlobUrl' in loaded &&
      'resolveSourceDownloadUrls' in loaded
  )
  assert.equal(loaded.historySourceBlobUrl, historySourceBlobUrl)
  assert.equal(loaded.resolveSourceDownloadUrls, resolveSourceDownloadUrls)
  const ordinary = 'http://origin.invalid/a%20b?signature=synthetic'
  assert.deepEqual(
    resolveSourceDownloadUrls(
      ordinary,
      'http://origin.invalid/other?q=x',
      'http://127.0.0.1:1234',
      'perf.invalid'
    ),
    {
      primary: 'http://127.0.0.1:1234/a%20b?signature=synthetic',
      fallback: 'http://127.0.0.1:1234/other?q=x',
    }
  )
  assert.equal(
    resolveSourceDownloadUrls(
      'http://perf.invalid/a?q=x',
      undefined,
      'http://127.0.0.1:1234',
      'perf.invalid'
    ).primary,
    'http://perf.invalid/a?q=x'
  )
} else {
  const requests: string[] = [],
    PROJECT = '1234567890abcdef12345678',
    USER = 'abcdef1234567890abcdef12'
  const TEXT = '1234567890123456789012345678901234567890',
    BINARY = '2234567890123456789012345678901234567890'
  const server = http.createServer((req, res) => {
    requests.push((req.url ?? '').split('?')[0]!)
    if (mode === 'history404') {
      res.statusCode = 404
      res.end('synthetic-private-history-error')
      return
    }
    res.end(
      req.url?.includes(BINARY)
        ? Buffer.from([0, 255, 10])
        : Buffer.from('source')
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  Settings.apis.filestore.url = base
  Settings.apis.clsiPerf.host = `127.0.0.1:${address.port}`
  try {
    await withSourceFixture(async (root, manager) => {
      const contexts =
        mode === 'history404'
          ? [
              {
                historyId: PROJECT,
                globalBlobs: [],
                filestoreBlobPrefix: '',
                clsiPerfVariant: '',
              },
            ]
          : [
              {
                historyId: PROJECT,
                globalBlobs: [],
                filestoreBlobPrefix: '',
                clsiPerfVariant: '',
              },
              {
                historyId: PROJECT,
                globalBlobs: [TEXT, BINARY],
                filestoreBlobPrefix: '',
                clsiPerfVariant: '',
              },
              {
                historyId: PROJECT,
                globalBlobs: [],
                filestoreBlobPrefix: 'specific/prefix',
                clsiPerfVariant: '',
              },
              {
                historyId: PROJECT,
                globalBlobs: [],
                filestoreBlobPrefix: '',
                clsiPerfVariant: 'variant-1',
              },
            ]
      for (let index = 0; index < contexts.length; index++) {
        Settings.path.clsiCacheDir = path.join(root, `legacy-cache-${index}`)
        const context = contexts[index]!
        const snapshot = {
          files: {
            'main.tex': { hash: TEXT, stringLength: 6 },
            ...(mode === 'history404'
              ? {}
              : { 'binary.dat': { hash: BINARY, byteLength: 3 } }),
          },
        }
        const compile = {
          options: { syncType: 'history-full', ...context },
          filestoreBlobPrefix: context.filestoreBlobPrefix,
          rootResourcePath: 'main.tex',
          baseHistoryVersion: 0,
          globalBlobs: context.globalBlobs,
          rawSnapshot: snapshot,
          rawChangeOperations: [],
          resources: [],
        }
        const lease = await manager.acquire({
          projectId: PROJECT,
          userId: USER,
          kind: 'compile',
        })
        requests.length = 0
        const fresh = lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            Buffer.from(JSON.stringify({ compile }))
          )
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          assert.equal(
            await fs.readFile(
              path.join(source.sourceDirectory, 'main.tex'),
              'utf8'
            ),
            'source'
          )
          assert.deepEqual(
            await fs.readFile(path.join(source.sourceDirectory, 'binary.dat')),
            Buffer.from([0, 255, 10])
          )
        })
        if (mode === 'history404') {
          await assert.rejects(fresh, error => {
            assert.ok(error instanceof Error)
            assert.equal('cause' in error, false)
            assert.equal(
              String(error).includes('synthetic-private-history-error'),
              false
            )
            return error.name === 'NotFoundError'
          })
          assert.equal(requests.length, 1)
        } else await fresh
        const freshRequests = [...requests]
        const compileDir = path.join(root, `legacy-${index}`)
        await fs.mkdir(compileDir, { mode: 0o700 })
        requests.length = 0
        // Real HistoryResourceWriter callsite, cache and URL forwarding. Only
        // synthetic local blob service and private legacy cache are configured.
        // The legacy JS graph is checked separately under the unchanged backend
        // policy. This native boundary validates its real runtime export.
        const history: unknown = await import(
          new URL('../../../app/js/HistoryResourceWriter.js', import.meta.url)
            .href
        )
        assert.ok(
          history &&
            typeof history === 'object' &&
            'syncResourcesToDisk' in history &&
            typeof history.syncResourcesToDisk === 'function'
        )
        const request: unknown = await new Promise<unknown>((resolve, reject) =>
          RequestParser.parse({ compile }, (error: unknown, result: unknown) =>
            error == null ? resolve(result) : reject(error)
          )
        )
        assert.ok(request && typeof request === 'object')
        const legacy: unknown = history.syncResourcesToDisk(
          PROJECT,
          USER,
          {
            ...request,
            populateClsiCache: false,
            png2pdf: false,
            draft: false,
          },
          compileDir,
          {},
          {}
        )
        assert.ok(legacy instanceof Promise)
        if (mode === 'history404')
          await assert.rejects(legacy, { name: 'NotFoundError' })
        else {
          await legacy
          assert.equal(
            await fs.readFile(path.join(compileDir, 'main.tex'), 'utf8'),
            'source'
          )
          assert.deepEqual(
            await fs.readFile(path.join(compileDir, 'binary.dat')),
            Buffer.from([0, 255, 10])
          )
        }
        assert.deepEqual([...requests].sort(), freshRequests.sort())
        const expected = historySourceBlobUrl(
          base,
          Settings.apis.clsiPerf.host,
          TEXT,
          context
        )
        assert.ok(requests.includes(expected.pathname))
      }
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
}
console.log(`${mode} native source compatibility PASS`)
