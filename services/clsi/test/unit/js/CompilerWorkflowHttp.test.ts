import { PreparedSyncTexInput } from '../../../app/js/PreparedSyncTexInput.ts'
import type { StdoutJobRequest } from '../../../app/js/JobRequest.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { expect, test } from 'vitest'
import { z } from '@overleaf/validation-tools'
import { openCompilerWorkflow } from '../../../app/js/CompilerWorkflow.ts'
import { createCompilerWorkflowRouter } from '../../../app/js/CompilerWorkflowHttp.ts'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import { DockerApiFixture, gate, waitForEvent } from './DockerApiFixture.ts'
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

test('stopping an active compile preserves the cancellation response', async () => {
  const jobStarted = Promise.withResolvers<void>()
  await withSourceFixture(
    async (root, manager) => {
      const outputRoot = path.join(root, 'output')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      const workflow = await openCompilerWorkflow(manager, {
        stagingRoot: path.join(root, 'operations'),
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
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const projectUrl = `http://127.0.0.1:${address.port}/project/${projectId}`
        const compileUrl = projectUrl + '/compile'
        const response = fetch(compileUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            compile: {
              rootResourcePath: 'main.tex',
              resources: [{ path: 'main.tex', content: 'synthetic source' }],
              options: { buildId: 'abcdef-654321' },
            },
          }),
        })
        await Promise.race([
          jobStarted.promise,
          response.then(() => assert.fail('Compile returned before job start')),
        ])
        assert.equal(
          (await fetch(compileUrl + '/stop', { method: 'POST' })).status,
          204
        )
        const cancelled = await response
        assert.equal(cancelled.status, 503)
        assert.deepEqual(await cancelled.json(), {
          compile: {
            status: 'unavailable',
            error: 'CANCELLED',
            outputFiles: [],
          },
        })
        assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
        assert.deepEqual(await fs.readdir(outputRoot), [])
        const absent = await fetch(
          projectUrl + '/build/abcdef-654321/output/output.pdf'
        )
        assert.equal(absent.status, 404)
        assert.deepEqual(await absent.json(), { error: 'OUTPUT_NOT_FOUND' })
      } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    },
    {
      async run() {
        throw new Error('Legacy fallback must not execute')
      },
      async runArtifacts({ signal }) {
        assert.ok(signal)
        jobStarted.resolve()
        if (!signal.aborted)
          await once(signal, 'abort', { signal: AbortSignal.timeout(4000) })
        signal.throwIfAborted()
        assert.fail('The compile job did not receive cancellation')
      },
    }
  )
})

