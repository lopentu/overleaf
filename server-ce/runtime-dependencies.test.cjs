// @ts-check
const { test: nodeTest } = require('node:test')
const nodeAssert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const projection = require('./runtime-dependencies.cjs')

function buildContext() {
  return {
    uid: 0,
    cwd: '/overleaf',
    realRoot: '/overleaf',
    script: '/run/overleaf-runtime-dependencies.cjs',
    marker: '1',
    project: 'overleaf',
    yarn: 'yarn@4.18.0',
    mountinfo:
      '1 0 0:1 / /run/overleaf-runtime-dependencies.cjs ro,relatime - overlay overlay ro\n',
  }
}

function originalRecords() {
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
  return names.map(([name, version]) => ({
    name,
    version,
    manifest: { name, version, scripts: { install: 'node-gyp rebuild' } },
  }))
}

nodeTest(
  'host, writable code, wrong root and unpinned Yarn refuse before projection',
  () => {
    projection.validateContext(buildContext())
    for (const delta of [
      { uid: 1001 },
      { cwd: '/tmp/test' },
      { realRoot: '/tmp/test' },
      { script: '/tmp/test' },
      { marker: '' },
      { project: 'other' },
      { yarn: 'yarn@4.19.0' },
      { mountinfo: '' },
      {
        mountinfo: buildContext().mountinfo.replace(
          'ro,relatime',
          'rw,relatime'
        ),
      },
    ])
      nodeAssert.throws(() =>
        projection.validateContext({ ...buildContext(), ...delta })
      )
  }
)

nodeTest(
  'locked descriptor sets retain ranges and do not mix same-name versions',
  () => {
    const lock =
      '"nan@npm:^2.26.0, nan@npm:2.26.2":\n  version: 2.26.2\n  resolution: "nan@npm:2.26.2"\n\n"nan@npm:^2.28.0":\n  resolution: "nan@npm:2.28.0"\n'
    nodeAssert.deepEqual(projection.lockDescriptors(lock, 'nan', '2.26.2'), [
      'nan@npm:^2.26.0',
      'nan@npm:2.26.2',
    ])
    nodeAssert.throws(() => projection.lockDescriptors(lock, 'nan', '9.0.0'))
    nodeAssert.throws(() =>
      projection.lockDescriptors(lock + '\n\n' + lock, 'nan', '2.26.2')
    )
  }
)

nodeTest(
  'only the complete reviewed original package and version set is eligible',
  () => {
    const records = originalRecords()
    projection.validateCandidates(records)
    for (const bad of [
      records.slice(1),
      [...records, records[0]],
      records.map((r, i) => (i === 0 ? { ...r, version: '0.0.0' } : r)),
    ])
      nodeAssert.throws(() => projection.validateCandidates(bad))
  }
)

nodeTest(
  'declared node-gyp runtime or peer dependencies and unrelated scripts refuse',
  () => {
    for (const changed of [
      { dependencies: { 'node-gyp': '12.2.0' } },
      { peerDependencies: { 'node-gyp': '*' } },
      { scripts: { install: 'echo unrelated' } },
    ]) {
      const records = originalRecords()
      const target = records[1]
      nodeAssert.throws(() =>
        projection.validateCandidates(
          records.map(r =>
            r === target ? { ...r, manifest: { ...r.manifest, ...changed } } : r
          )
        )
      )
    }
  }
)

nodeTest(
  'runtime dependency and peer graph differences are never ignored',
  () => {
    const expected = {
      '["app","workspace:."]': [
        '{"edges":[["bcrypt","bcrypt","npm:6.0.0"]],"peers":[]}',
      ],
    }
    projection.assertGraph(expected, expected)
    /** @type {Array<Parameters<typeof projection.assertGraph>[1]>} */
    const badGraphs = [
      {},
      { ...expected, extra: [] },
      { '["app","workspace:."]': ['{"edges":[],"peers":[]}'] },
      {
        '["app","workspace:."]': [
          '{"edges":[["bcrypt","bcrypt","npm:6.0.0"]],"peers":["new-peer"]}',
        ],
      },
    ]
    for (const actual of badGraphs)
      nodeAssert.throws(() => projection.assertGraph(expected, actual))
  }
)

