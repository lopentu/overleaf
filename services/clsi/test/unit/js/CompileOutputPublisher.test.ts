import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { openCompileOutputPublisher } from '../../../app/js/CompileOutputPublisher.ts'
import type {
  CompilerAdmission,
  WorkflowScope,
} from '../../../app/js/CompilerAdmission.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const USER = 'abcdef1234567890abcdef12'
const profile = {
  optimiseInDocker: true,
  archiveLogs: false,
  strace: false,
  pdfCaching: false,
  clsiCache: false,
}
const raw = Buffer.from(
  '{"compile":{"resources":[{"path":"main.tex","content":"source"}]}}'
)
async function publisher(
  manager: CompilerAdmission,
  outputRoot: string,
  overrides: Partial<typeof profile> = {}
) {
  return await openCompileOutputPublisher(manager, {
    outputRoot,
    profile: { ...profile, ...overrides },
  })
}
async function prepared(root: string, scope: WorkflowScope) {
  const plan = await parseFullSourcePlan(scope, raw)
  const source = await materializeFullSource(scope, plan, {
    stagingRoot: path.join(root, 'operations'),
  })
  const directory = path.join(source.stagingRoot, 'closed-artifacts')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.mkdir(path.join(directory, 'chapter'), { mode: 0o700 })
  await fs.writeFile(
    path.join(directory, 'output.pdf'),
    Buffer.from([37, 80, 68, 70, 0, 255])
  )
  await fs.writeFile(path.join(directory, 'chapter/文.log'), 'complete log')
  return directory
}

test('a complete bounded artifact tree publishes under its exact logical user/build namespace', async () => {
  await withSourceFixture(async (root, manager) => {
    const outputRoot = path.join(root, 'published')
    await fs.mkdir(outputRoot, { mode: 0o700 })
    const unit = await publisher(manager, outputRoot)
    const lease = await manager.acquire({
      projectId: PROJECT,
      userId: USER,
      kind: 'compile',
    })
    await lease.run(async scope => {
      const outputDirectory = await prepared(root, scope)
      const result = await unit.publish(scope, {
        outputDirectory,
        buildId: 'abcdef-123456',
      })
      assert.ok(result && typeof result === 'object' && 'buildId' in result)
      assert.equal(result.buildId, 'abcdef-123456')
      const build = path.join(
        outputRoot,
        `${PROJECT}-${USER}`,
        'generated-files/abcdef-123456'
      )
      assert.deepEqual(
        await fs.readFile(path.join(build, 'output.pdf')),
        Buffer.from([37, 80, 68, 70, 0, 255])
      )
      assert.equal(
        await fs.readFile(path.join(build, 'chapter/文.log'), 'utf8'),
        'complete log'
      )
    })
    await lease.closed
    assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
  })
})
for (const existing of [
  'same',
  'different',
  'empty-directory',
  'symlink',
] as const) {
  test(`occupied explicit build ID preserves ${existing} target and rejects instead of overwriting`, async () => {
    await withSourceFixture(async (root, manager) => {
      const outputRoot = path.join(root, 'published'),
        parent = path.join(outputRoot, PROJECT, 'generated-files'),
        build = path.join(parent, 'abcdef-123456')
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      if (existing === 'symlink')
        await fs.symlink(path.join(root, 'operations'), build)
      else {
        await fs.mkdir(build, { mode: 0o700 })
        if (existing !== 'empty-directory')
          await fs.writeFile(
            path.join(build, 'output.pdf'),
            existing === 'same'
              ? Buffer.from([37, 80, 68, 70, 0, 255])
              : Buffer.from('old build')
          )
      }
      const before = await fs.lstat(build),
        unit = await publisher(manager, outputRoot)
      const lease = await manager.acquire({
        projectId: PROJECT,
        kind: 'compile',
      })
      await lease.run(async scope => {
        await assert.rejects(
          unit.publish(scope, {
            outputDirectory: await prepared(root, scope),
            buildId: 'abcdef-123456',
          }),
          { name: 'BuildIdConflictError', message: 'build-id-conflict' }
        )
      })
      const after = await fs.lstat(build)
      assert.equal(after.ino, before.ino)
      if (existing === 'different')
        assert.equal(
          await fs.readFile(path.join(build, 'output.pdf'), 'utf8'),
          'old build'
        )
      if (existing === 'empty-directory')
        assert.deepEqual(await fs.readdir(build), [])
      if (existing === 'symlink')
        assert.equal(await fs.readlink(build), path.join(root, 'operations'))
    })
  })
}
for (const overrides of [
  { optimiseInDocker: false },
  { archiveLogs: true },
  { strace: true },
  { pdfCaching: true },
  { clsiCache: true },
]) {
  test(`an unsupported optional profile fails before any publication: ${Object.keys(overrides)[0]}`, async () => {
    await withSourceFixture(async (root, manager) => {
      const outputRoot = path.join(root, 'published')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      await assert.rejects(publisher(manager, outputRoot, overrides), {
        code: 'PUBLICATION_UNSUPPORTED',
      })
      assert.deepEqual(await fs.readdir(outputRoot), [])
    })
  })
}

