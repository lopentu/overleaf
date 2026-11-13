import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { openCompileOutputPublisher } from '../../../app/js/CompileOutputPublisher.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import {
  withPublicationFixture,
  completePublicationArtifacts,
  executeFilesystemArtifacts,
} from './PublicationArtifactFixture.ts'
import type { JobRequest } from '../../../app/js/JobRequest.ts'
const PROJECT = '1234567890abcdef12345678'
const profile = {
  optimiseInDocker: true,
  archiveLogs: false,
  strace: false,
  pdfCaching: false,
  clsiCache: false,
}
const input = Buffer.from(
  '{"compile":{"resources":[{"path":"main.tex","content":"source"},{"path":"output.pdf","content":"unchanged original input"}]}}'
)

for (const mode of [
  'no-job',
  'wrong-source',
  'generic',
  'stdout',
  'failed',
  'wrong-result-path',
  'inflight-artifacts',
  'inflight-stdout',
] as const) {
  test(`only the current completed artifact job authorizes publication: ${mode}`, async () => {
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>()
    let calls = 0
    await withPublicationFixture(
      async (root, manager) => {
        const outputRoot = path.join(root, 'published')
        await fs.mkdir(outputRoot, { mode: 0o700 })
        const unit = await openCompileOutputPublisher(manager, {
            outputRoot,
            profile,
          }),
          lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
        let publicationRejected = false,
          callbackFinished = false,
          positive = false,
          workError: unknown
        const work = lease.run(async scope => {
          const plan = await parseFullSourcePlan(scope, input)
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          const artifacts = path.join(source.stagingRoot, 'artifacts')
          await fs.mkdir(artifacts, { mode: 0o700 })
          await fs.writeFile(
            path.join(artifacts, 'output.pdf'),
            'generated artifact'
          )
          if (mode !== 'no-job')
            await completePublicationArtifacts(
              scope,
              source.sourceDirectory,
              artifacts
            )
          const next = path.join(source.stagingRoot, 'next-artifacts')
          const job = {
            image: `sha256:${'a'.repeat(64)}`,
            argv: ['/usr/bin/pdflatex'],
            cwd: '/compile',
            inputDirectory: source.sourceDirectory,
            outputDirectory: next,
            timeoutMs: 1000,
          }
          let running: Promise<unknown> | undefined
          if (mode === 'generic') await scope.runJob(job)
          else if (mode === 'stdout' || mode === 'inflight-stdout') {
            const request = {
              image: job.image,
              argv: ['/usr/bin/texcount'],
              cwd: job.cwd,
              inputDirectory: job.inputDirectory,
              timeoutMs: job.timeoutMs,
            }
            if (mode === 'stdout') await scope.runStdout(request)
            else running = scope.runStdout(request)
          } else if (
            mode === 'failed' ||
            mode === 'wrong-result-path' ||
            mode === 'inflight-artifacts'
          ) {
            await fs.mkdir(next, { mode: 0o700 })
            await fs.writeFile(path.join(next, 'output.pdf'), 'next artifact')
            const second = completePublicationArtifacts(
              scope,
              source.sourceDirectory,
              next
            )
            if (mode === 'inflight-artifacts') running = second
            else await assert.rejects(second)
          }
          try {
            if (running) await entered.promise
            const directory =
              mode === 'no-job' || mode === 'wrong-source'
                ? source.sourceDirectory
                : artifacts
            try {
              await unit.publish(scope, {
                outputDirectory: directory,
                buildId: 'abcdef-123456',
              })
            } catch (error) {
              assert.ok(
                error instanceof Error &&
                  'code' in error &&
                  error.code === 'INVALID_SOURCE_REQUEST'
              )
              publicationRejected = true
            }
            assert.deepEqual(await fs.readdir(outputRoot), [])
          } finally {
            held.resolve()
            await running
          }
          if (mode === 'wrong-source') {
            const result = await unit.publish(scope, {
              outputDirectory: artifacts,
              buildId: 'abcdef-123457',
            })
            positive =
              (await fs.readFile(
                path.join(
                  outputRoot,
                  PROJECT,
                  'generated-files',
                  result.buildId,
                  'output.pdf'
                ),
                'utf8'
              )) === 'generated artifact'
          }
          callbackFinished = true
        })
        try {
          await work
        } catch (error) {
          workError = error
        }
        held.resolve()
        // These checks are outside any expected failed-job rejection so an inner
        // assertion cannot be swallowed as the expected workflow failure.
        assert.equal(callbackFinished, true)
        assert.equal(
          publicationRejected,
          true,
          'publication accepted absent/stale/wrong artifact authority'
        )
        if (mode === 'wrong-source') assert.equal(positive, true)
        if (mode === 'failed' || mode === 'wrong-result-path')
          assert.ok(workError)
        else assert.equal(workError, undefined)
      },
      {
        async run(request) {
          await fs.mkdir(request.outputDirectory, { mode: 0o700 })
          await fs.writeFile(
            path.join(request.outputDirectory, 'output.pdf'),
            'generic output'
          )
          return {
            exitCode: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            outputDirectory: request.outputDirectory,
            output: { entries: 2, files: 1, bytes: 14 },
          }
        },
        async runStdout(request) {
          await fs.readFile(path.join(request.inputDirectory, 'main.tex'))
          if (mode === 'inflight-stdout') {
            entered.resolve()
            await held.promise
          }
          return {
            exitCode: 0,
            stdout: Buffer.from('1'),
            stderr: Buffer.alloc(0),
          }
        },
        async runArtifacts(request: JobRequest) {
          calls++
          if (calls > 1 && mode === 'failed')
            throw new Error('synthetic rejected artifact execution')
          if (calls > 1 && mode === 'inflight-artifacts') {
            entered.resolve()
            await held.promise
          }
          const result = await executeFilesystemArtifacts(request)
          return calls > 1 && mode === 'wrong-result-path'
            ? { ...result, outputDirectory: request.inputDirectory }
            : result
        },
      }
    )
  })
}
