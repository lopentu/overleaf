import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { withSourceFixture } from './SourceInputFixture.ts'
import { executeFilesystemArtifacts } from './PublicationArtifactFixture.ts'
import { openCompilerWorkflow } from '../../../app/js/CompilerWorkflow.ts'
import type { TrustedCompilerProfile } from '../../../app/js/CompileEnvironment.ts'
const projectId = '1234567890abcdef12345678'
const image = `sha256:${'b'.repeat(64)}`
const profile: TrustedCompilerProfile = {
  id: 'workflow-synthetic',
  image,
  aliases: ['workflow-synthetic:2099'],
  variant: 'standard',
  texBinDirectory: '/synthetic/bin',
  tools: {
    latexmk: '/synthetic/latexmk',
    texcount: '/synthetic/texcount',
    synctex: '/synthetic/synctex',
  },
}
const raw = Buffer.from(
  JSON.stringify({
    compile: {
      rootResourcePath: 'main.tex',
      resources: [{ path: 'main.tex', content: 'real synthetic source' }],
      options: { buildId: 'abcdef-123456' },
    },
  })
)
test('one genuine flow joins full source, prepared command, artifact execution, immutable publication, cached GET wordcount and reset', async () => {
  assert.equal(
    typeof openCompilerWorkflow,
    'function',
    'actual workflow orchestration is absent'
  )
  let artifacts = 0,
    wordcounts = 0
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
      const lease = await manager.acquire({ projectId, kind: 'compile' })
      const result = await lease.run(scope => workflow.compile(scope, raw))
      await lease.closed
      assert.equal(artifacts, 1)
      assert.equal(result.buildId, 'abcdef-123456')
      assert.equal(result.outputFiles[0]?.path, 'output.pdf')
      assert.equal(
        await fs.readFile(
          path.join(
            outputRoot,
            projectId,
            'generated-files',
            result.buildId,
            'output.pdf'
          ),
          'utf8'
        ),
        '%PDF-synthetic-fixture'
      )
      assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [])
      const count = await manager.acquire({ projectId, kind: 'wordcount' })
      const counted = await count.run(scope =>
        workflow.wordcount(scope, { mainFile: 'main.tex' })
      )
      await count.closed
      assert.equal(counted.textWords, 3)
      assert.equal(wordcounts, 1)
      await workflow.reset({ projectId })
      const missing = await manager.acquire({ projectId, kind: 'wordcount' })
      await assert.rejects(
        missing.run(scope =>
          workflow.wordcount(scope, { mainFile: 'main.tex' })
        )
      )
      await missing.closed
      assert.equal(wordcounts, 1)
    },
    {
      async run() {
        throw new Error('Generic execution must never be selected')
      },
      async runArtifacts(request) {
        artifacts++
        assert.equal(
          await fs.readFile(
            path.join(request.inputDirectory, 'main.tex'),
            'utf8'
          ),
          'real synthetic source'
        )
        assert.ok(request.preparedInput)
        const pending = request.outputDirectory + '.pending'
        await fs.mkdir(pending, { mode: 0o700 })
        await fs.writeFile(
          path.join(pending, 'output.pdf'),
          '%PDF-synthetic-fixture'
        )
        return await executeFilesystemArtifacts(request)
      },
      async runStdout(request) {
        wordcounts++
        assert.equal(request.timeoutMs, 60000)
        assert.equal(
          await fs.readFile(
            path.join(request.inputDirectory, 'main.tex'),
            'utf8'
          ),
          'real synthetic source'
        )
        return {
          exitCode: 0,
          stdout: Buffer.from('Words in text: 3\n'),
          stderr: Buffer.alloc(0),
        }
      },
    }
  )
})
