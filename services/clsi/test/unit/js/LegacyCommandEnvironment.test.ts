import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
afterEach(() => {
  vi.doUnmock('@overleaf/settings')
  vi.doUnmock('../../../app/js/CommandRunner.js')
  vi.doUnmock('dockerode')
})

test('legacy settings capture binds one prefix/strace object without changing argv defaults', async () => {
  let reads = 0
  vi.doMock('@overleaf/settings', () => ({
    default: {
      get clsi() {
        reads++
        return {
          latexmkCommandPrefix:
            reads === 1 ? ['/fixture/time', '-v'] : ['/different/time', '-v'],
        }
      },
    },
  }))
  const calls: unknown[][] = []
  vi.doMock('../../../app/js/CommandRunner.js', () => ({
    default: {
      run(...args: unknown[]) {
        calls.push(args)
        const callback = args[8]
        assert.equal(typeof callback, 'function')
        if (typeof callback === 'function')
          callback(null, { stdout: '', stderr: '' })
        return 'synthetic-only'
      },
    },
  }))
  const { default: runner } = await import('../../../app/js/LatexRunner.js')
  await new Promise<void>((resolve, reject) =>
    runner.runLatex(
      'project',
      {
        directory: '/not-used',
        mainFile: 'main-file.tex',
        image: 'synthetic',
        environment: {},
        flags: [],
        compileGroup: 'compile',
        stopOnFirstError: false,
        stats: {},
        timings: {},
      },
      (error: unknown) => (error ? reject(error) : resolve())
    )
  )
  assert.equal(reads, 1)
  assert.deepEqual(calls[0]?.[1], [
    '/fixture/time',
    '-v',
    'latexmk',
    '-cd',
    '-jobname=output',
    '-auxdir=$COMPILE_DIR',
    '-outdir=$COMPILE_DIR',
    '-synctex=1',
    '-interaction=batchmode',
    '-time',
    '-f',
    '-pdf',
    '$COMPILE_DIR/main-file.tex',
  ])
})

test('actual legacy Docker builder keeps HOME=/tmp, numeric CLSI1, image-tag PATH and generated-over-configured precedence', async () => {
  vi.doMock('@overleaf/settings', () => ({
    default: {
      clsi: {
        docker: {
          env: {
            HOME: '/tmp',
            TEXMFVAR: '/tmp/texmf-var',
            TEXMFCONFIG: '/tmp/texmf-config',
            CLSI: 1,
            OVERLEAF_PROJECT_ID: 'configured-wrong-project',
            CHKTEX_VALIDATE: 0,
          },
        },
      },
    },
  }))
  vi.doMock('dockerode', () => ({ default: class SyntheticDocker {} }))
  const { default: runner } = await import('../../../app/js/DockerRunner.mjs')
  const options = runner._getContainerOptions(
    ['latexmk', 'main.tex'],
    'synthetic:2016.2',
    { '/not-used': '/compile' },
    42000,
    { OVERLEAF_PROJECT_ID: 'actual-logical-project', CHKTEX_VALIDATE: 1 },
    'compile',
    null
  )
  assert.deepEqual(options.Env, [
    'HOME=/tmp',
    'TEXMFVAR=/tmp/texmf-var',
    'TEXMFCONFIG=/tmp/texmf-config',
    'CLSI=1',
    'OVERLEAF_PROJECT_ID=actual-logical-project',
    'CHKTEX_VALIDATE=1',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/texlive/2016/bin/x86_64-linux/',
  ])
})
