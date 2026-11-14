import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import { DockerApiFixture, gate, waitForEvent } from './DockerApiFixture.ts'
const IMAGE = `sha256:${'a'.repeat(64)}`
for (const mode of ['generic', 'artifacts', 'stdout'] as const) {
  test(`${mode} adapter captures getters once and retains identical approved create/exec environment across a real held API`, async () => {
    const api = new DockerApiFixture()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'command-env-'))
    const held = gate()
    let reads = 0
    try {
      const input = path.join(root, 'input')
      await fs.mkdir(input, { mode: 0o700 })
      await fs.writeFile(path.join(input, 'main.tex'), 'source')
      api.holds.set('create', held.promise)
      const job = new EphemeralDockerJob(await api.open(), {
        trustedStagingRoot: root,
        allowedImages: [IMAGE],
        allowedExecutables: ['/fixture/latexmk'],
      })
      const environment = { TZ: 'UTC' }
      const request = {
        image: IMAGE,
        argv: ['/fixture/latexmk'],
        cwd: '/compile',
        inputDirectory: input,
        outputDirectory: path.join(root, 'output'),
        timeoutMs: 2000,
        get environment() {
          reads++
          return environment
        },
      }
      const running =
        mode === 'stdout'
          ? job.runStdout({
              image: request.image,
              argv: request.argv,
              cwd: request.cwd,
              inputDirectory: request.inputDirectory,
              timeoutMs: request.timeoutMs,
              get environment() {
                return request.environment
              },
            })
          : mode === 'artifacts'
            ? job.runArtifacts(request)
            : job.run(request)
      await waitForEvent(api, 'create')
      environment.TZ = 'Pacific/Auckland'
      held.release()
      await running
      assert.equal(reads, 1)
      assert.deepEqual(api.containerConfig?.Env, [
        'HOME=/home/tex',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'TEXMFVAR=/tmp/texmf-var',
        'TEXMFCONFIG=/tmp/texmf-config',
        'TZ=UTC',
      ])
      assert.deepEqual(api.execConfig?.Env, api.containerConfig?.Env)
    } finally {
      held.release()
      await api.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
test('new compiler profile selectors remain bounded metadata before admission or daemon work', async () => {
  const { snapshotExecutionRequest } =
    await import('../../../app/js/JobRequest.ts')
  const request = {
    image: IMAGE,
    argv: ['/fixture/texcount'],
    cwd: '/compile',
    inputDirectory: '/not-read',
    timeoutMs: 60000,
  }
  for (const compilerProfile of ['', 'x'.repeat(129), 'x\n', '../profile']) {
    assert.throws(() =>
      snapshotExecutionRequest({ ...request, compilerProfile })
    )
  }
})
