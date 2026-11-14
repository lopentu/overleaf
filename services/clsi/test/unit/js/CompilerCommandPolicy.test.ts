import { createCompilerCommandPlanner } from '../../../app/js/CompilerCommandPlan.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import type { TrustedCompilerProfile } from '../../../app/js/CompileEnvironment.ts'
import { validateRequest } from '../../../app/js/JobRequest.ts'
import { withSourceFixture } from './SourceInputFixture.ts'
const PROJECT = '1234567890abcdef12345678'
const IMAGE = `sha256:${'a'.repeat(64)}`
// Synthetic policy facts only: no image or executable path has been qualified.
const profile: TrustedCompilerProfile = {
  id: 'synthetic-standard',
  image: IMAGE,
  aliases: ['synthetic:2099.1'],
  variant: 'standard',
  texBinDirectory: '/fixture/tex-bin',
  tools: {
    latexmk: '/fixture/latexmk',
    texcount: '/fixture/texcount',
    synctex: '/fixture/synctex',
    time: '/fixture/time',
  },
  latexmkCommandPrefix: [],
}
async function environmentSeam() {
  const value = await import('../../../app/js/CompileEnvironment.ts').catch(
    () => undefined
  )
  assert.ok(value, 'shared finite environment policy is absent')
  return value
}
for (const key of [
  'HOME',
  'PATH',
  'TEXMFVAR',
  'TEXMFCONFIG',
  'CLSI',
  'LD_PRELOAD',
  'UNRECOGNIZED',
]) {
  test(`caller environment refuses protected or unknown ${key}`, async () => {
    const { validateAdmittedEnvironment } = await environmentSeam()
    assert.throws(() => validateAdmittedEnvironment({ [key]: 'value' }, true))
  })
}
test('finite compile superset admits all11 string fields while generic remains three', async () => {
  const { validateAdmittedEnvironment } = await environmentSeam()
  const input = {
    SOURCE_DATE_EPOCH: '1',
    FORCE_SOURCE_DATE: '1',
    TZ: 'UTC',
    OVERLEAF_PROJECT_ID: PROJECT,
    openout_any: 'p',
    max_print_line: '1000',
    CHKTEX_OPTIONS: '-nall -e9 -e10 -w15 -w16',
    CHKTEX_ULIMIT_OPTIONS: '-t 5 -v 64000',
    CHKTEX_EXIT_ON_ERROR: '1',
    CHKTEX_VALIDATE: '1',
    ENABLE_CHECKPOINT: '1',
  }
  assert.deepEqual(validateAdmittedEnvironment(input, true), input)
  assert.throws(() => validateAdmittedEnvironment(input, false))
  for (const value of ['', 'x\n', 'x'.repeat(1025)])
    assert.throws(() => validateAdmittedEnvironment({ TZ: value }, true))
})
test('wordcount planner uses genuine exact-manager scope and captures config getters once', async () => {
  await withSourceFixture(async (_root, manager) => {
    let reads = 0
    const configured = {
      HOME: '/tmp',
      TEXMFVAR: '/tmp/texmf-var',
      TEXMFCONFIG: '/tmp/texmf-config',
      CLSI: 1,
      TZ: 'UTC',
    }
    const planner = createCompilerCommandPlanner(manager, {
      profiles: [profile],
      defaultImage: 'synthetic:2099.1',
      get environment() {
        reads++
        return configured
      },
    })
    configured.TZ = 'Europe/Paris'
    const lease = await manager.acquire({
      projectId: PROJECT,
      kind: 'wordcount',
    })
    let saved: Parameters<typeof planner.wordcount>[0] | undefined
    await lease.run(async scope => {
      saved = scope
      const plan = planner.wordcount(scope, {
        mainFile: 'nested/$COMPILE_DIR 文.tex',
      })
      assert.equal(reads, 1)
      assert.throws(() =>
        planner.wordcount({ ...scope }, { mainFile: 'main.tex' })
      )
      assert.deepEqual(plan.argv, [
        '/fixture/texcount',
        '-nocol',
        '-inc',
        '/compile/nested/$COMPILE_DIR 文.tex',
      ])
      assert.equal(plan.timeoutMs, 60000)
      assert.equal(plan.projectId, PROJECT)
      assert.equal(plan.cwd, '/compile')
      assert.deepEqual(plan.environment, {
        TZ: 'UTC',
        OVERLEAF_PROJECT_ID: PROJECT,
      })
      assert.equal(plan.image, IMAGE)
      assert.equal(plan.compilerProfile, 'synthetic-standard')
      assert.equal('inputDirectory' in plan, false)
      assert.equal('outputDirectory' in plan, false)
      assert.ok(
        Object.isFrozen(plan) &&
          Object.isFrozen(plan.argv) &&
          Object.isFrozen(plan.environment)
      )
    })
    await lease.closed
    assert.ok(saved)
    const closedScope = saved
    assert.throws(() =>
      planner.wordcount(closedScope, { mainFile: 'main.tex' })
    )
  })
})
test('planner rejects genuine scope from another manager and wrong workflow kind', async () => {
  await withSourceFixture(async (_root, a) =>
    withSourceFixture(async (_other, b) => {
      const planner = createCompilerCommandPlanner(a, {
        profiles: [profile],
        defaultImage: 'synthetic:2099.1',
      })
      const lease = await b.acquire({ projectId: PROJECT, kind: 'wordcount' })
      await lease.run(async scope =>
        assert.throws(() => planner.wordcount(scope, { mainFile: 'main.tex' }))
      )
      await lease.closed
      const compile = await a.acquire({ projectId: PROJECT, kind: 'compile' })
      await compile.run(async scope => {
        assert.throws(() => planner.wordcount(scope, { mainFile: 'main.tex' }))
        assert.throws(
          () =>
            planner.compile(scope, {
              mainFile: 'main.tex',
              compiler: 'pdflatex',
            }),
          /preparation/
        )
      })
      await compile.closed
    })
  )
})
const unsupportedSettings: readonly Readonly<
  Record<string, string | number>