test('compile HTTP publishes collected output after the Docker job releases its resources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-http-job-'))
  const stagingRoot = path.join(root, 'operations')
  const sourceCacheRoot = path.join(root, 'plans')
  const outputRoot = path.join(root, 'output')
  const tex = String.raw`\documentclass{article}
\begin{document}
Synthetic compiler adapter.
\end{document}`
  const pdf = Buffer.from('%PDF-synthetic fixture\n')
  const dockerApi = new DockerApiFixture()
  dockerApi.archiveEntries = { 'main.tex': Buffer.from(tex), 'output.pdf': pdf }
  const app = express()
  const server = http.createServer(app)
  let manager: CompilerAdmission | undefined
  let workerLease: CompilerLease | undefined
  try {
    for (const directory of [stagingRoot, sourceCacheRoot, outputRoot]) {
      await fs.mkdir(directory, { mode: 0o700 })
    }
    const docker = await dockerApi.open()
    workerLease = await CompilerLease.acquire(path.join(root, 'manager.sock'))
    manager = new CompilerAdmission(
      new EphemeralDockerJob(docker, {
        trustedStagingRoot: stagingRoot,
        allowedImages: [image],
        allowedExecutables: [profile.tools.latexmk],
        compilerProfiles: [profile],
      }),
      new OwnedJobReconciler(docker, workerLease),
      { sweepIntervalMs: 60000 }
    )
    await manager.start()
    const workflow = await openCompilerWorkflow(manager, {
      stagingRoot,
      sourceCacheRoot,
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
    const downloadHost = 'http://synthetic.invalid'
    app.use(
      createCompilerWorkflowRouter(manager, workflow, {
        downloadHost,
        outputUrlPrefix: '',
      })
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `/project/${projectId}`
    const origin = `http://127.0.0.1:${address.port}`
    const build = 'abcdef-654321'
    const publishedArtifact = path.join(
      outputRoot,
      projectId,
      'generated-files',
      build,
      'output.pdf'
    )
    const volumeCleanup = gate()
    dockerApi.holds.set('remove-volume', volumeCleanup.promise)
    const compiling = fetch(origin + base + '/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        compile: {
          rootResourcePath: 'main.tex',
          resources: [{ path: 'main.tex', content: tex }],
          options: { buildId: build, compiler: 'pdflatex' },
        },
      }),
    })
    let settled = false
    const markSettled = () => {
      settled = true
    }
    void compiling.then(markSettled, markSettled)
    try {
      await waitForEvent(dockerApi, 'remove-volume')
      assert.equal(dockerApi.ownedContainer, false)
      assert.equal(dockerApi.ownedVolume, true)
      await assert.rejects(fs.lstat(publishedArtifact), { code: 'ENOENT' })
      assert.equal(
        settled,
        false,
        'Compile responded while volume removal was pending'
      )
    } finally {
      volumeCleanup.release()
    }
    const compiled = await compiling
    assert.equal(compiled.status, 200)
    const { compile } = compileView.parse(await compiled.json())
    assert.equal(compile.status, 'success')
    const pdfPath = `${base}/build/${build}/output/output.pdf`
    assert.deepEqual(
      compile.outputFiles.find(file => file.path === 'output.pdf'),
      {
        path: 'output.pdf',
        build,
        url: downloadHost + pdfPath,
      }
    )
    const published = await fetch(origin + pdfPath)
    assert.equal(published.status, 200)
    assert.deepEqual(Buffer.from(await published.arrayBuffer()), pdf)
    assert.deepEqual(await fs.readFile(publishedArtifact), pdf)
    assert.equal(
      compile.outputFiles.some(file => file.path === 'main.tex'),
      false
    )

    expect(dockerApi.containerConfig).toMatchObject({
      Image: image,
      User: '33:33',
      WorkingDir: '/compile',
      Entrypoint: ['/bin/sleep'],
      HostConfig: {
        Memory: 1073741824,
        MemorySwap: 1073741824,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Privileged: false,
        LogConfig: { Type: 'none' },
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777',
          '/home/tex': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777',
        },
        Mounts: [
          {
            Type: 'volume',
            Source: dockerApi.volumeConfig?.Name,
            Target: '/compile',
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
    })
    assert.deepEqual(dockerApi.volumeConfig?.DriverOpts, {
      type: 'tmpfs',
      device: 'tmpfs',
      o: 'size=256m,uid=33,gid=33,mode=0700,nodev,nosuid,noexec',
    })
    expect(dockerApi.execConfig).toMatchObject({
      User: '33:33',
      WorkingDir: '/compile',
      Privileged: false,
      Cmd: [
        '/synthetic/latexmk',
        '-cd',
        '-jobname=output',
        '-auxdir=/compile',
        '-outdir=/compile',
        '-synctex=1',
        '-interaction=batchmode',
        '-time',
        '-f',
        '-pdf',
        '/compile/main.tex',
      ],
    })

    const extract = tar.extract()
    const uploaded: Array<{
      name: string
      owner: number | undefined
      text: string
    }> = []
    extract.on('entry', (header, stream, next) => {
      let content = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        content += chunk
      })
      stream.once('end', () => {
        uploaded.push({ name: header.name, owner: header.uid, text: content })
        next()
      })
    })
    await pipeline(Readable.from([dockerApi.uploaded]), extract)
    assert.deepEqual(uploaded, [{ name: 'main.tex', owner: 33, text: tex }])
    assert.deepEqual(dockerApi.events, [
      'volume',
      'create',
      'start',
      'upload',
      'exec',
      'pause',
      'collect',
      'unpause',
      'remove-container',
      'remove-volume',
    ])
    assert.equal(dockerApi.ownedContainer || dockerApi.ownedVolume, false)
    assert.deepEqual(await fs.readdir(stagingRoot), [])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.resolve()
      .then(() => manager?.retryCleanup())
      .finally(() => manager?.close())
      .finally(() => workerLease?.close())
      .finally(() => dockerApi.close())
      .finally(() => fs.rm(root, { recursive: true, force: true }))
  }
})
