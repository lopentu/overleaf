import { PreparedCompilerInput } from '../../../app/js/PreparedCompilerInput.ts'
import { PreparedSyncTexInput } from '../../../app/js/PreparedSyncTexInput.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { test, vi } from 'vitest'
import { createCompilerCommandPlanner } from '../../../app/js/CompilerCommandPlan.ts'
import { validateRequest } from '../../../app/js/JobRequest.ts'
import type { TrustedCompilerProfile } from '../../../app/js/CompileEnvironment.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
import {
  parseFullSourcePlan,
  materializeFullSource,
  withPreparedCompileInput,
} from '../../../app/js/FreshCompileInput.ts'
const projectId = '1234567890abcdef12345678'
const prefix =
  '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}'

for (const kind of ['plain', 'draft', 'tikz', 'existing-output']) {
  test(`genuine bounded prepared input preserves ${kind} source semantics and expires after its joined callback`, async () => {
    assert.equal(
      typeof withPreparedCompileInput,
      'function',
      'bounded content preparation is absent'
    )
    await withSourceFixture(async (root, manager) => {
      const lease = await manager.acquire({ projectId, kind: 'compile' })
      let staged: string | undefined
      await lease.run(async scope => {
        const main = kind === 'tikz' ? '\\tikzexternalize\nbody' : 'body'
        const resources = [{ path: 'nested/main.tex', content: main }]
        if (kind === 'existing-output')
          resources.push({ path: 'output.tex', content: 'original output' })
        const plan = await parseFullSourcePlan(
          scope,
          Buffer.from(
            JSON.stringify({
              compile: {
                rootResourcePath: 'nested/main.tex',
                resources,
                options: { compiler: 'pdflatex', draft: kind === 'draft' },
              },
            })
          )
        )
        const source = await materializeFullSource(scope, plan, {
          stagingRoot: path.join(root, 'operations'),
        })
        await withPreparedCompileInput(scope, manager, plan, async prepared => {
          staged = prepared.inputDirectory
          assert.equal(
            await fs.readFile(
              path.join(prepared.inputDirectory, 'nested/main.tex'),
              'utf8'
            ),
            (kind === 'draft' ? prefix : '') + main
          )
          if (kind === 'tikz')
            assert.equal(
              await fs.readFile(
                path.join(prepared.inputDirectory, 'output.tex'),
                'utf8'
              ),
              main
            )
          if (kind === 'existing-output')
            assert.equal(
              await fs.readFile(
                path.join(prepared.inputDirectory, 'output.tex'),
                'utf8'
              ),
              'original output'
            )
          assert.equal(prepared.options.compiler, 'pdflatex')
          assert.equal(prepared.options.mainFile, 'nested/main.tex')
          assert.equal(prepared.options.timeoutMs, 600000)
          assert.equal(
            (await fs.stat(prepared.inputDirectory)).mode & 0o777,
            0o500
          )
        })
        assert.ok(staged)
        await assert.rejects(fs.stat(staged), { code: 'ENOENT' })
        assert.equal(
          await fs.readFile(
            path.join(source.sourceDirectory, 'nested/main.tex'),
            'utf8'
          ),
          (kind === 'draft' ? prefix : '') + main
        )
      })
      await lease.closed
    })
  })
}

