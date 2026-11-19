// @ts-check
const { test: nodeTest } = require('node:test')
const nodeAssert = require('node:assert/strict')
const audit = require('./runtime-audit.cjs')
const projection = require('./runtime-dependencies.cjs')

function ciContext() {
  return {
    uid: 1001,
    actions: 'true',
    repository: 'lopentu/overleaf',
    workspace: '/home/runner/work/overleaf/overleaf',
    temp: '/tmp/runner',
    realWorkspace: '/home/runner/work/overleaf/overleaf',
    realTemp: '/tmp/runner',
  }
}
nodeTest(
  'only ordinary-user fixed public CI source context is admitted',
  () => {
    audit.validateCiContext(ciContext())
    for (const delta of [
      { uid: 0 },
      { actions: '' },
      { repository: 'private/other' },
      { temp: 'relative' },
      { workspace: '/tmp/runner/overleaf-runtime-audit' },
      { realWorkspace: '/other' },
      { realTemp: '/other' },
    ])
      nodeAssert.throws(() =>
        audit.validateCiContext({ ...ciContext(), ...delta })
      )
  }
)
function inventory() {
  const names = [
    ['@google-cloud/profiler', '7.0.0'],
    ['bcrypt', '6.0.0'],
    ['cpu-features', '0.0.10'],
    ['dtrace-provider', '0.8.8'],
    ['mmmagic', '0.5.3'],
    ['msgpackr-extract', '3.0.3'],
    ['nan', '2.26.2'],
    ['nan', '2.28.0'],
    ['node-addon-api', '8.7.0'],
    ['pprof', '5.0.0'],
    ['utf-8-validate', '5.0.8'],
  ]
  return {
    packages: names.map(([name, version]) => ({
      kind: 'portal',
      name,
      version,
      path: 'fixture',
      manifest_sha256: 'public',
      locator: JSON.stringify([name, 'portal:fixture']),
    })),
    nested_package_json_metadata: [],
  }
}
nodeTest('SBOM retains all11 original portal names and real versions', () => {
  const inv = inventory()
  const bom = projection.sbom(inv)
  nodeAssert.equal(bom.components.length, 11)
  nodeAssert.ok(
    bom.components.some(p => p.name === 'bcrypt' && p.version === '6.0.0')
  )
  nodeAssert.throws(() =>
    projection.sbom({ ...inv, packages: inv.packages.slice(1) })
  )
})
nodeTest(
  'SBOM includes patched original/physical versions plus nested and fork candidates',
  () => {
    const inv = inventory()
    inv.packages.push({
      kind: 'zip',
      name: 'referer-parser',
      version: '0.0.4',
      path: 'patch.zip',
      manifest_sha256: 'public',
      locator: JSON.stringify([
        'referer-parser',
        'patch:referer-parser@npm%3A0.0.3#public',
      ]),
    })
    inv.packages.push({
      kind: 'zip',
      name: 'socket.io',
      version: '0.9.19-overleaf-12',
      path: 'fork.zip',
      manifest_sha256: 'public',
      locator: JSON.stringify([
        'socket.io',
        'https://github.com/overleaf/socket.io.git#public',
      ]),
    })
    /** @type {Array<{name:string,version:string}>} */
    const nested = [{ name: '1to2', version: '1.0.0' }]
    const bom = projection.sbom({
      ...inv,
      nested_package_json_metadata: nested,
    })
    for (const [name, version] of [
      ['referer-parser', '0.0.3'],
      ['referer-parser', '0.0.4'],
      ['socket.io', '0.9.19-overleaf-12'],
      ['socket.io', '0.9.19'],
      ['1to2', '1.0.0'],
    ])
      nodeAssert.ok(
        bom.components.some(p => p.name === name && p.version === version)
      )
  }
)
function bom() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    components: [
      {
        type: 'library',
        name: 'public',
        version: '1.0.0',
        purl: 'pkg:npm/public@1.0.0',
        'bom-ref': 'pkg:npm/public@1.0.0',
        properties: [],
      },
    ],
  }
}
/** @param {string|null} severity */
function report(severity = null) {
  return {
    results: [
      {
        packages: [
          {
            package: { name: 'public', version: '1.0.0', ecosystem: 'npm' },
            ...(severity
              ? {
                  vulnerabilities: [
                    { id: 'GHSA-public', database_specific: { severity } },
                  ],
                }
              : {}),
          },
        ],
      },
    ],
  }
}
nodeTest(
  'missing, extra and duplicate scanned identities fail complete coverage',
  () => {
    for (const bad of [
      { results: [] },
      { results: [{ packages: [] }] },
      {
        results: [
          {
            packages: [
              {
                package: { name: 'other', version: '1.0.0', ecosystem: 'npm' },
              },
            ],
          },
        ],
      },
      {
        results: [
          {
            packages: [
              ...report().results[0].packages,
              ...report().results[0].packages,
            ],
          },
        ],
      },
    ])
      nodeAssert.throws(() => audit.inspectReport(bad, bom()))
  }
)
nodeTest(
  'unknown report schema, severity and suppressed-finding metadata refuse',
  () => {
    for (const bad of [
      {},
      report('UNKNOWN'),
      { ...report(), ignored_vulnerabilities: ['GHSA-public'] },
      {
        results: [
          {
            packages: [
              {
                ...report('HIGH').results[0].packages[0],
                groups: [{ ids: ['GHSA-public'], is_ignored: true }],
              },
            ],
          },
        ],
      },
    ])
      nodeAssert.throws(() => audit.inspectReport(bad, bom()))
  }
)
nodeTest('HIGH and CRITICAL fail while every lower finding is retained', () => {
  for (const severity of ['HIGH', 'CRITICAL'])
    nodeAssert.throws(() =>
      audit.assertClean(audit.inspectReport(report(severity), bom()))
    )
  for (const severity of ['MODERATE', 'LOW']) {
    const findings = audit.inspectReport(report(severity), bom())
    nodeAssert.equal(findings.length, 1)
    audit.assertClean(findings)
  }
})
nodeTest('positive control requires an exact HIGH advisory match', () => {
  const positive = {
    name: 'lodash',
    version: '4.17.20',
    id: 'GHSA-35jh-r3h4-6jhm',
    severity: 'HIGH',
  }
  nodeAssert.throws(() => audit.assertPositive([]))
  for (const mismatch of [
    { name: 'other' },
    { version: '4.17.21' },
    { id: 'other' },
    { severity: 'LOW' },
  ]) {
    nodeAssert.throws(() =>
      audit.assertPositive([{ ...positive, ...mismatch }])
    )
  }
  audit.assertPositive([positive])
})

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
/** @param {(root:string)=>void} action */
function fixture(action) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'overleaf-runtime-audit-test-')
  )
  try {
    action(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
nodeTest(
  'public source copy preserves executable modes and refuses external links',
  () =>
    fixture(root => {
      const source = path.join(root, 'source'),
        destination = path.join(root, 'copy')
      fs.mkdirSync(source)
      fs.writeFileSync(
        path.join(source, 'public-executable'),
        'public non-executed fixture',
        { mode: 0o755 }
      )
      audit.copy(source, destination, source)
      nodeAssert.equal(
        fs.statSync(path.join(destination, 'public-executable')).mode & 0o777,
        0o755
      )
      fs.symlinkSync('/etc', path.join(source, 'outside'))
      nodeAssert.throws(() =>
        audit.copy(
          path.join(source, 'outside'),
          path.join(root, 'outside-copy'),
          source
        )
      )
    })
)
nodeTest(
  'throwaway preparation excludes untracked data and refuses a preexisting destination',
  () =>
    fixture(root => {
      const workspace = path.join(root, 'source'),
        temp = path.join(root, 'runner')
      fs.mkdirSync(workspace)
      fs.mkdirSync(temp)
      fs.mkdirSync(path.join(workspace, '.yarn/cache'), { recursive: true })
      fs.mkdirSync(path.join(workspace, '.yarn/unplugged'))
      for (const file of ['.pnp.cjs', '.pnp.loader.mjs', 'public.js'])
        fs.writeFileSync(
          path.join(workspace, file),
          'public non-executed source'
        )
      fs.writeFileSync(
        path.join(workspace, 'untracked-private-fixture'),
        'never-copy-fixture'
      )
      fixtureGit(workspace, ['init', '--quiet'])
      fixtureGit(workspace, ['add', 'public.js'])
      commitFixture(workspace)
      const dest = audit.prepare(workspace, temp)
      nodeAssert.equal(fs.existsSync(path.join(dest, 'public.js')), true)
      nodeAssert.equal(fs.existsSync(path.join(dest, '.git')), false)
      nodeAssert.equal(
        fs.existsSync(path.join(dest, 'untracked-private-fixture')),
        false
      )
      nodeAssert.throws(
        () => audit.prepare(workspace, temp),
        /fresh-ci-runtime-tree/
      )
    })
)
nodeTest(
  'copy budget refuses a sparse oversized input before destination creation',
  () =>
    fixture(root => {
      const workspace = path.join(root, 'source'),
        temp = path.join(root, 'runner')
      fs.mkdirSync(workspace)
      fs.mkdirSync(temp)
      fs.mkdirSync(path.join(workspace, '.yarn/cache'), { recursive: true })
      fs.mkdirSync(path.join(workspace, '.yarn/unplugged'))
      for (const file of ['.pnp.cjs', '.pnp.loader.mjs', 'public.js'])
        fs.writeFileSync(
          path.join(workspace, file),
          'public non-executed source'
        )
      const fd = fs.openSync(
        path.join(workspace, '.yarn/cache/large.zip'),
        'wx'
      )
      fs.ftruncateSync(fd, 9 * 1024 ** 3)
      fs.closeSync(fd)
      fixtureGit(workspace, ['init', '--quiet'])
      fixtureGit(workspace, ['add', 'public.js'])
      commitFixture(workspace)
      nodeAssert.throws(
        () => audit.prepare(workspace, temp),
        /ci-copy-disk-budget/
      )
      nodeAssert.equal(
        fs.existsSync(path.join(temp, 'overleaf-runtime-audit')),
        false
      )
    })
)
nodeTest('modified scanner ignore config refuses before child creation', () =>
  fixture(root => {
    fs.writeFileSync(
      path.join(root, 'empty-osv-scanner.toml'),
      '[[IgnoredVulns]]\nid="GHSA-public"\n'
    )
    nodeAssert.throws(
      () => audit.scan('/nonexistent/scanner', root, 'runtime', bom()),
      /empty-no-ignore-config/
    )
  })
)

nodeTest(
  'scanner child has explicit offline/no-ignore flags and isolated environment',
  () =>
    fixture(root => {
      fs.writeFileSync(
        path.join(root, 'empty-osv-scanner.toml'),
        '# No ignores or overrides.\n'
      )
      const tool = path.join(root, 'public-fake-scanner')
      fs.writeFileSync(
        tool,
        `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const output=args.find(x=>x.startsWith('--output-file=')).slice(14);fs.writeFileSync(output,${JSON.stringify(JSON.stringify(report()))});fs.writeFileSync(${JSON.stringify(path.join(root, 'CHILD.json'))},JSON.stringify({args,home:process.env.HOME,proxy_present:Object.hasOwn(process.env,'HTTPS_PROXY')}));\n`,
        { mode: 0o755 }
      )
      nodeAssert.deepEqual(audit.scan(tool, root, 'runtime', bom()), [])
      const child = JSON.parse(
        fs.readFileSync(path.join(root, 'CHILD.json'), 'utf8')
      )
      for (const flag of [
        '--offline',
        '--no-resolve',
        '--all-packages',
        '--all-vulns',
        '--config=' + path.join(root, 'empty-osv-scanner.toml'),
      ])
        nodeAssert.ok(child.args.includes(flag))
      nodeAssert.equal(child.home, path.join(root, 'home'))
      nodeAssert.equal(child.proxy_present, false)
    })
)
nodeTest(
  'scanner execution failure cannot be interpreted as a clean report',
  () =>
    fixture(root => {
      fs.writeFileSync(
        path.join(root, 'empty-osv-scanner.toml'),
        '# No ignores or overrides.\n'
      )
      const tool = path.join(root, 'public-failed-scanner')
      fs.writeFileSync(tool, `#!${process.execPath}\nprocess.exit(2)\n`, {
        mode: 0o755,
      })
      nodeAssert.throws(
        () => audit.scan(tool, root, 'runtime', bom()),
        /offline-scanner-result/
      )
    })
)
nodeTest(
  'ordinary host audit CLI refuses before creating a runtime copy',
  () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'runtime-audit.cjs'), '--ci-runtime-audit'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: '' } }
    )
    nodeAssert.equal(result.error, undefined)
    nodeAssert.notEqual(result.status, 0)
    nodeAssert.equal(result.stdout, '')
  }
)