/** @param {(root:string)=>void} action */
function fixture(action) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'overleaf-runtime-projection-test-')
  )
  try {
    action(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

nodeTest('complete payload proof sees altered manifest or native bytes', () =>
  fixture(root => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      '{"name":"bcrypt","version":"6.0.0"}'
    )
    fs.writeFileSync(
      path.join(root, 'public.node'),
      'public non-executed fixture'
    )
    const before = projection.payload(root)
    fs.writeFileSync(path.join(root, 'public.node'), 'altered public fixture')
    nodeAssert.notDeepEqual(projection.payload(root), before)
    const nativeChanged = projection.payload(root)
    fs.writeFileSync(
      path.join(root, 'package.json'),
      '{"name":"bcrypt","version":"0.0.0"}'
    )
    nodeAssert.notDeepEqual(projection.payload(root), nativeChanged)
  })
)

nodeTest(
  'payload symlinks and filesystem escape refuse rather than follow',
  () =>
    fixture(root => {
      fs.symlinkSync('/etc', path.join(root, 'escape'))
      nodeAssert.throws(() => projection.payload(root))
    })
)

nodeTest(
  'physical closure removes only unmapped owned ZIP and unplugged code',
  () =>
    fixture(root => {
      fs.mkdirSync(path.join(root, '.yarn/cache'), { recursive: true })
      fs.mkdirSync(path.join(root, '.yarn/unplugged/keep'), { recursive: true })
      fs.mkdirSync(path.join(root, '.yarn/unplugged/drop'), { recursive: true })
      fs.writeFileSync(
        path.join(root, '.yarn/cache/keep.zip'),
        'public retained'
      )
      fs.writeFileSync(
        path.join(root, '.yarn/cache/drop.zip'),
        'public dropped'
      )
      fs.writeFileSync(path.join(root, 'source-sentinel'), 'unchanged')
      projection.prune(root, new Set(['keep.zip']), new Set(['keep']))
      nodeAssert.equal(
        fs.existsSync(path.join(root, '.yarn/cache/drop.zip')),
        false
      )
      nodeAssert.equal(
        fs.existsSync(path.join(root, '.yarn/unplugged/drop')),
        false
      )
      nodeAssert.equal(
        fs.readFileSync(path.join(root, 'source-sentinel'), 'utf8'),
        'unchanged'
      )
      nodeAssert.equal(
        fs.existsSync(path.join(root, '.yarn/cache/keep.zip')),
        true
      )
    })
)

nodeTest(
  'unknown cache entries, absent required ZIP and directory links block pruning',
  () => {
    for (const kind of ['unknown', 'missing', 'symlink'])
      fixture(root => {
        fs.mkdirSync(path.join(root, '.yarn/cache'), { recursive: true })
        fs.mkdirSync(path.join(root, '.yarn/unplugged'), { recursive: true })
        if (kind === 'unknown')
          fs.writeFileSync(
            path.join(root, '.yarn/cache/unknown.code'),
            'public'
          )
        if (kind === 'symlink')
          fs.symlinkSync('/tmp', path.join(root, '.yarn/unplugged/link'))
        nodeAssert.throws(() =>
          projection.prune(
            root,
            new Set(kind === 'missing' ? ['missing.zip'] : []),
            new Set()
          )
        )
      })
  }
)

nodeTest('ordinary direct invocation refuses without package mutation', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'runtime-dependencies.cjs'), '--final-image-build'],
    { encoding: 'utf8' }
  )
  nodeAssert.equal(result.error, undefined)
  nodeAssert.notEqual(result.status, 0)
  nodeAssert.equal(result.stdout, '')
})

