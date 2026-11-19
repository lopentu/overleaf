import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import * as listener from '../../../app/js/ClsiListener.ts'
import { CompilerAdmission } from '../../../app/js/CompilerAdmission.ts'
import { startIsolatedCompilerWorker } from '../../../app/js/IsolatedCompilerWorker.ts'

const image = `sha256:${'c'.repeat(64)}`

async function withDaemon(
  use: (
    configuration: Parameters<typeof startIsolatedCompilerWorker>[0],
    requests: string[],
    setSweepFailure: (value: boolean) => void
  ) => Promise<void>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-worker-'))
  const runtimeRoot = path.join(root, 'run')
  const stateRoot = path.join(root, 'state')
  const dockerSocket = path.join(runtimeRoot, 'docker.sock')
  const requests: string[] = []
  let sweepFailure = false
  const daemon = http.createServer((request, response) => {
    const method = request.method
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid')
      .pathname
    const route = `${method} ${pathname}`
    requests.push(route)
    const replies: Record<string, unknown> = {
      'GET /v1.47/info': {
        ID: 'fixture-dedicated-daemon',
        Labels: ['org.lope.overleaf.compiler-worker=dedicated'],
        SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin'],
        CgroupDriver: 'systemd',
        CgroupVersion: '2',
      },
      [`GET /v1.47/images/${image}/json`]: { Id: image, Config: {} },
      'GET /v1.47/containers/json': [],
      'GET /v1.47/volumes': { Volumes: [] },
    }
    if (
      !Object.hasOwn(replies, route) ||
      (sweepFailure && route === 'GET /v1.47/containers/json')
    ) {
      response.writeHead(500).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(replies[route]))
  })
  try {
    for (const directory of [runtimeRoot, stateRoot])
      await fs.mkdir(directory, { mode: 0o700 })
    for (const name of ['operations', 'plans', 'published'])
      await fs.mkdir(path.join(stateRoot, name), { mode: 0o700 })
    daemon.listen(dockerSocket)
    await once(daemon, 'listening')
    await fs.chmod(dockerSocket, 0o600)
    await use(
      {
        runtimeRoot,
        stateRoot,
        dockerSocket,
        daemonId: 'fixture-dedicated-daemon',
        profile: {
          id: 'fixture',
          image,
          aliases: ['synthetic:2099'],
          variant: 'standard',
          texBinDirectory: '/synthetic/bin',
          tools: {
            latexmk: '/synthetic/bin/latexmk',
            texcount: '/synthetic/bin/texcount',
            synctex: '/synthetic/bin/synctex',
          },
        },
        downloadHost: 'http://fixture.invalid',
        outputUrlPrefix: '',
      },
      requests,
      value => {
        sweepFailure = value
      }
    )
  } finally {
    try {
      if (daemon.listening) {
        const closed = once(daemon, 'close')
        daemon.close()
        daemon.closeAllConnections()
        await closed
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

function readStatus(socketPath: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { socketPath, path: '/project/1234567890abcdef12345678/status' },
      response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
        response.once('error', reject)
      }
    )
    request.once('error', reject)
  })
}

test('refuses a different daemon before reconciliation or opening worker sockets', async () => {
  await withDaemon(async (configuration, requests) => {
    await assert.rejects(
      startIsolatedCompilerWorker({
        ...configuration,
        daemonId: 'another-daemon',
      }),
      /ISOLATED_DAEMON_UNQUALIFIED/
    )
    assert.deepEqual(requests, ['GET /v1.47/info'])
    assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
      'docker.sock',
    ])
  })
})

test('serves on a private Unix socket and retains its lease until shutdown reconciles', async () => {
  await withDaemon(async (configuration, requests, setSweepFailure) => {
    const worker = await startIsolatedCompilerWorker(configuration)
    try {
      assert.deepEqual(requests, [
        'GET /v1.47/info',
        `GET /v1.47/images/${image}/json`,
        'GET /v1.47/containers/json',
        'GET /v1.47/volumes',
      ])
      const socketPath = path.join(configuration.runtimeRoot, 'clsi.sock')
      const socket = await fs.lstat(socketPath)
      assert.ok(socket.isSocket())
      assert.equal(socket.mode & 0o777, 0o600)
      const status = await readStatus(socketPath)
      assert.equal(status, 200)
      setSweepFailure(true)
      await assert.rejects(worker.close())
      assert.deepEqual((await fs.readdir(configuration.runtimeRoot)).sort(), [
        'docker.sock',
        'manager.sock',
      ])
    } finally {
      setSweepFailure(false)
      await worker.close()
    }
    await worker.close()
    assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
      'docker.sock',
    ])
  })
})

