// @ts-check
const { test: nodeTest } = require('node:test')
const nodeAssert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const cleanup = require('./runtime-cleanup.cjs')

const plan = `Remv build-essential [12.10ubuntu1]
Remv g++ [4:13.2.0-7ubuntu1]
Remv g++-13 [13.3.0-6ubuntu2~24.04.1]
Remv g++-x86-64-linux-gnu [4:13.2.0-7ubuntu1]
Remv g++-13-x86-64-linux-gnu [13.3.0-6ubuntu2~24.04.1]
Remv zlib1g-dev [1:1.3.dfsg-3.1ubuntu2.3]
Remv libpcre3-dev [2:8.39-15build1]
Remv libstdc++-13-dev [13.3.0-6ubuntu2~24.04.1]
Remv libc6-dev [2.39-0ubuntu8.12]
Remv linux-libc-dev [6.8.0-149.149]
`

nodeTest(
  'accepts the reviewed removal set regardless of resolver order',
  () => {
    cleanup.validateRemovalPlan(plan)
    cleanup.validateRemovalPlan(plan.trim().split('\n').reverse().join('\n'))
  }
)

nodeTest(
  'rejects a runtime package removal, missing removal, duplicate or version drift',
  () => {
    for (const text of [
      plan + 'Remv nodejs [24.22.3-1nodesource1]\n',
      plan.replace('Remv build-essential [12.10ubuntu1]\n', ''),
      plan + 'Remv build-essential [12.10ubuntu1]\n',
      plan.replace('6.8.0-149.149', '6.8.0-150.150'),
    ])
      nodeAssert.throws(() => cleanup.validateRemovalPlan(text))
  }
)

nodeTest(
  'rejects installation, configuration and purge actions before removal',
  () => {
    for (const action of [
      'Inst new (1 Vendor [amd64])',
      'Conf nodejs (24 Vendor [amd64])',
      'Purg old [1]',
    ]) {
      nodeAssert.throws(() => cleanup.validateRemovalPlan(plan + action + '\n'))
    }
  }
)

function buildContext() {
  return {
    uid: 0,
    cwd: '/overleaf',
    script: '/run/overleaf-runtime-cleanup.cjs',
    buildIntent: '1',
    nodeVersion: 'v24.22.3',
    projectName: 'overleaf',
    packageManager: 'yarn@4.18.0',
    mountinfo:
      '1 0 0:1 / /run/overleaf-runtime-cleanup.cjs ro,relatime - overlay overlay ro\n',
  }
}

nodeTest(
  'requires root, canonical project, explicit build intent and actual read-only context mount',
  () => {
    cleanup.validateContext(buildContext())
    for (const change of [
      { uid: 1001 },
      { cwd: '/home/richard/project' },
      { script: '/tmp/runtime-cleanup.cjs' },
      { buildIntent: '' },
      { nodeVersion: 'v24.18.1' },
      { projectName: 'other' },
      { packageManager: 'yarn@1' },
      { mountinfo: '' },
      {
        mountinfo: buildContext().mountinfo.replace(
          'ro,relatime',
          'rw,relatime'
        ),
      },
    ])
      nodeAssert.throws(() =>
        cleanup.validateContext({ ...buildContext(), ...change })
      )
  }
)

function npmState() {
  return {
    nodeVersion: '24.22.3-1nodesource1',
    listHash:
      '61512aa81bf4d8b400885228c9154b8c45e01b2da1ee7d3e38b6fe1eb5002162',
    npmVersion: '11.19.1',
    parents: ['/usr', '/usr/lib', '/usr/lib/node_modules', '/usr/bin'].map(
      filename => ({
        path: filename,
        uid: 0,
        directory: true,
        symlink: false,
        mode: 0o755,
      })
    ),
    tree: {
      path: '/usr/lib/node_modules/npm',
      uid: 0,
      directory: true,
      symlink: false,
      mode: 0o755,
    },
    links: [
      {
        path: '/usr/bin/npm',
        uid: 0,
        symlink: true,
        target: '../lib/node_modules/npm/bin/npm-cli.js',
      },
      {
        path: '/usr/bin/npx',
        uid: 0,
        symlink: true,
        target: '../lib/node_modules/npm/bin/npx-cli.js',
      },
    ],
    ownedPaths: ['/usr/lib/node_modules/npm', '/usr/bin/npm', '/usr/bin/npx'],
  }
}

nodeTest(
  'only the NodeSource-owned real npm tree and exact two symlinks qualify',
  () => {
    cleanup.validateNpmPaths(npmState())
    const state = npmState()
    for (const changed of [
      { ...state, nodeVersion: 'other' },
      { ...state, listHash: '0'.repeat(64) },
      { ...state, npmVersion: 'other' },
      { ...state, ownedPaths: [] },
      { ...state, tree: { ...state.tree, symlink: true } },
      { ...state, tree: { ...state.tree, uid: 1001 } },
      {
        ...state,
        parents: state.parents.map((row, index) =>
          index === 0 ? { ...row, mode: 0o777 } : row
        ),
      },
      {
        ...state,
        links: [
          { ...state.links[0], target: '/opt/corepack/yarn.js' },
          state.links[1],
        ],
      },
    ])
      nodeAssert.throws(() => cleanup.validateNpmPaths(changed))
  }
)

nodeTest(
  'all retained package versions must match; no new package or missing runtime is allowed',
  () => {
    const before = new Map([
      ['nodejs', '24.22.3-1nodesource1'],
      ['make', '4.3'],
      ['linux-libc-dev', '6.8.0-149.149'],
    ])
    cleanup.validateRetainedPackages(
      before,
      new Map([
        ['nodejs', '24.22.3-1nodesource1'],
        ['make', '4.3'],
      ]),
      new Set(['linux-libc-dev'])
    )
    for (const after of [
      new Map([['make', '4.3']]),
      new Map([
        ['nodejs', 'other'],
        ['make', '4.3'],
      ]),
      new Map([
        ['nodejs', '24.22.3-1nodesource1'],
        ['make', '4.3'],
        ['extra', '1'],
      ]),
      before,
    ]) {
      nodeAssert.throws(() =>
        cleanup.validateRetainedPackages(
          before,
          after,
          new Set(['linux-libc-dev'])
        )
      )
    }
  }
)

nodeTest(
  'parses installed state and refuses duplicate or Essential removal candidates',
  () => {
    const text =
      'Package: nodejs\nStatus: install ok installed\nVersion: 24.22.3-1nodesource1\n\nPackage: linux-libc-dev\nStatus: install ok installed\nVersion: 6.8.0-149.149\nEssential: yes\n'
    nodeAssert.throws(() =>
      cleanup.parseInstalled(text, new Set(['linux-libc-dev']))
    )
    nodeAssert.throws(() =>
      cleanup.parseInstalled(text + '\n' + text, new Set())
    )
  }
)

nodeTest(
  'ordinary host invocation refuses before any package or path mutation',
  () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'runtime-cleanup.cjs'), '--final-image-build'],
      { encoding: 'utf8' }
    )
    nodeAssert.equal(result.error, undefined)
    nodeAssert.notEqual(result.status, 0)
    nodeAssert.equal(result.stdout, '')
  }
)

nodeTest(
  'the final Docker RUN shell command parses without executing it',
  () => {
    const file = readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8')
    const step = file
      .split('\n')
      .filter(line => line.includes('OVERLEAF_FINAL_RUNTIME_BUILD=1'))
      .join('\n')
    nodeAssert.ok(step)
    nodeAssert.equal(
      spawnSync('/bin/sh', ['-n'], { input: step, encoding: 'utf8' }).status,
      0
    )
  }
)