nodeTest(
  'actual traversal removes only injected node-gyp and preserves node-gyp-build',
  () => {
    /** @type {Parameters<typeof projection.graph>[0]} */
    const state = {
      roots: [{ name: 'app', reference: 'workspace:.' }],
      packages: {
        '["app","workspace:."]': {
          location: '',
          dependencies: [['bcrypt', 'npm:6.0.0']],
          peers: [],
          manifest: null,
        },
        '["bcrypt","npm:6.0.0"]': {
          location: 'bcrypt',
          dependencies: [
            ['node-gyp', 'npm:12.2.0'],
            ['node-gyp-build', 'npm:4.8.4'],
          ],
          peers: [],
          manifest: null,
        },
        '["node-gyp","npm:12.2.0"]': {
          location: 'gyp',
          dependencies: [],
          peers: [],
          manifest: null,
        },
        '["node-gyp-build","npm:4.8.4"]': {
          location: 'runtime',
          dependencies: [],
          peers: [],
          manifest: null,
        },
      },
    }
    const expected = projection.graph(state, true)
    nodeAssert.equal(expected.removed, 1)
    nodeAssert.equal(
      Object.hasOwn(expected.nodes, '["node-gyp","npm:12.2.0"]'),
      false
    )
    nodeAssert.equal(
      Object.hasOwn(expected.nodes, '["node-gyp-build","npm:4.8.4"]'),
      true
    )
  }
)

nodeTest(
  'same-version unqualified override relocates the complete original UTF8 package',
  () =>
    fixture(root => {
      fs.mkdirSync(path.join(root, 'original'))
      fs.writeFileSync(
        path.join(root, 'original/package.json'),
        '{"name":"utf-8-validate","version":"5.0.8","scripts":{"install":"node-gyp-build"}}'
      )
      fs.writeFileSync(
        path.join(root, 'original/public.node'),
        'non-executed public fixture'
      )
      fs.writeFileSync(
        path.join(root, 'package.json'),
        '{"name":"overleaf","resolutions":{"utf-8-validate":"5.0.8","other":"1.0.0"}}'
      )
      const before = projection.payload(path.join(root, 'original'))
      projection.materialize(
        root,
        [
          {
            name: 'utf-8-validate',
            version: '5.0.8',
            manifest: { name: 'utf-8-validate' },
            location: 'original',
          },
        ],
        '"utf-8-validate@npm:5.0.8":\n  resolution: "utf-8-validate@npm:5.0.8"\n'
      )
      const resolutions = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8')
      ).resolutions
      nodeAssert.equal(
        resolutions['utf-8-validate'],
        'portal:./.runtime-native-packages/utf-8-validate-5.0.8'
      )
      nodeAssert.equal(resolutions.other, '1.0.0')
      nodeAssert.deepEqual(
        projection.payload(
          path.join(root, '.runtime-native-packages/utf-8-validate-5.0.8')
        ),
        before
      )
      nodeAssert.deepEqual(
        projection.payload(path.join(root, 'original')),
        before
      )
    })
)

nodeTest(
  'only reviewed absent foreign optional assets are classified as absent',
  () =>
    fixture(root => {
      const optional =
        '["@msgpackr-extract/msgpackr-extract-win32-x64","npm:3.0.3"]'
      const item = {
        location: '.yarn/unplugged/optional/node_modules/asset',
        dependencies: [],
        peers: [],
        manifest: null,
      }
      nodeAssert.equal(
        projection.retained(root, { roots: [], packages: { [optional]: item } })
          .missingOptional.length,
        1
      )
      nodeAssert.throws(() =>
        projection.retained(root, {
          roots: [],
          packages: { '["bcrypt","npm:6.0.0"]': item },
        })
      )
    })
)

