import { PreparedSyncTexInput } from '../../../app/js/PreparedSyncTexInput.ts'
import type { StdoutJobRequest } from '../../../app/js/JobRequest.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { test } from 'vitest'
import { z } from '@overleaf/validation-tools'
import { openCompilerWorkflow } from '../../../app/js/CompilerWorkflow.ts'
import { createCompilerWorkflowRouter } from '../../../app/js/CompilerWorkflowHttp.ts'
import {
  validateRequest,
  validateStdoutRequest,
} from '../../../app/js/JobRequest.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
import { executeFilesystemArtifacts } from './PublicationArtifactFixture.ts'
import type { TrustedCompilerProfile } from '../../../app/js/CompileEnvironment.ts'
const projectId = '1234567890abcdef12345678',
  image = `sha256:${'c'.repeat(64)}`
const profile: TrustedCompilerProfile = {
  id: 'http-synthetic',
  image,
  aliases: ['http-synthetic:2099'],
  variant: 'standard',
  texBinDirectory: '/synthetic/bin',
  tools: {
    latexmk: '/synthetic/latexmk',
    texcount: '/synthetic/texcount',
    synctex: '/synthetic/synctex',
  },
}
const compileView = z.object({
  compile: z.object({
    status: z.string(),
    outputFiles: z.array(
      z.object({ path: z.string(), build: z.string(), url: z.string() })
    ),
  }),
})
test('actual workflow HTTP routes preserve compile URLs/conflicts, cached GET and POST wordcount, and owned reset', async () => {
  let trustedStagingRoot = '',
    jobs = 0
  let expired: StdoutJobRequest | undefined
  const policy = () => ({
    trustedStagingRoot,
    allowedImages: [image],
    allowedExecutables: [
      profile.tools.latexmk,
      profile.tools.texcount,
      profile.tools.synctex,
    ],
    compilerProfiles: [profile],
  })
  await withSourceFixture(
    async (root, manager) => {
      trustedStagingRoot = path.join(root, 'operations')
      const outputRoot = path.join(root, 'output')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      const workflow = await openCompilerWorkflow(manager, {
        stagingRoot: trustedStagingRoot,
        sourceCacheRoot: path.join(root, 'plans'),
        outputRoot,
        defaultImage: image,
        profiles: [profile],
        publication: {
          optimiseInDocker: true,
          archiveLogs: false,
          strace: false,
          pdfCaching: false,
          clsiCache: false,
        },
      })
      const app = express()
      app.use(
        createCompilerWorkflowRouter(manager, workflow, {
          downloadHost: 'http://synthetic.invalid',
          outputUrlPrefix: '',
        })
      )
      const server = http.createServer(app)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const origin = 'http://127.0.0.1:' + address.port,
        base = '/project/' + projectId
      const body = JSON.stringify({
        compile: {
          rootResourcePath: 'main.tex',
          resources: [{ path: 'main.tex', content: 'synthetic source' }],
          options: { buildId: 'abcdef-654321' },
        },
      })
      try {
        const compiled = await fetch(origin + base + '/compile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        assert.equal(compiled.status, 200)
        const result = compileView.parse(await compiled.json())
        assert.equal(result.compile.status, 'success')
        assert.deepEqual(
          result.compile.outputFiles
            .filter(file => file.path === 'output.pdf')
            .map(file => [file.path, file.build, file.url]),
          [
            [
              'output.pdf',
              'abcdef-654321',
              'http://synthetic.invalid' +
                base +
                '/build/abcdef-654321/output/output.pdf',
            ],
          ]
        )
        const pdf = await fetch(
          origin + base + '/build/abcdef-654321/output/output.pdf',
          { headers: { range: 'bytes=0-3' } }
        )
        assert.equal(pdf.status, 206)
        assert.equal(await pdf.text(), '%PDF')
        assert.equal(pdf.headers.get('content-type'), 'application/pdf')
        const html = await fetch(
          origin + base + '/build/abcdef-654321/output/output.html'
        )
        assert.equal(html.status, 200)
        assert.equal(
          html.headers.get('content-type'),
          'application/octet-stream'
        )
        assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
        assert.equal(html.headers.get('x-frame-options'), 'SAMEORIGIN')
        const zip = await fetch(
          origin + base + '/build/abcdef-654321/output/output.zip'
        )
        assert.equal(zip.status, 200)
        const zipBytes = Buffer.from(await zip.arrayBuffer())
        assert.deepEqual(
          zipBytes.subarray(0, 4),
          Buffer.from([0x50, 0x4b, 3, 4])
        )
        assert.equal(zipBytes.includes(Buffer.from('output.log')), true)
        assert.equal(zipBytes.includes(Buffer.from('output.pdf')), false)
        const collision = await fetch(origin + base + '/compile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        assert.equal(collision.status, 409)
        assert.deepEqual(await collision.json(), {
          compile: {
            status: 'error',
            error: 'build-id-conflict',
            outputFiles: [],
          },
        })
        const counted = await fetch(origin + base + '/wordcount?file=main.tex')
        assert.equal(counted.status, 200)
        assert.equal((await counted.text()).includes('"textWords":3'), true)
        const postCount = await fetch(
          origin + base + '/wordcount?file=main.tex',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }
        )
        assert.equal(postCount.status, 200)
        assert.equal((await postCount.text()).includes('"textWords":3'), true)
        const view = await fetch(
          origin +
            base +
            '/sync/code?file=' +
            encodeURIComponent('nested/文.tex') +
            '&line=4&column=2&buildId=abcdef-654321'
        )
        assert.equal(view.status, 200)
        assert.deepEqual(await view.json(), {
          pdf: [{ page: 1, h: 2, v: 3, width: 4, height: 5 }],
          downloadedFromCache: false,
        })
        const edit = await fetch(
          origin + base + '/sync/pdf?page=1&h=2&v=3&buildId=abcdef-654321'
        )
        assert.equal(edit.status, 200)
        assert.deepEqual(await edit.json(), {
          code: [{ file: 'nested/文.tex', line: 4, column: 2 }],
          downloadedFromCache: false,
        })
        assert.ok(expired)
        await assert.rejects(validateStdoutRequest(expired, policy()))
        const reset = await fetch(origin + base, { method: 'DELETE' })
        assert.equal(reset.status, 204)
        const missing = await fetch(origin + base + '/wordcount?file=main.tex')
        assert.equal(missing.status, 404)
        assert.equal(jobs, 6)
        assert.deepEqual(await fs.readdir(trustedStagingRoot), [])
      } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    },
    {
      async run() {
        throw new Error('Legacy/generic fallback must not execute')
      },
      async runArtifacts(request) {
        await validateRequest(request, policy())
        jobs++
        await fs.mkdir(request.outputDirectory + '.pending', { mode: 0o700 })
        await fs.writeFile(
          path.join(request.outputDirectory + '.pending', 'output.pdf'),
          '%PDF-fixture'
        )
        await fs.writeFile(
          path.join(request.outputDirectory + '.pending', 'output.log'),
          'synthetic log'
        )
        await fs.writeFile(
          path.join(request.outputDirectory + '.pending', 'output.html'),
          '<p>synthetic</p>'
        )
        await fs.writeFile(
          path.join(request.outputDirectory + '.pending', 'output.synctex.gz'),
          'synthetic-only'
        )
        return await executeFilesystemArtifacts(request)
      },
      async runStdout(request) {
        await validateStdoutRequest(request, policy())
        if (request.argv[0] === profile.tools.synctex) {
          assert.ok(request.preparedInput instanceof PreparedSyncTexInput)
          await assert.rejects(
            validateStdoutRequest(
              { ...request, preparedInput: { ...request.preparedInput } },
              policy()
            )
          )
          await assert.rejects(
            validateStdoutRequest(
              { ...request, preparedInput: undefined },
              policy()
            )
          )
          await assert.rejects(
            validateStdoutRequest(
              { ...request, argv: [...request.argv, '-extra'] },
              policy()
            )
          )
          await assert.rejects(
            validateStdoutRequest({ ...request, timeoutMs: 60001 }, policy())
          )
          await assert.rejects(
            validateStdoutRequest(
              {
                ...request,
                inputDirectory: path.join(
                  path.dirname(request.inputDirectory),
                  'other'
                ),
              },
              policy()
            )
          )
          assert.deepEqual(
            request.argv,
            request.argv[1] === 'view'
              ? [
                  profile.tools.synctex,
                  'view',
                  '-i',
                  '4:2:/compile/nested/文.tex',
                  '-o',
                  '/compile/output.pdf',
                ]
              : [
                  profile.tools.synctex,
                  'edit',
                  '-o',
                  '1:2:3:/compile/output.pdf',
                ]
          )
          expired = request
        }

        jobs++
        const output =
          request.argv[0] !== profile.tools.synctex
            ? 'Words in text: 3\n'
            : request.argv[1] === 'view'
              ? 'Output:/compile/output.pdf\nPage:1\nh:2\nv:3\nW:4\nH:5\n'
              : 'Output:/compile/output.pdf\nInput:/compile/nested/文.tex\nLine:4\nColumn:2\n'
        return {
          exitCode: 0,
          stdout: Buffer.from(output),
          stderr: Buffer.alloc(0),
        }
      },
    }
  )
})