const image = `sha256:${'a'.repeat(64)}`
const profile: TrustedCompilerProfile = {
  id: 'integration-synthetic',
  image,
  aliases: ['integration-synthetic:2099'],
  variant: 'standard',
  texBinDirectory: '/synthetic/bin',
  tools: {
    latexmk: '/synthetic/latexmk',
    texcount: '/synthetic/texcount',
    synctex: '/synthetic/synctex',
  },
}
test('only the actual prepared record authorizes its exact final compile command, deadline and immutable snapshot', async () => {
  await withSourceFixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId, kind: 'compile' })
    const planner = createCompilerCommandPlanner(manager, {
      profiles: [profile],
      defaultImage: image,
    })
    await lease.run(async scope => {
      const plan = await parseFullSourcePlan(
        scope,
        Buffer.from(
          JSON.stringify({
            compile: {
              rootResourcePath: 'main.tex',
              resources: [{ path: 'main.tex', content: 'body' }],
            },
          })
        )
      )
      await materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      await withPreparedCompileInput(scope, manager, plan, async prepared => {
        const command = planner.compile(scope, {
          mainFile: 'main.tex',
          compiler: 'pdflatex',
          preparedInput: prepared,
        })
        const request = {
          ...command,
          inputDirectory: prepared.inputDirectory,
          outputDirectory: prepared.outputDirectory,
        }
        const policy = {
          trustedStagingRoot: path.join(root, 'operations'),
          allowedImages: [image],
          allowedExecutables: [profile.tools.latexmk],
          compilerProfiles: [profile],
        }
        await validateRequest(request, policy)
        assert.equal(command.timeoutMs, 600000)
        assert.throws(() =>
          planner.compile(scope, {
            mainFile: 'main.tex',
            compiler: 'pdflatex',
            preparedInput: { ...prepared },
          })
        )
        await assert.rejects(
          validateRequest(
            { ...request, preparedInput: { ...prepared } },
            policy
          )
        )
        const { preparedInput: _authority, ...unprepared } = request
        await assert.rejects(validateRequest(unprepared, policy))
        await assert.rejects(
          validateRequest({ ...request, timeoutMs: 600001 }, policy)
        )
        await assert.rejects(
          validateRequest(
            { ...request, argv: [...request.argv, '-extra'] },
            policy
          )
        )
      })
    })
    await lease.closed
  })
})

test('a real preparation close failure retains its exact descriptor and active capacity through joined cleanup retry', async () => {
  await withSourceFixture(async (root, manager) => {
    const lease = await manager.acquire({ projectId, kind: 'compile' })
    const first = Promise.withResolvers<void>(),
      retry = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let closeActual: (() => Promise<void>) | undefined,
      calls = 0
    const nativeOpen = fs.open
    let restore: (() => void) | undefined
    const running = lease.run(async scope => {
      const plan = await parseFullSourcePlan(
        scope,
        Buffer.from(
          JSON.stringify({
            compile: {
              rootResourcePath: 'main.tex',
              resources: [{ path: 'main.tex', content: 'body' }],
            },
          })
        )
      )
      await materializeFullSource(scope, plan, {
        stagingRoot: path.join(root, 'operations'),
      })
      const opened = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (name, flags, mode) => {
          const file = await nativeOpen(name, flags, mode)
          if (String(name).endsWith('/main.tex') && closeActual === undefined) {
            closeActual = file.close.bind(file)
            const close = vi
              .spyOn(file, 'close')
              .mockImplementation(async () => {
                calls++
                if (calls === 1) {
                  first.resolve()
                  throw new Error('synthetic close failure')
                }
                retry.resolve()
                await release.promise
                await closeActual?.()
              })
            const prior = restore
            restore = () => {
              close.mockRestore()
              prior?.()
            }
          }
          return file
        })
      restore = () => {
        opened.mockRestore()
        syncBuiltinESMExports()
      }
      syncBuiltinESMExports()
      return await withPreparedCompileInput(
        scope,
        manager,
        plan,
        async () => undefined
      )
    })
    void running.catch(() => {})
    try {
      const started = await Promise.race([
        first.promise.then(() => true),
        running.then(
          () => false,
          () => false
        ),
      ])
      assert.equal(started, true, 'synthetic close fault was not reached')
      const retained = await Promise.race([
        retry.promise.then(() => true),
        running.then(
          () => false,
          () => false
        ),
      ])
      assert.equal(
        retained,
        true,
        'descriptor ownership was discarded instead of cleanup retry'
      )
      assert.equal(manager.status().active, 1)
    } finally {
      release.resolve()
      await running.catch(() => {})
      restore?.()
      await closeActual?.()
    }
    await lease.closed
    assert.equal(manager.status().active, 0)
  })
})

test('native constructor calls cannot mint a prepared authority without its private factory boundary', () => {
  assert.throws(
    () => Reflect.construct(PreparedCompilerInput, []),
    /Invalid preparation construction/
  )
  assert.throws(
    () => Reflect.construct(PreparedSyncTexInput, []),
    /Invalid preparation construction/
  )
})