nodeTest(
  'offline child failure stops the pipeline and never enables install scripts',
  () =>
    fixture(root => {
      nodeAssert.throws(() =>
        projection.command([process.execPath, '-e', 'process.exit(7)'], root)
      )
      const text = projection.command(
        [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({network:process.env.YARN_ENABLE_NETWORK,scripts:process.env.YARN_ENABLE_SCRIPTS,corepack:process.env.COREPACK_ENABLE_NETWORK}))',
        ],
        root
      )
      nodeAssert.deepEqual(JSON.parse(text), {
        network: '0',
        scripts: '0',
        corepack: '0',
      })
    })
)

nodeTest(
  'consumer swaps between different virtual peer contexts refuse',
  () => {
    /** @type {Parameters<typeof projection.graph>[0]} */
    const before = {
      roots: [
        { name: 'app-a', reference: 'workspace:a' },
        { name: 'app-b', reference: 'workspace:b' },
      ],
      packages: {
        '["app-a","workspace:a"]': {
          location: 'a',
          dependencies: [['lib', 'virtual:one#npm:1.0.0']],
          peers: [],
          manifest: null,
        },
        '["app-b","workspace:b"]': {
          location: 'b',
          dependencies: [['lib', 'virtual:two#npm:1.0.0']],
          peers: [],
          manifest: null,
        },
        '["lib","virtual:one#npm:1.0.0"]': {
          location: 'lib1',
          dependencies: [['dep', 'npm:1.0.0']],
          peers: ['dep'],
          manifest: null,
        },
        '["lib","virtual:two#npm:1.0.0"]': {
          location: 'lib2',
          dependencies: [['dep', 'npm:2.0.0']],
          peers: ['dep'],
          manifest: null,
        },
        '["dep","npm:1.0.0"]': {
          location: 'dep1',
          dependencies: [],
          peers: [],
          manifest: null,
        },
        '["dep","npm:2.0.0"]': {
          location: 'dep2',
          dependencies: [],
          peers: [],
          manifest: null,
        },
      },
    }
    const after = structuredClone(before)
    after.packages['["app-a","workspace:a"]'].dependencies = [
      ['lib', 'virtual:two#npm:1.0.0'],
    ]
    after.packages['["app-b","workspace:b"]'].dependencies = [
      ['lib', 'virtual:one#npm:1.0.0'],
    ]
    nodeAssert.throws(() =>
      projection.assertGraph(
        projection.graph(before).nodes,
        projection.graph(after).nodes
      )
    )
  }
)

nodeTest(
  'legitimate node-gyp self-reference is not an injected package',
  () => {
    /** @type {Parameters<typeof projection.candidates>[0]} */
    const state = { roots: [], packages: {} }
    for (const record of originalRecords())
      state.packages[JSON.stringify([record.name, 'npm:' + record.version])] = {
        location: record.name,
        manifest: record.manifest,
        peers: [],
        dependencies: [['node-gyp', 'npm:12.2.0']],
      }
    state.packages['["node-gyp","npm:12.2.0"]'] = {
      location: 'node-gyp',
      manifest: { name: 'node-gyp', version: '12.2.0' },
      peers: [],
      dependencies: [['node-gyp', 'npm:12.2.0']],
    }
    nodeAssert.equal(projection.candidates(state).length, 11)
  }
)

nodeTest(
  'inventory records fixture links without following or reading target bodies',
  () =>
    fixture(root => {
      fs.mkdirSync(path.join(root, '.yarn/cache'), { recursive: true })
      const location = '.runtime-native-packages/fixture'
      fs.mkdirSync(path.join(root, location), { recursive: true })
      fs.writeFileSync(
        path.join(root, location, 'package.json'),
        '{"name":"public-fixture","version":"1.0.0"}'
      )
      fs.symlinkSync('/etc', path.join(root, location, 'external'))
      nodeAssert.doesNotThrow(() => {
        const result = projection.inventory(
          root,
          {
            roots: [],
            packages: {
              fixture: {
                location,
                dependencies: [],
                peers: [],
                manifest: null,
              },
            },
          },
          ''
        )
        nodeAssert.equal(result.symlinks.length, 1)
        nodeAssert.equal(result.symlinks[0].followed, false)
      })
    })
)