>[] = [
  { HOME: '/etc' },
  { TEXMFVAR: '/unbounded' },
  { TEXMFCONFIG: '/unbounded' },
  { CLSI: 2 },
  { LD_PRELOAD: '/lib/x' },
  { PATH: '/bin' },
]
for (const environment of unsupportedSettings) {
  test(`configured unsupported protected policy refuses ${Object.keys(environment)[0]}`, async () => {
    await withSourceFixture(async (_root, manager) =>
      assert.throws(() =>
        createCompilerCommandPlanner(manager, {
          profiles: [profile],
          defaultImage: 'synthetic:2099.1',
          environment,
        })
      )
    )
  })
}
test('missing aliases/checkpoint variants/tool paths refuse instead of guessing image-year paths', async () => {
  await withSourceFixture(async (_root, manager) => {
    assert.throws(() =>
      createCompilerCommandPlanner(manager, {
        profiles: [
          { ...profile, tools: { ...profile.tools, latexmk: 'latexmk' } },
        ],
        defaultImage: 'synthetic:2099.1',
      })
    )
    const planner = createCompilerCommandPlanner(manager, {
      profiles: [profile],
      defaultImage: 'synthetic:2099.1',
    })
    const lease = await manager.acquire({
      projectId: PROJECT,
      kind: 'wordcount',
    })
    await lease.run(async scope => {
      assert.throws(() =>
        planner.wordcount(scope, {
          mainFile: 'main.tex',
          image: 'unlisted:2099.1',
        })
      )
      assert.throws(() =>
        planner.wordcount(scope, {
          mainFile: 'main.tex',
          image: 'synthetic:2099.1.checkpointing',
        })
      )
    })
    await lease.closed
  })
})
test('final policy refuses unknown profile and trusted-image/internal-tool mismatch before mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'command-policy-'))
  try {
    const input = path.join(root, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    const policy = {
      trustedStagingRoot: root,
      allowedImages: [IMAGE, `sha256:${'b'.repeat(64)}`],
      allowedExecutables: [
        '/fixture/time',
        '/fixture/texcount',
        '/foreign/texcount',
      ],
      compilerProfiles: [profile],
    }
    const request = {
      image: IMAGE,
      argv: ['/fixture/texcount', '-nocol', '-inc', '/compile/main.tex'],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(root, 'output'),
      timeoutMs: 60000,
      compilerProfile: 'missing',
      environment: { OVERLEAF_PROJECT_ID: PROJECT },
    }
    await validateRequest({ ...request, compilerProfile: profile.id }, policy)
    await assert.rejects(
      validateRequest(
        { ...request, compilerProfile: profile.id, timeoutMs: 60001 },
        policy
      )
    )
    await assert.rejects(
      validateRequest(
        { ...request, compilerProfile: profile.id, cwd: '/compile/chapter' },
        policy
      )
    )
    await assert.rejects(validateRequest(request, policy))
    await assert.rejects(
      validateRequest(
        {
          ...request,
          compilerProfile: profile.id,
          argv: ['/foreign/texcount', '-nocol', '-inc', '/compile/main.tex'],
        },
        policy
      )
    )
    await assert.rejects(
      validateRequest(
        {
          ...request,
          compilerProfile: profile.id,
          argv: ['/fixture/time', '-v', '/foreign/latexmk'],
        },
        policy
      )
    )
    await assert.rejects(
      validateRequest(
        {
          ...request,
          compilerProfile: profile.id,
          image: `sha256:${'b'.repeat(64)}`,
        },
        policy
      )
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('concrete default CLSI1 is recognized while selected jobs deliberately use HOME=/home/tex and trusted PATH', async () => {
  const { configuredCompilerEnvironment } = await environmentSeam()
  const { compileEnvironment } = await import('../../../app/js/JobRequest.ts')
  assert.deepEqual(
    configuredCompilerEnvironment({
      HOME: '/tmp',
      TEXMFVAR: '/tmp/texmf-var',
      TEXMFCONFIG: '/tmp/texmf-config',
      CLSI: 1,
      CHKTEX_VALIDATE: 1,
    }),
    { CHKTEX_VALIDATE: '1' }
  )
  const request = {
    image: IMAGE,
    argv: ['/fixture/texcount', '-nocol', '-inc', '/compile/main.tex'],
    cwd: '/compile',
    inputDirectory: '/not-used',
    timeoutMs: 60000,
    compilerProfile: profile.id,
    environment: { OVERLEAF_PROJECT_ID: PROJECT, TZ: 'UTC' },
  }
  assert.deepEqual(
    compileEnvironment(request, {
      trustedStagingRoot: '/not-used',
      allowedImages: [IMAGE],
      allowedExecutables: ['/fixture/texcount'],
      compilerProfiles: [profile],
    }),
    [
      'HOME=/home/tex',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/fixture/tex-bin',
      'TEXMFVAR=/tmp/texmf-var',
      'TEXMFCONFIG=/tmp/texmf-config',
      'CLSI=1',
      `OVERLEAF_PROJECT_ID=${PROJECT}`,
      'TZ=UTC',
    ]
  )
})
test('selected final policy rejects altered chktex/checkpoint switches rather than treating known keys as authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'command-values-'))
  try {
    const input = path.join(root, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    const policy = {
      trustedStagingRoot: root,
      allowedImages: [IMAGE],
      allowedExecutables: ['/fixture/texcount'],
      compilerProfiles: [profile],
    }
    const unsupportedValues: readonly Readonly<Record<string, string>>[] = [
      { CHKTEX_OPTIONS: '-evil' },
      { CHKTEX_ULIMIT_OPTIONS: 'unbounded' },
      { CHKTEX_VALIDATE: '2' },
      { CHKTEX_EXIT_ON_ERROR: 'yes' },
      { ENABLE_CHECKPOINT: '1' },
    ]
    for (const environment of unsupportedValues) {
      await assert.rejects(
        validateRequest(
          {
            image: IMAGE,
            argv: ['/fixture/texcount', '-nocol', '-inc', '/compile/main.tex'],
            cwd: '/compile',
            inputDirectory: input,
            outputDirectory: path.join(root, 'output'),
            timeoutMs: 60000,
            compilerProfile: profile.id,
            environment: { OVERLEAF_PROJECT_ID: PROJECT, ...environment },
          },
          policy
        )
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
for (const key of [
  'strace',
  'pdfCaching',
  'clsiCache',
  'archiveLogs',
  'tikz',
]) {
  test(`unselected planner refuses unsupported ${key} profile options instead of silently ignoring them`, async () => {
    await withSourceFixture(async (_root, manager) => {
      const settings = {
        profiles: [profile],
        defaultImage: 'synthetic:2099.1',
        [key]: true,
      }
      assert.throws(() => createCompilerCommandPlanner(manager, settings))
    })
  })
}
for (const [label, argv] of [
  [
    'wordcount traversal',
    ['/fixture/texcount', '-nocol', '-inc', '/compile/../outside.tex'],
  ],
  [
    'compile without preparation',
    [
      '/fixture/latexmk',
      '-auxdir=/compile',
      '-outdir=/compile',
      '/compile/main.tex',
    ],
  ],
] as const) {
  test(`final profile policy refuses ${label} even when a caller constructs a matching profile selector`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'command-authority-'))
    try {
      const input = path.join(root, 'input')
      await fs.mkdir(input, { mode: 0o700 })
      await assert.rejects(
        validateRequest(
          {
            image: IMAGE,
            argv,
            cwd: '/compile',
            inputDirectory: input,
            outputDirectory: path.join(root, 'output'),
            timeoutMs: 60000,
            compilerProfile: profile.id,
            environment: { OVERLEAF_PROJECT_ID: PROJECT },
          },
          {
            trustedStagingRoot: root,
            allowedImages: [IMAGE],
            allowedExecutables: ['/fixture/texcount', '/fixture/latexmk'],
            compilerProfiles: [profile],
          }
        )
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

test('conflicting image-pin aliases cannot select contradictory trusted tool profiles', async () => {
  await withSourceFixture(async (_root, manager) => {
    const contradictory = {
      ...profile,
      id: 'different-profile',
      aliases: ['another-alias'],
      tools: { ...profile.tools, texcount: '/different/texcount' },
    }
    assert.throws(() =>
      createCompilerCommandPlanner(manager, {
        profiles: [profile, contradictory],
        defaultImage: IMAGE,
      })
    )
  })
})
test('unknown configured prototype keys and object/boolean values are refused without coercion', async () => {
  const { configuredCompilerEnvironment } = await environmentSeam()
  const protoKey: Record<string, unknown> = {}
  Object.defineProperty(protoKey, '__proto__', {
    value: 'ignored',
    enumerable: true,
  })
  assert.throws(() => configuredCompilerEnvironment(protoKey))
  let coercions = 0
  const object = {
    toString() {
      coercions++
      return 'UTC'
    },
  }
  assert.throws(() => configuredCompilerEnvironment({ TZ: object }))
  assert.equal(coercions, 0)
  for (const environment of [
    { constructor: Object },
    { toString: Object.prototype.toString },
    { TZ: {} },
    { CLSI: true },
  ]) {
    assert.throws(() => configuredCompilerEnvironment(environment))
  }
})
test('omitting a profile selector cannot downgrade a configured compiler image through generic policy or equivalent pins', async () => {
  const { compileEnvironment } = await import('../../../app/js/JobRequest.ts')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'command-downgrade-'))
  try {
    const input = path.join(root, 'input')
    await fs.mkdir(input, { mode: 0o700 })
    const alternate = `synthetic/image@sha256:${'a'.repeat(64)}`,
      generic = `sha256:${'b'.repeat(64)}`
    const policy = {
      trustedStagingRoot: root,
      allowedImages: [IMAGE, alternate, generic],
      allowedExecutables: ['/fixture/latexmk'],
      compilerProfiles: [profile],
    }
    const request = {
      image: IMAGE,
      argv: [
        '/fixture/latexmk',
        '-auxdir=/compile',
        '-outdir=/compile',
        '/compile/main.tex',
      ],
      cwd: '/compile',
      inputDirectory: input,
      outputDirectory: path.join(root, 'output'),
      timeoutMs: 60000,
      environment: { TZ: 'UTC' },
    }
    for (const image of [IMAGE, alternate]) {
      await assert.rejects(validateRequest({ ...request, image }, policy))
      assert.throws(() => compileEnvironment({ ...request, image }, policy))
    }
    await validateRequest({ ...request, image: generic }, policy)
    assert.deepEqual(
      compileEnvironment({ ...request, image: generic }, policy),
      [
        'HOME=/home/tex',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'TEXMFVAR=/tmp/texmf-var',
        'TEXMFCONFIG=/tmp/texmf-config',
        'TZ=UTC',
      ]
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
