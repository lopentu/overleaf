import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, vi } from 'vitest'
import OutputCacheManager from '../../../app/js/OutputCacheManager.js'
import { openCompileOutputPublisher } from '../../../app/js/CompileOutputPublisher.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
} from '../../../app/js/FreshCompileInput.ts'
import {
  withPublicationFixture as withSourceFixture,
  completePublicationArtifacts,
} from './PublicationArtifactFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const profile = {
  optimiseInDocker: true,
  archiveLogs: false,
  strace: false,
  pdfCaching: false,
  clsiCache: false,
}
for (const mode of [
  'file-limit',
  'total-limit',
  'entry-limit',
  'hidden-total',
  'symlink',
  'hardlink',
  'filtered-response',
  'snapshot',
] as const) {
  test(`bounded real filesystem publication: ${mode}`, async () => {
    await withSourceFixture(async (root, manager) => {
      const outputRoot = path.join(root, 'published')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      const unit = await openCompileOutputPublisher(manager, {
          outputRoot,
          profile,
        }),
        lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
      await lease.run(async scope => {
        const plan = await parseFullSourcePlan(
          scope,
          Buffer.from('{"compile":{"resources":[]}}')
        )
        const source = await materializeFullSource(scope, plan, {
          stagingRoot: path.join(root, 'operations'),
        })
        const outputDirectory = path.join(source.stagingRoot, 'artifacts')
        await fs.mkdir(outputDirectory, { mode: 0o700 })
        if (
          mode === 'file-limit' ||
          mode === 'total-limit' ||
          mode === 'hidden-total'
        ) {
          const count = mode === 'file-limit' ? 1 : 5
          for (let i = 0; i < count; i++) {
            const file = await fs.open(
              path.join(
                outputDirectory,
                `${mode === 'hidden-total' ? '.' : ''}${i}.bin`
              ),
              'wx'
            )
            try {
              await file.truncate(
                16 * 1024 * 1024 + (mode === 'file-limit' ? 1 : 0)
              )
            } finally {
              await file.close()
            }
          }
        } else if (mode === 'entry-limit') {
          // Empty files keep this bounded real-inode proof small. Root also
          // counts, so 4096 children must reject rather than silently allow4097.
          for (let i = 0; i < 4096; i++)
            await fs.writeFile(path.join(outputDirectory, `${i}.log`), '')
        } else {
          await fs.writeFile(
            path.join(outputDirectory, 'output.pdf'),
            'complete'
          )
          if (mode === 'symlink')
            await fs.symlink(
              path.join(outputDirectory, 'output.pdf'),
              path.join(outputDirectory, 'alias')
            )
          if (mode === 'hardlink')
            await fs.link(
              path.join(outputDirectory, 'output.pdf'),
              path.join(outputDirectory, 'alias')
            )
          if (mode === 'filtered-response') {
            await fs.mkdir(path.join(outputDirectory, '.private'))
            await fs.writeFile(
              path.join(outputDirectory, '.private/source.log'),
              'hidden'
            )
            await fs.writeFile(
              path.join(outputDirectory, 'strace.log'),
              'trace'
            )
            await fs.writeFile(
              path.join(outputDirectory, 'extensionless'),
              'plain'
            )
          }
        }
        await completePublicationArtifacts(
          scope,
          source.sourceDirectory,
          outputDirectory
        )
        if (mode === 'filtered-response' || mode === 'snapshot') {
          let directoryReads = 0,
            idReads = 0
          const result = await unit.publish(scope, {
            get outputDirectory() {
              directoryReads++
              return directoryReads === 1 ? outputDirectory : '/never-re-read'
            },
            get buildId() {
              idReads++
              return idReads === 1 ? 'abcdef-123456' : 'fedcba-654321'
            },
          })
          assert.equal(directoryReads, 1)
          assert.equal(idReads, 1)
          assert.deepEqual(
            result.outputFiles.map(file => file.path).sort(),
            mode === 'snapshot'
              ? ['output.pdf']
              : ['extensionless', 'output.pdf']
          )
          const pdf = result.outputFiles.find(
            file => file.path === 'output.pdf'
          )
          assert.ok(pdf)
          assert.deepEqual(pdf, {
            path: 'output.pdf',
            type: 'pdf',
            build: result.buildId,
            size: 8,
          })
          assert.equal(
            result.outputFiles.find(file => file.path === 'extensionless')
              ?.type,
            undefined
          )
        } else {
          await assert.rejects(
            unit.publish(scope, { outputDirectory, buildId: 'abcdef-123456' }),
            { code: 'INVALID_PUBLICATION' }
          )
          assert.deepEqual(await fs.readdir(outputRoot), [])
        }
      })
    })
  }, 20000)
}
for (const succeed of [true, false]) {
  test(`generated build IDs use at most three real occupied checks (${succeed ? 'third succeeds' : 'exhausted'})`, async () => {
    await withSourceFixture(async (root, manager) => {
      const outputRoot = path.join(root, 'published'),
        parent = path.join(outputRoot, PROJECT, 'generated-files')
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      const old = path.join(parent, 'abcdef-123456')
      await fs.mkdir(old)
      await fs.writeFile(path.join(old, 'output.pdf'), 'previous')
      const identity = await fs.lstat(old)
      let calls = 0
      const generation = vi
        .spyOn(OutputCacheManager, 'generateBuildId')
        .mockImplementation(
          (done: (error: Error | null, id: string) => void) => {
            calls++
            done(
              null,
              succeed && calls === 3 ? 'fedcba-654321' : 'abcdef-123456'
            )
          }
        )
      try {
        const unit = await openCompileOutputPublisher(manager, {
            outputRoot,
            profile,
          }),
          lease = await manager.acquire({ projectId: PROJECT, kind: 'compile' })
        await lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            Buffer.from('{"compile":{"resources":[]}}')
          )
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          const outputDirectory = path.join(source.stagingRoot, 'artifacts')
          await fs.mkdir(outputDirectory, { mode: 0o700 })
          await fs.writeFile(path.join(outputDirectory, 'output.pdf'), 'new')
          await completePublicationArtifacts(
            scope,
            source.sourceDirectory,
            outputDirectory
          )
          if (succeed)
            assert.equal(
              (await unit.publish(scope, { outputDirectory })).buildId,
              'fedcba-654321'
            )
          else
            await assert.rejects(unit.publish(scope, { outputDirectory }), {
              name: 'BuildIdConflictError',
            })
        })
        assert.equal(calls, 3)
        // A successful commit may expire old IDs under unchanged legacy policy.
        if (!succeed) {
          assert.equal((await fs.lstat(old)).ino, identity.ino)
          assert.equal(
            await fs.readFile(path.join(old, 'output.pdf'), 'utf8'),
            'previous'
          )
        }
      } finally {
        generation.mockRestore()
      }
    })
  })
}
