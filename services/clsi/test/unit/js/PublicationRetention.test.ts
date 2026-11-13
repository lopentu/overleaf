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
  withPublicationFixture as withSourceFixture,
  completePublicationArtifacts,
} from './PublicationArtifactFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const USER = 'abcdef1234567890abcdef12'
const profile = {
  optimiseInDocker: true,
  archiveLogs: false,
  strace: false,
  pdfCaching: false,
  clsiCache: false,
}
for (const perUser of [false, true]) {
  test(`publication reuses exact legacy inclusive retention for ${perUser ? 'logical user' : 'project'} directory`, async () => {
    await withSourceFixture(async (root, manager) => {
      const outputRoot = path.join(root, 'published')
      await fs.mkdir(outputRoot, { mode: 0o700 })
      const unit = await openCompileOutputPublisher(manager, {
        outputRoot,
        profile,
      })
      const ids = Array.from(
        { length: 4 },
        (_, i) => `${(Date.now() + i).toString(16)}-abcdef`
      )
      for (const buildId of ids) {
        const lease = await manager.acquire({
          projectId: PROJECT,
          ...(perUser ? { userId: USER } : {}),
          kind: 'compile',
        })
        await lease.run(async scope => {
          const plan = await parseFullSourcePlan(
            scope,
            Buffer.from('{"compile":{"resources":[]}}')
          )
          const source = await materializeFullSource(scope, plan, {
            stagingRoot: path.join(root, 'operations'),
          })
          const outputDirectory = path.join(
            source.stagingRoot,
            'closed-artifacts'
          )
          await fs.mkdir(outputDirectory, { mode: 0o700 })
          await fs.writeFile(path.join(outputDirectory, 'output.pdf'), buildId)
          await completePublicationArtifacts(
            scope,
            source.sourceDirectory,
            outputDirectory
          )
          await unit.publish(scope, { outputDirectory, buildId })
        })
      }
      const builds = await fs.readdir(
        path.join(
          outputRoot,
          perUser ? `${PROJECT}-${USER}` : PROJECT,
          'generated-files'
        )
      )
      assert.deepEqual(builds.sort(), ids.slice(perUser ? 2 : 1).sort())
    })
  })
}