test('refuses a second runtime directory for the same daemon before probing it', async () => {
  await withDaemon(async (configuration, requests) => {
    const alternateRuntime = path.join(
      path.dirname(configuration.runtimeRoot),
      'alternate-run'
    )
    await fs.mkdir(alternateRuntime, { mode: 0o700 })
    const first = await startIsolatedCompilerWorker(configuration)
    let second: typeof first | undefined
    try {
      const firstRequests = [...requests]
      await assert.rejects(async () => {
        second = await startIsolatedCompilerWorker({
          ...configuration,
          runtimeRoot: alternateRuntime,
        })
      }, /ISOLATED_DOCKER_SOCKET_UNSAFE/)
      assert.deepEqual(requests, firstRequests)
      assert.deepEqual(await fs.readdir(alternateRuntime), [])
    } finally {
      try {
        await second?.close()
      } finally {
        await first.close()
      }
    }
  })
})

test('releases its lease after initial reconciliation fails so the same runtime can retry', async () => {
  await withDaemon(async (configuration, _requests, setSweepFailure) => {
    setSweepFailure(true)
    await assert.rejects(startIsolatedCompilerWorker(configuration))
    assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
      'docker.sock',
    ])

    setSweepFailure(false)
    const worker = await startIsolatedCompilerWorker(configuration)
    await worker.close()
    assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
      'docker.sock',
    ])
  })
})

test('returns 503 on the private listener until initial reconciliation finishes', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const start = CompilerAdmission.prototype.start
  const holdStart = vi
    .spyOn(CompilerAdmission.prototype, 'start')
    .mockImplementationOnce(async function (this: CompilerAdmission) {
      entered.resolve()
      await release.promise
      await start.call(this)
    })
  try {
    await withDaemon(async (configuration, requests) => {
      const starting = startIsolatedCompilerWorker(configuration)
      try {
        await Promise.race([
          entered.promise,
          starting.then(() =>
            assert.fail('Worker started before reaching the held sweep')
          ),
        ])
        const socketPath = path.join(configuration.runtimeRoot, 'clsi.sock')
        assert.equal(await readStatus(socketPath), 503)
        assert.equal(requests.includes('GET /v1.47/containers/json'), false)
      } finally {
        release.resolve()
        const worker = await starting
        try {
          assert.equal(
            await readStatus(path.join(configuration.runtimeRoot, 'clsi.sock')),
            200
          )
        } finally {
          await worker.close()
        }
      }
    })
  } finally {
    holdStart.mockRestore()
  }
})

test('listener startup failure releases the lease before any initial sweep', async () => {
  const refused = vi
    .spyOn(listener, 'startClsiListeners')
    .mockRejectedValueOnce(new Error('Fixture refused worker listener'))
  try {
    await withDaemon(async (configuration, requests) => {
      await assert.rejects(
        startIsolatedCompilerWorker(configuration),
        /Fixture refused worker listener/
      )
      assert.deepEqual(requests, [
        'GET /v1.47/info',
        `GET /v1.47/images/${image}/json`,
      ])
      assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
        'docker.sock',
      ])
    })
  } finally {
    refused.mockRestore()
  }
})

test('a shutdown retry retries the admission manager’s failed workspace cleanup', async () => {
  const current = Promise.withResolvers<CompilerAdmission>()
  const start = CompilerAdmission.prototype.start
  const captureManager = vi
    .spyOn(CompilerAdmission.prototype, 'start')
    .mockImplementationOnce(function (this: CompilerAdmission) {
      current.resolve(this)
      return start.call(this)
    })
  try {
    await withDaemon(async configuration => {
      const worker = await startIsolatedCompilerWorker(configuration)
      const manager = await current.promise
      let blocked = true
      let cleanupAttempts = 0
      try {
        const lease = await manager.acquire({
          kind: 'compile',
          projectId: 'workspace-cleanup-fixture',
        })
        await assert.rejects(
          lease.run(async scope => {
            scope.claimWorkspaceCleanup(async () => {
              cleanupAttempts++
              if (blocked) throw new Error('Fixture workspace cleanup blocked')
            })
          }),
          /Fixture workspace cleanup blocked/
        )
        await assert.rejects(worker.close(), /Isolated worker cleanup failed/)
        assert.deepEqual((await fs.readdir(configuration.runtimeRoot)).sort(), [
          'docker.sock',
          'manager.sock',
        ])
        blocked = false
        await worker.close()
        assert.equal(cleanupAttempts, 2)
        assert.deepEqual(await fs.readdir(configuration.runtimeRoot), [
          'docker.sock',
        ])
      } finally {
        blocked = false
        try {
          await worker.close()
        } catch {
          await manager.retryCleanup()
          await worker.close()
        }
      }
    })
  } finally {
    captureManager.mockRestore()
  }
})
