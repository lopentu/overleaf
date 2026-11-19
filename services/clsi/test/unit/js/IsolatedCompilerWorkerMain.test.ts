import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import {
  startIsolatedCompilerWorker,
  type IsolatedCompilerWorkerConfiguration,
} from '../../../app/js/IsolatedCompilerWorker.ts'
import { runIsolatedCompilerWorker } from '../../../app/js/IsolatedCompilerWorkerMain.ts'

vi.mock('../../../app/js/IsolatedCompilerWorker.ts', () => ({
  startIsolatedCompilerWorker: vi.fn(),
}))

const configuration: IsolatedCompilerWorkerConfiguration = {
  runtimeRoot: '/synthetic/run',
  stateRoot: '/synthetic/state',
  dockerSocket: '/synthetic/run/docker.sock',
  daemonId: 'synthetic-daemon',
  profile: {
    id: 'synthetic',
    image: `sha256:${'a'.repeat(64)}`,
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
  filestoreBridge: {
    sourceOrigin: 'http://filestore.invalid',
    proxyOrigin: 'http://127.0.0.1:10999',
  },
}

async function withConfig(use: (root: string, file: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-launch-'))
  try {
    const conf = path.join(root, 'protected')
    await fs.mkdir(conf, { mode: 0o700 })
    const file = path.join(conf, 'worker.json')
    await fs.writeFile(file, JSON.stringify(configuration), { mode: 0o640 })
    await use(root, file)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('refuses malformed arguments and unsafe configuration before calling the worker factory', async () => {
  const start = vi
    .mocked(startIsolatedCompilerWorker)
    .mockRejectedValue(new Error('Unexpected factory call'))
  try {
    await withConfig(async (root, file) => {
      const stopping = new AbortController()
      for (const argv of [[], [file], ['--config', file, file]]) {
        await assert.rejects(runIsolatedCompilerWorker(argv, stopping.signal))
      }

      const symlink = path.join(root, 'symlink.json')
      await fs.symlink(file, symlink)
      const symlinkParent = path.join(root, 'symlink-parent')
      await fs.symlink(path.dirname(file), symlinkParent)
      await assert.rejects(
        runIsolatedCompilerWorker(['--config', symlink], stopping.signal)
      )
      await assert.rejects(
        runIsolatedCompilerWorker(
          ['--config', path.join(symlinkParent, 'worker.json')],
          stopping.signal
        )
      )

      for (const mode of [0o660, 0o642]) {
        await fs.chmod(file, mode)
        await assert.rejects(
          runIsolatedCompilerWorker(['--config', file], stopping.signal)
        )
      }
      await fs.chmod(file, 0o640)
      await fs.chmod(path.dirname(file), 0o770)
      await assert.rejects(
        runIsolatedCompilerWorker(['--config', file], stopping.signal)
      )
      await fs.chmod(path.dirname(file), 0o700)

      for (const content of [
        '{malformed',
        JSON.stringify({ ...configuration, fallback: true }),
        JSON.stringify({
          ...configuration,
          profile: {
            ...configuration.profile,
            tools: {
              ...configuration.profile.tools,
              fallback: '/synthetic/bin/false',
            },
          },
        }),
        JSON.stringify({
          ...configuration,
          outputUrlPrefix: 'a'.repeat(64 * 1024),
        }),
      ]) {
        await fs.writeFile(file, content)
        await assert.rejects(
          runIsolatedCompilerWorker(['--config', file], stopping.signal)
        )
      }
      assert.equal(start.mock.calls.length, 0)
    })
  } finally {
    start.mockReset()
  }
})

test('joins graceful close after a stop arrives during worker startup', async () => {
  const entering = Promise.withResolvers<void>()
  const started = Promise.withResolvers<{ close(): Promise<void> }>()
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stop = new AbortController()
  const close = vi.fn(async () => {
    closing.resolve()
    await release.promise
  })
  const start = vi
    .mocked(startIsolatedCompilerWorker)
    .mockImplementationOnce(() => {
      entering.resolve()
      return started.promise
    })
  try {
    await withConfig(async (_root, file) => {
      const running = runIsolatedCompilerWorker(['--config', file], stop.signal)
      try {
        await Promise.race([
          entering.promise,
          running.then(() =>
            assert.fail('Launcher exited before starting worker')
          ),
        ])
        assert.deepEqual(start.mock.calls, [[configuration]])
        stop.abort()
        started.resolve({ close })
        await Promise.race([
          closing.promise,
          running.then(() =>
            assert.fail('Launcher exited without closing worker')
          ),
        ])
        assert.equal(close.mock.calls.length, 1)
      } finally {
        stop.abort()
        started.resolve({ close })
        release.resolve()
        await running
      }
    })
  } finally {
    start.mockReset()
  }
})

test.each(['recovers', 'fails closed'] as const)(
  'shutdown %s after exactly one retry',
  async outcome => {
    const stop = new AbortController()
    const terminal = new Error('Fixture cleanup retry failed')
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Fixture initial cleanup failed'))
    if (outcome === 'recovers') close.mockResolvedValue(undefined)
    else close.mockRejectedValue(terminal)
    const start = vi
      .mocked(startIsolatedCompilerWorker)
      .mockImplementationOnce(() => {
        stop.abort()
        return Promise.resolve({ close })
      })
    try {
      await withConfig(async (_root, file) => {
        const running = runIsolatedCompilerWorker(
          ['--config', file],
          stop.signal
        )
        if (outcome === 'recovers') await running
        else await assert.rejects(running, error => error === terminal)
        assert.equal(close.mock.calls.length, 2)
      })
    } finally {
      start.mockReset()
    }
  }
)

test('native command exits nonzero without printing a malformed config or its path', async () => {
  await withConfig(async (_root, file) => {
    await fs.writeFile(file, 'SYNTHETIC_CONFIG_REDACTION_MARKER')
    const command = fileURLToPath(
      new URL('../../../app/js/IsolatedCompilerWorkerMain.ts', import.meta.url)
    )
    const result = spawnSync(process.execPath, [command, '--config', file], {
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'ISOLATED_WORKER_LAUNCH_FAILED\n')
  })
})