test('publication refuses a still-running actual scope job and accepts only its settled complete bytes', async () => {
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>()
  await withSourceFixture(
    async (root, manager) => {
      const outputRoot = path.join(root, 'published')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      const unit = await publisher(manager, outputRoot),
        lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
      await lease.run(async scope => {
        const plan = await parseFullSourcePlan(scope, raw)
        const source = await materializeFullSource(scope, plan, {
          stagingRoot: path.join(root, 'operations'),
        })
        const directory = path.join(source.stagingRoot, 'job-output')
        const job = scope.runArtifacts({
          image: `sha256:${'a'.repeat(64)}`,
          argv: ['/usr/bin/pdflatex'],
          cwd: '/compile',
          inputDirectory: source.sourceDirectory,
          outputDirectory: directory,
          timeoutMs: 1000,
        })
        void job.catch(() => {})
        try {
          await entered.promise
          await assert.rejects(
            unit.publish(scope, {
              outputDirectory: directory,
              buildId: 'abcdef-123456',
            }),
            { code: 'INVALID_SOURCE_REQUEST' }
          )
          assert.deepEqual(
            await fs.readdir(outputRoot),
            [],
            'partial scope-job bytes entered the published namespace'
          )
        } finally {
          held.resolve()
          await job
        }
        await unit.publish(scope, {
          outputDirectory: directory,
          buildId: 'abcdef-123456',
        })
        assert.equal(
          await fs.readFile(
            path.join(
              outputRoot,
              PROJECT,
              'generated-files/abcdef-123456/output.pdf'
            ),
            'utf8'
          ),
          'partial-complete'
        )
      })
    },
    {
      async run() {
        throw new Error('generic execution is not used by this fixture')
      },
      async runArtifacts(request) {
        await fs.mkdir(request.outputDirectory, { mode: 0o700 })
        const file = path.join(request.outputDirectory, 'output.pdf')
        await fs.writeFile(file, 'partial')
        entered.resolve()
        await held.promise
        await fs.appendFile(file, '-complete')
        const one = { entries: 2, files: 1, bytes: 16 },
          original = { entries: 2, files: 1, bytes: 6 }
        return {
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          outputDirectory: request.outputDirectory,
          output: {
            original,
            generated: one,
            retained: one,
            namespaceEntries: 2,
          },
        }
      },
    }
  )
})

for (const mode of [
  'configuration-getter',
  'missing-root',
  'request-getter',
] as const) {
  test(`publication sanitizes ${mode} failures before returning diagnostics`, async () => {
    await withSourceFixture(async (root, manager) => {
      const marker = 'synthetic-private-publication-marker',
        outputRoot = path.join(root, 'published')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      let error: unknown
      if (mode === 'configuration-getter') {
        try {
          await openCompileOutputPublisher(manager, {
            get outputRoot(): string {
              throw new Error(marker)
            },
            profile,
          })
        } catch (failure) {
          error = failure
        }
      } else if (mode === 'missing-root') {
        try {
          await openCompileOutputPublisher(manager, {
            outputRoot: path.join(root, marker),
            profile,
          })
        } catch (failure) {
          error = failure
        }
      } else {
        const unit = await publisher(manager, outputRoot),
          lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
        await lease.run(async scope => {
          await prepared(root, scope)
          try {
            await unit.publish(scope, {
              get outputDirectory(): string {
                throw new Error(marker)
              },
              buildId: 'abcdef-123456',
            })
          } catch (failure) {
            error = failure
          }
        })
      }
      assert.ok(error instanceof Error)
      assert.equal('code' in error && error.code, 'INVALID_PUBLICATION')
      assert.equal(
        String(error).includes(marker),
        false,
        'source-bearing diagnostic escaped'
      )
      assert.equal('cause' in error, false, 'original error cause escaped')
      assert.deepEqual(await fs.readdir(outputRoot), [])
    })
  })
}
test('a stdout wordcount workflow cannot publish an artifact tree as a compile build', async () => {
  await withSourceFixture(async (root, manager) => {
    const outputRoot = path.join(root, 'published')
    await fs.mkdir(outputRoot, { mode: 0o700 })
    const unit = await publisher(manager, outputRoot),
      lease = await manager.acquire({ projectId: PROJECT, kind: 'wordcount' })
    await lease.run(async scope => {
      await assert.rejects(
        unit.publish(scope, {
          outputDirectory: await prepared(root, scope),
          buildId: 'abcdef-123456',
        }),
        { code: 'INVALID_PUBLICATION' }
      )
    })
    assert.deepEqual(await fs.readdir(outputRoot), [])
  })
})