nodeTest('null unresolved peer alias removal is graph drift', () => {
  /** @type {Parameters<typeof projection.graph>[0]} */
  const before = {
    roots: [{ name: 'app', reference: 'workspace:.' }],
    packages: {
      '["app","workspace:."]': {
        location: '',
        manifest: null,
        peers: ['unresolved'],
        dependencies: [['unresolved', null]],
      },
    },
  }
  const after = structuredClone(before)
  after.packages['["app","workspace:."]'].dependencies = []
  nodeAssert.throws(() =>
    projection.assertGraph(
      projection.graph(before).nodes,
      projection.graph(after).nodes
    )
  )
})

nodeTest(
  'off-map sibling code or a file outside mapped package subtrees refuses',
  () => {
    for (const sibling of ['package', 'file'])
      fixture(root => {
        fs.mkdirSync(path.join(root, '.yarn/cache'), { recursive: true })
        const location = '.yarn/unplugged/keep/node_modules/kept'
        fs.mkdirSync(path.join(root, location), { recursive: true })
        fs.writeFileSync(
          path.join(root, location, 'package.json'),
          '{"name":"kept","version":"1.0.0"}'
        )
        if (sibling === 'package') {
          fs.mkdirSync(
            path.join(root, '.yarn/unplugged/keep/node_modules/off-map')
          )
          fs.writeFileSync(
            path.join(
              root,
              '.yarn/unplugged/keep/node_modules/off-map/package.json'
            ),
            '{"name":"off-map","version":"9.9.9"}'
          )
          fs.writeFileSync(
            path.join(
              root,
              '.yarn/unplugged/keep/node_modules/off-map/index.js'
            ),
            'public unexecuted fixture'
          )
        } else
          fs.writeFileSync(
            path.join(root, '.yarn/unplugged/keep/unknown-code.js'),
            'public unexecuted fixture'
          )
        const state = {
          roots: [],
          packages: {
            '["kept","npm:1.0.0"]': {
              location,
              dependencies: [],
              peers: [],
              manifest: null,
            },
          },
        }
        nodeAssert.throws(() => {
          const r = projection.retained(root, state)
          projection.prune(root, r.cache, r.unplugged)
          projection.inventory(root, state, '')
        })
      })
  }
)

nodeTest(
  'intermediate node_modules links refuse before external manifest reads',
  () =>
    fixture(base => {
      const root = path.join(base, 'image'),
        outside = path.join(base, 'outside')
      fs.mkdirSync(path.join(root, '.yarn/cache'), { recursive: true })
      fs.mkdirSync(path.join(root, '.yarn/unplugged/keep'), { recursive: true })
      fs.mkdirSync(path.join(outside, 'kept'), { recursive: true })
      fs.writeFileSync(
        path.join(outside, 'kept/package.json'),
        '{"name":"outside-public-fixture","version":"1.0.0"}'
      )
      fs.symlinkSync(
        outside,
        path.join(root, '.yarn/unplugged/keep/node_modules')
      )
      const location = '.yarn/unplugged/keep/node_modules/kept'
      const state = {
        roots: [],
        packages: {
          '["kept","npm:1.0.0"]': {
            location,
            dependencies: [],
            peers: [],
            manifest: null,
          },
        },
      }
      nodeAssert.throws(() => {
        const r = projection.retained(root, state)
        projection.prune(root, r.cache, r.unplugged)
        projection.inventory(root, state, '')
      })
    })
)

nodeTest(
  'projection requires the official PnP3 filesystem before package work',
  () => {
    projection.requirePnp('3')
    for (const version of [undefined, '', '2', '4'])
      nodeAssert.throws(
        () => projection.requirePnp(version),
        /official-pnp-filesystem-required/
      )
  }
)
