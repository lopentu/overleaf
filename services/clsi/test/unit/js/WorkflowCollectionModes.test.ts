import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { test } from 'vitest'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import {
  CompilerLease,
  OwnedJobReconciler,
} from '../../../app/js/JobOwnership.ts'
import { EphemeralDockerJob } from '../../../app/js/EphemeralDockerJob.ts'
import { DockerApiFixture, gate, waitForEvent } from './DockerApiFixture.ts'
import { OwnershipApiFixture } from './OwnershipApiFixture.ts'

for (const mode of ['stdout', 'artifacts'] as const) {
  test(`owned ${mode} protects its actual UUID and workspace until cleanup settles`, async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'workflow-collection-')
    )
    const api = new OwnershipApiFixture(),
      docker = new DockerApiFixture()
    let manager: CompilerAdmission | undefined
    const held = gate(),
      cleanup = gate(),
      entered = gate()
    try {
      const workspace = path.join(root, 'workspace'),
        input = path.join(workspace, 'in')
      await fs.mkdir(workspace, { mode: 0o700 })
      await fs.mkdir(input, { mode: 0o700 })
      await fs.writeFile(path.join(input, 'main.tex'), 'hello')
      const image = `sha256:${'a'.repeat(64)}`
      const runner = new EphemeralDockerJob(await docker.open(), {
        trustedStagingRoot: root,
        allowedImages: [image],
        allowedExecutables: ['/usr/bin/pdflatex'],
      })
      manager = new CompilerAdmission(
        runner,
        new OwnedJobReconciler(
          await api.open(),
          await CompilerLease.acquire(path.join(root, 'manager.sock'))
        ),
        { sweepIntervalMs: 60000 }
      )
      await manager.start()
      docker.holds.set('exec', held.promise)
      const lease = await manager.acquire({ projectId: 'p', kind: 'compile' })
      const task = lease.run(async scope => {
        assert.equal(typeof scope.runArtifacts, 'function')
        assert.equal(typeof scope.runStdout, 'function')
        scope.ownWorkspace(workspace, async () => {
          entered.release()
          await cleanup.promise
        })
        const request = {
          image,
          argv: ['/usr/bin/pdflatex'],
          cwd: '/compile',
          inputDirectory: input,
          timeoutMs: 2000,
        }
        return mode === 'stdout'
          ? scope.runStdout(request)
          : scope.runArtifacts({
              ...request,
              outputDirectory: path.join(workspace, 'out'),
            })
      })
      const observed = task.catch((error: unknown) => error)
      // Missing scope methods are observed before waiting for an event in RED.
      const reached = await Promise.race([
        waitForEvent(docker, 'exec').then(() => true),
        observed.then(() => false),
      ])
      assert.equal(reached, true)
      const id =
        docker.containerConfig?.Labels?.['org.lope.overleaf.compiler-job']
      assert.equal(typeof id, 'string')
      if (!id) throw new Error('missing identity')
      api.addContainer(id)
      await manager.reconcile()
      assert.equal(
        api.events.some(e => e.startsWith('remove:')),
        false
      )
      held.release()
      await entered.promise
      assert.equal(manager.status().active, 1)
      const other = await manager.acquire({
        projectId: 'other',
        kind: 'compile',
      })
      await assert.rejects(
        other.run(async scope => scope.ownWorkspace(workspace, async () => {})),
        { code: 'PROJECT_BUSY' }
      )
      await other.closed
      cleanup.release()
      const result = await task
      assert.equal(result.exitCode, 0)
      await lease.closed
      assert.equal(manager.status().active, 0)
    } finally {
      held.release()
      cleanup.release()
      await manager?.retryCleanup()
      await manager?.close()
      await api.close()
      await docker.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

// The request is valid TypeScript with a genuine accessor. The first snapshot
// belongs to A, but rereading that request after path checks crosses into B.
for (const mode of ['generic', 'artifacts', 'stdout'] as const) {
  test(`${mode} executes only its checked snapshot despite a changing input getter`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checked-request-'))
    const api = new OwnershipApiFixture()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let manager: CompilerAdmission | undefined
    let other: Promise<unknown> | undefined
    const a = path.join(root, 'a'),
      b = path.join(root, 'b')
    let received: string | undefined
    const record = (
      request: import('../../../app/js/JobRequest.ts').ExecutionRequest
    ) => {
      received = request.inputDirectory
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    const executor = {
      async run(request: import('../../../app/js/JobRequest.ts').JobRequest) {
        return {
          ...record(request),
          output: { entries: 0, files: 0, bytes: 0 },
          outputDirectory: request.outputDirectory,
        }
      },
      async runArtifacts(
        request: import('../../../app/js/JobRequest.ts').JobRequest
      ) {
        return {
          ...record(request),
          output: {
            original: { entries: 0, files: 0, bytes: 0 },
            generated: { entries: 0, files: 0, bytes: 0 },
            retained: { entries: 0, files: 0, bytes: 0 },
            namespaceEntries: 0,
          },
          outputDirectory: request.outputDirectory,
        }
      },
      async runStdout(
        request: import('../../../app/js/JobRequest.ts').StdoutJobRequest
      ) {
        return record(request)
      },
    }
    try {
      for (const directory of [a, b]) {
        await fs.mkdir(directory, { mode: 0o700 })
        await fs.mkdir(path.join(directory, 'in'), { mode: 0o700 })
      }
      manager = new CompilerAdmission(
        executor,
        new OwnedJobReconciler(
          await api.open(),
          await CompilerLease.acquire(path.join(root, 'manager.sock'))
        ),
        { sweepIntervalMs: 60000 }
      )
      await manager.start()
      const leaseA = await manager.acquire({ projectId: 'a', kind: 'compile' })
      const leaseB = await manager.acquire({ projectId: 'b', kind: 'compile' })
      other = leaseB.run(async scope => {
        scope.ownWorkspace(b, async () => {})
        entered.resolve()
        await held.promise
      })
      await entered.promise
      let reads = 0
      const base = {
        image: `sha256:${'a'.repeat(64)}`,
        argv: ['/usr/bin/pdflatex'],
        cwd: '/compile',
        timeoutMs: 1000,
      }
      const directory = () => path.join(++reads <= 3 ? a : b, 'in')
      const request = {
        ...base,
        get inputDirectory() {
          return directory()
        },
      }
      const withOutput = {
        ...base,
        get inputDirectory() {
          return directory()
        },
        outputDirectory: path.join(a, 'out'),
      }
      await leaseA.run(async scope => {
        scope.ownWorkspace(a, async () => {})
        if (mode === 'stdout') await scope.runStdout(request)
        else if (mode === 'artifacts') await scope.runArtifacts(withOutput)
        else await scope.runJob(withOutput)
      })
      assert.equal(
        received,
        path.join(a, 'in'),
        'executor received a different active workspace from the validated copy'
      )
      assert.notEqual(received, path.join(b, 'in'))
    } finally {
      held.resolve()
      await other
      await manager?.close()
      await api.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