nodeTest(
  'vulnerability exit without any reported finding is not a clean scan',
  () =>
    fixture(root => {
      fs.writeFileSync(
        path.join(root, 'empty-osv-scanner.toml'),
        '# No ignores or overrides.\n'
      )
      const tool = path.join(root, 'public-incoherent-scanner')
      fs.writeFileSync(
        tool,
        `#!${process.execPath}\nconst fs=require('node:fs');const output=process.argv.find(x=>x.startsWith('--output-file=')).slice(14);fs.writeFileSync(output,${JSON.stringify(JSON.stringify(report()))});process.exit(1)\n`,
        { mode: 0o755 }
      )
      nodeAssert.throws(
        () => audit.scan(tool, root, 'runtime', bom()),
        /scanner-exit-finding-coherence/
      )
    })
)

/** Fixture commits only: never a maintained source commit or publication.
 * @param {string} root @param {string[]} args */
function fixtureGit(root, args) {
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  nodeAssert.equal(result.status, 0)
  return result.stdout
}
/** @param {string} root */
function commitFixture(root) {
  fixtureGit(root, [
    '-c',
    'user.name=Public source fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Public source test fixture',
  ])
}
nodeTest(
  'generated input ancestor links refuse before external bytes are copied',
  () =>
    fixture(base => {
      const workspace = path.join(base, 'source'),
        temp = path.join(base, 'runner'),
        outside = path.join(base, 'outside-public-fixture')
      for (const dir of [workspace, temp, outside]) fs.mkdirSync(dir)
      fs.mkdirSync(path.join(outside, 'cache'))
      fs.mkdirSync(path.join(outside, 'unplugged'))
      fs.writeFileSync(
        path.join(outside, 'cache/external.zip'),
        'public fixture outside source boundary'
      )
      fs.symlinkSync(outside, path.join(workspace, '.yarn'))
      for (const file of ['.pnp.cjs', '.pnp.loader.mjs', 'public.js'])
        fs.writeFileSync(
          path.join(workspace, file),
          'public non-executed source'
        )
      fixtureGit(workspace, ['init', '--quiet'])
      fixtureGit(workspace, ['add', 'public.js'])
      commitFixture(workspace)
      nodeAssert.throws(
        () => audit.prepare(workspace, temp),
        /source-input-ancestor-link/
      )
      nodeAssert.equal(
        fs.existsSync(
          path.join(temp, 'overleaf-runtime-audit/.yarn/cache/external.zip')
        ),
        false
      )
    })
)
nodeTest(
  'tracked source comes from committed HEAD including modes, not mutated working bytes',
  () =>
    fixture(root => {
      const workspace = path.join(root, 'source'),
        temp = path.join(root, 'runner')
      fs.mkdirSync(workspace)
      fs.mkdirSync(temp)
      fs.mkdirSync(path.join(workspace, '.yarn/cache'), { recursive: true })
      fs.mkdirSync(path.join(workspace, '.yarn/unplugged'))
      for (const name of ['.pnp.cjs', '.pnp.loader.mjs'])
        fs.writeFileSync(
          path.join(workspace, name),
          'public generated metadata'
        )
      fs.writeFileSync(
        path.join(workspace, 'public.js'),
        'committed public source',
        { mode: 0o755 }
      )
      fixtureGit(workspace, ['init', '--quiet'])
      fixtureGit(workspace, ['add', 'public.js'])
      commitFixture(workspace)
      fs.writeFileSync(
        path.join(workspace, 'public.js'),
        'uncommitted public source'
      )
      fs.chmodSync(path.join(workspace, 'public.js'), 0o644)
      const dest = audit.prepare(workspace, temp)
      nodeAssert.equal(
        fs.readFileSync(path.join(dest, 'public.js'), 'utf8'),
        'committed public source'
      )
      nodeAssert.equal(
        fs.statSync(path.join(dest, 'public.js')).mode & 0o777,
        0o755
      )
    })
)
