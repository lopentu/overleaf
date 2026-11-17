// @ts-check
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const ROOT = '/overleaf'
const SCRIPT = '/run/overleaf-runtime-dependencies.cjs'
const PORTALS = '.runtime-native-packages'
const COREPACK = path.join(path.dirname(process.execPath), 'corepack')
const REVIEWED = new Set([
  '@google-cloud/profiler@7.0.0',
  'bcrypt@6.0.0',
  'cpu-features@0.0.10',
  'dtrace-provider@0.8.8',
  'mmmagic@0.5.3',
  'msgpackr-extract@3.0.3',
  'nan@2.26.2',
  'nan@2.28.0',
  'node-addon-api@8.7.0',
  'pprof@5.0.0',
  'utf-8-validate@5.0.8',
])
const ABSENT_FOREIGN_OPTIONALS = new Set([
  '@msgpackr-extract/msgpackr-extract-linux-arm@3.0.3',
  '@msgpackr-extract/msgpackr-extract-win32-x64@3.0.3',
])

/** @typedef {{name:string, version?:string, packageManager?:string, dependencies?:Record<string,string>, peerDependencies?:Record<string,string>, scripts?:Record<string,string>, resolutions?:Record<string,string>}} Manifest */
/** @typedef {{name:string, reference:string}} Locator */
/** @typedef {{location:string, dependencies:Array<[string,string|[string,string]|null]>, peers:string[], manifest:Manifest|null}} Package */
/** @typedef {{roots:Locator[], packages:Record<string,Package>}} Snapshot */
/** @typedef {{name:string,version:string,manifest:Manifest,location:string}} Candidate */
/** @typedef {Record<string,string[]>} Graph */
/** @typedef {{getAllLocators:()=>Iterable<Locator>,getDependencyTreeRoots:()=>Locator[],getPackageInformation:(l:Locator)=>{packageLocation:string,packageDependencies:Map<string,string|[string,string]|null>,packagePeers:Set<string>},resolveVirtual:(p:string)=>string|null}} Pnp */

class ProjectionRefusal extends Error {}

/** @param {unknown} condition @param {string} code @returns {asserts condition} */
function requireCondition(condition, code) {
  if (!condition) throw new ProjectionRefusal(code)
}

/** @param {string} file */
function manifest(file) {
  requireCondition(
    fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
    'regular-package-manifest'
  )
  /** @type {Manifest} */
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  requireCondition(
    value && typeof value.name === 'string',
    'package-manifest-name'
  )
  return value
}

/** @param {{uid:number,cwd:string,realRoot:string,script:string,marker:string,project:string,yarn:string,mountinfo:string}} state */
function validateContext(state) {
  requireCondition(
    state.uid === 0 &&
      state.cwd === ROOT &&
      state.realRoot === ROOT &&
      state.script === SCRIPT &&
      state.marker === '1' &&
      state.project === 'overleaf' &&
      state.yarn === 'yarn@4.18.0',
    'final-image-context'
  )
  requireCondition(
    state.mountinfo.split('\n').some(line => {
      const columns = line.split(' ')
      return columns[4] === SCRIPT && columns[5]?.split(',').includes('ro')
    }),
    'readonly-build-context'
  )
}

/** @param {string} lock @param {string} name @param {string} version */
function lockDescriptors(lock, name, version) {
  // Yarn4's lock record keys and resolution values are JSON-quoted strings.
  // Do not implement a YAML resolver or infer versions from cache filenames.
  const records = lock
    .split('\n\n')
    .filter(block =>
      block
        .split('\n')
        .includes(`  resolution: ${JSON.stringify(name + '@npm:' + version)}`)
    )
  requireCondition(records.length === 1, 'unique-original-lock-record')
  const header = records[0].split('\n')[0]
  requireCondition(
    header.startsWith('"') && header.endsWith('":'),
    'lock-record-header'
  )
  /** @type {unknown} */
  const decoded = JSON.parse(header.slice(0, -1))
  requireCondition(typeof decoded === 'string', 'lock-descriptors')
  const descriptors = decoded.split(', ')
  requireCondition(
    descriptors.length > 0 &&
      descriptors.every(d => d.startsWith(name + '@npm:')),
    'original-npm-descriptors'
  )
  return descriptors
}

/** @param {Array<{name:string,version:string,manifest:Manifest}>} records */
function validateCandidates(records) {
  const identities = records.map(r => r.name + '@' + r.version)
  requireCondition(
    records.length === REVIEWED.size &&
      new Set(identities).size === REVIEWED.size &&
      identities.every(x => REVIEWED.has(x)),
    'reviewed-injected-package-set'
  )
  for (const record of records) {
    const m = record.manifest
    requireCondition(
      m.name === record.name &&
        m.version === record.version &&
        !Object.hasOwn(m.dependencies || {}, 'node-gyp') &&
        !Object.hasOwn(m.peerDependencies || {}, 'node-gyp'),
      'original-undeclared-compiler-edge'
    )
    requireCondition(
      Object.values(m.scripts || {}).some(s =>
        /\b(node-gyp|prebuild-install)\b/.test(s)
      ),
      'yarn418-script-injection-rule'
    )
  }
}

/** @param {string} file @param {string} [algorithm] */
function digest(file, algorithm = 'sha256') {
  const hash = nodeCrypto.createHash(algorithm)
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** @param {string} directory @param {(file:string)=>void} visit @param {(file:string)=>void} [onLink] */
function walk(directory, visit, onLink) {
  requireCondition(
    fs.lstatSync(directory).isDirectory() &&
      !fs.lstatSync(directory).isSymbolicLink(),
    'real-code-directory'
  )
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) {
      requireCondition(onLink, 'code-payload-link')
      onLink(file)
      continue
    }
    if (stat.isDirectory()) walk(file, visit, onLink)
    else {
      requireCondition(stat.isFile(), 'regular-code-payload')
      visit(file)
    }
  }
}

/** @param {string} directory */
function payload(directory) {
  /** @type {Record<string,string>} */
  const result = {}
  walk(directory, file => {
    result[path.relative(directory, file)] = digest(file)
  })
  return result
}

/** @param {string} root @param {string} location */
function owned(root, location) {
  const file = path.resolve(root, location)
  requireCondition(
    file.startsWith(root + '/') &&
      !path.relative(root, file).split(path.sep).includes('..'),
    'owned-package-path'
  )
  requireCondition(fs.realpathSync(root) === root, 'real-project-root')
  let current = root
  for (const component of path.relative(root, file).split(path.sep)) {
    current = path.join(current, component)
    try {
      requireCondition(
        !fs.lstatSync(current).isSymbolicLink(),
        'package-ancestor-link'
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        break
      throw error
    }
  }
  return file
}

/** @param {Snapshot} snapshot */
function candidates(snapshot) {
  /** @type {Candidate[]} */
  const records = []
  for (const [key, info] of Object.entries(snapshot.packages)) {
    /** @type {[string,string]} */
    const [name, ref] = JSON.parse(key)
    if (
      name === 'node-gyp' || // PnP self-dependencies are not injected edges.
      !ref.startsWith('npm:') ||
      !info.dependencies.some(([alias]) => alias === 'node-gyp')
    )
      continue
    requireCondition(info.manifest, 'injected-package-present')
    const m = info.manifest
    if (
      Object.hasOwn(m.dependencies || {}, 'node-gyp') ||
      Object.hasOwn(m.peerDependencies || {}, 'node-gyp')
    )
      continue
    requireCondition(typeof m.version === 'string', 'original-package-version')
    records.push({
      name,
      version: m.version,
      manifest: m,
      location: info.location,
    })
  }
  validateCandidates(records)
  return records
}

/** @param {Snapshot} snapshot @param {boolean} [removeInjected] */
function graph(snapshot, removeInjected = false) {
  /** @type {Graph} */
  const result = {}
  const seen = new Set()
  const queue = snapshot.roots.map(r => JSON.stringify([r.name, r.reference]))
  let removed = 0
  /** @param {string} key */
  function canonical(key) {
    /** @type {[string,string]} */
    const [name, original] = JSON.parse(key)
    // Preserve the exact virtual locator: its consumer binding is semantic.
    // All surviving Yarn4.18 virtual locators remain stable in this projection.
    let ref = original
    if (ref.startsWith('portal:')) {
      const m = snapshot.packages[key]?.manifest
      requireCondition(
        m?.name === name &&
          typeof m.version === 'string' &&
          REVIEWED.has(name + '@' + m.version),
        'portal-real-manifest-version'
      )
      ref = 'npm:' + m.version
    }
    return [name, ref]
  }
  while (queue.length) {
    const key = queue.shift()
    requireCondition(key && snapshot.packages[key], 'graph-node-present')
    if (seen.has(key)) continue
    seen.add(key)
    const info = snapshot.packages[key]
    const identity = canonical(key)
    const edges = []
    for (const [alias, ref] of info.dependencies) {
      if (ref === null) {
        edges.push([alias, null])
        continue
      }
      if (
        removeInjected &&
        alias === 'node-gyp' &&
        REVIEWED.has(identity[0] + '@' + identity[1].replace(/^npm:/, ''))
      ) {
        removed++
        continue
      }
      const target = JSON.stringify(Array.isArray(ref) ? ref : [alias, ref])
      edges.push([alias, ...canonical(target)])
      queue.push(target)
    }
    edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const value = JSON.stringify({ edges, peers: [...info.peers].sort() })
    const node = JSON.stringify(identity)
    result[node] ||= []
    if (!result[node].includes(value)) result[node].push(value)
    result[node].sort()
  }
  return { nodes: result, removed }
}

/** @param {Graph} expected @param {Graph} actual */
function assertGraph(expected, actual) {
  const keys = Object.keys(expected).sort()
  requireCondition(
    JSON.stringify(keys) === JSON.stringify(Object.keys(actual).sort()) &&
      keys.every(
        k => JSON.stringify(expected[k]) === JSON.stringify(actual[k])
      ),
    'only-injected-graph-delta'
  )
}

/** @param {string} root @param {Snapshot} snapshot */
function retained(root, snapshot) {
  const cache = new Set()
  const unplugged = new Set()
  const missingOptional = []
  for (const [key, info] of Object.entries(snapshot.packages)) {
    const location = info.location
    if (location.includes('.zip/'))
      cache.add(path.basename(location.split('.zip/')[0]) + '.zip')
    if (location.startsWith('.yarn/unplugged/')) {
      if (fs.existsSync(owned(root, location)))
        unplugged.add(location.split('/')[2])
      else {
        /** @type {[string,string]} */
        const [name, ref] = JSON.parse(key)
        requireCondition(
          ABSENT_FOREIGN_OPTIONALS.has(name + '@' + ref.replace(/^npm:/, '')),
          'missing-required-unplugged-payload'
        )
        missingOptional.push({
          locator: key,
          location,
          physical_payload_present: false,
        })
      }
    }
  }
  for (const name of unplugged) {
    const prefix = '.yarn/unplugged/' + name + '/'
    const directory = owned(root, prefix)
    requireCondition(
      JSON.stringify(fs.readdirSync(directory).sort()) === '["node_modules"]',
      'unmapped-unplugged-root-code'
    )
    const expected = new Set(
      Object.values(snapshot.packages)
        .map(info => info.location)
        .filter(
          location =>
            location.startsWith(prefix) && fs.existsSync(owned(root, location))
        )
    )
    const modules = owned(root, prefix + 'node_modules')
    const actual = fs
      .readdirSync(modules)
      .flatMap(entry =>
        entry.startsWith('@')
          ? fs
              .readdirSync(owned(root, prefix + 'node_modules/' + entry))
              .map(child => prefix + 'node_modules/' + entry + '/' + child)
          : [prefix + 'node_modules/' + entry]
      )
    requireCondition(
      actual.length === expected.size &&
        actual.every(
          location =>
            expected.has(location) &&
            fs.lstatSync(owned(root, location)).isDirectory()
        ),
      'unmapped-unplugged-package-code'
    )
  }
  return { cache, unplugged, missingOptional }
}

/** @param {string} root @param {Set<string>} cache @param {Set<string>} unplugged */
function prune(root, cache, unplugged) {
  const cacheRoot = owned(root, '.yarn/cache')
  const unpluggedRoot = owned(root, '.yarn/unplugged')
  for (const directory of [owned(root, '.yarn'), cacheRoot, unpluggedRoot])
    requireCondition(
      fs.lstatSync(directory).isDirectory() &&
        !fs.lstatSync(directory).isSymbolicLink(),
      'owned-prune-parent'
    )
  const zipFiles = fs.readdirSync(cacheRoot).filter(n => n !== '.gitignore')
  const codeRoots = fs
    .readdirSync(unpluggedRoot)
    .filter(n => n !== '.gitignore')
  requireCondition(
    zipFiles.every(
      n =>
        n.endsWith('.zip') &&
        fs.lstatSync(path.join(cacheRoot, n)).isFile() &&
        !fs.lstatSync(path.join(cacheRoot, n)).isSymbolicLink()
    ) &&
      codeRoots.every(
        n =>
          fs.lstatSync(path.join(unpluggedRoot, n)).isDirectory() &&
          !fs.lstatSync(path.join(unpluggedRoot, n)).isSymbolicLink()
      ),
    'closed-cache-shape'
  )
  requireCondition(
    [...cache].every(n => zipFiles.includes(n)) &&
      [...unplugged].every(n => codeRoots.includes(n)),
    'required-physical-code-present'
  )
  /** @type {Array<{path:string,bytes:number,sha256?:string}>} */
  const removed = []
  for (const name of zipFiles)
    if (!cache.has(name)) {
      const file = path.join(cacheRoot, name)
      removed.push({
        path: path.relative(root, file),
        bytes: fs.statSync(file).size,
        sha256: digest(file),
      })
      fs.unlinkSync(file)
    }
  for (const name of codeRoots)
    if (!unplugged.has(name)) {
      const directory = path.join(unpluggedRoot, name)
      let bytes = 0
      walk(directory, file => {
        bytes += fs.statSync(file).size
      })
      removed.push({ path: path.relative(root, directory), bytes })
      fs.rmSync(directory, { recursive: true })
    }
  requireCondition(
    JSON.stringify(
      fs
        .readdirSync(cacheRoot)
        .filter(n => n !== '.gitignore')
        .sort()
    ) === JSON.stringify([...cache].sort()) &&
      JSON.stringify(
        fs
          .readdirSync(unpluggedRoot)
          .filter(n => n !== '.gitignore')
          .sort()
      ) === JSON.stringify([...unplugged].sort()),
    'exact-final-physical-closure'
  )
  return removed
}

/** @param {string[]} args @param {string} root */
function command(args, root) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      COREPACK_ENABLE_NETWORK: '0',
      YARN_ENABLE_NETWORK: '0',
      YARN_ENABLE_SCRIPTS: '0',
      YARN_ENABLE_TELEMETRY: '0',
      YARN_ENABLE_GLOBAL_CACHE: '0',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '0',
      YARN_ENABLE_HARDENED_MODE: '0',
    },
  })
  requireCondition(
    !result.error && result.status === 0,
    'offline-projection-child-failed'
  )
  return result.stdout
}

/** @param {string} root @returns {Snapshot} */
function readSnapshot(root) {
  return JSON.parse(
    command(
      [
        process.execPath,
        '--require',
        path.join(root, '.pnp.cjs'),
        '-e',
        'process.stdout.write(JSON.stringify(require(process.argv[1]).snapshot(process.cwd())))',
        __filename,
      ],
      root
    )
  )
}

/** @param {string} root @returns {Snapshot} */
function snapshot(root) {
  requireCondition(fs.realpathSync(root) === root, 'real-project-root')
  /** @type {Pnp} */
  const api = require(path.join(root, '.pnp.cjs'))
  /** @type {Record<string,Package>} */
  const packages = {}
  for (const locator of api.getAllLocators()) {
    const info = api.getPackageInformation(locator)
    const resolved =
      api.resolveVirtual(info.packageLocation) || info.packageLocation
    const actual =
      path.resolve(resolved) === root ? root : owned(root, resolved)
    requireCondition(
      actual === root || actual.startsWith(root + '/'),
      'pnp-package-confinement'
    )
    const location = path.relative(root, actual)
    const file = path.join(actual, 'package.json')
    packages[JSON.stringify([locator.name, locator.reference])] = {
      location,
      dependencies: [...info.packageDependencies],
      peers: [...info.packagePeers],
      manifest: fs.existsSync(file) ? manifest(file) : null,
    }
  }
  return { roots: api.getDependencyTreeRoots(), packages }
}

/** @param {string} root @param {Candidate[]} selected @param {string} lock */
function materialize(root, selected, lock) {
  const nativeRoot = owned(root, PORTALS)
  fs.mkdirSync(nativeRoot)
  const rootFile = path.join(root, 'package.json')
  const original = manifest(rootFile)
  const resolutions = { ...original.resolutions }
  const proofs = []
  for (const record of selected) {
    const source = owned(root, record.location)
    const relative =
      PORTALS +
      '/' +
      record.name.replace(/^@/, '').replaceAll('/', '-') +
      '-' +
      record.version
    const target = owned(root, relative)
    const before = payload(source)
    fs.mkdirSync(target)
    for (const name of Object.keys(before)) {
      const file = path.join(target, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, fs.readFileSync(path.join(source, name)), {
        flag: 'wx',
        mode: fs.statSync(path.join(source, name)).mode & 0o777,
      })
    }
    requireCondition(
      JSON.stringify(payload(target)) === JSON.stringify(before),
      'materialized-full-payload'
    )
    for (const descriptor of lockDescriptors(lock, record.name, record.version))
      resolutions[descriptor] = 'portal:./' + relative
    if (Object.hasOwn(original.resolutions || {}, record.name)) {
      requireCondition(
        [record.version, 'npm:' + record.version].includes(
          resolutions[record.name]
        ) && selected.filter(r => r.name === record.name).length === 1,
        'same-version-unqualified-resolution'
      )
      resolutions[record.name] = 'portal:./' + relative
    }
    proofs.push({
      name: record.name,
      version: record.version,
      location: relative,
      manifest_sha256: digest(path.join(target, 'package.json')),
      payload: before,
    })
  }
  original.resolutions = resolutions
  fs.writeFileSync(rootFile, JSON.stringify(original, null, 2) + '\n')
  return proofs
}

/** @param {string} root @param {Snapshot} state @param {string} originalLock */
function inventory(root, state, originalLock) {
  retained(root, state) // Validate complete retained roots, including sibling code.
  const locations = new Map(
    Object.entries(state.packages).map(([key, info]) => [info.location, key])
  )
  const rows = []
  /** @type {Array<{path:string,manifest_sha256:string,name:string|null,version:string|null,classification:string}>} */
  const nested = []
  /** @type {Array<{path:string,target_sha256:string,followed:false}>} */
  const symlinks = []
  /** @param {string} directory @param {string} kind @param {string} display */
  function packageTree(directory, kind, display) {
    owned(root, path.relative(root, directory))
    const file = path.join(directory, 'package.json')
    const m = manifest(file)
    const row = {
      kind,
      name: m.name,
      version: m.version || null,
      path: display,
      manifest_sha256: digest(file),
      locator: locations.get(path.relative(root, directory)) || null,
    }
    rows.push(row)
    walk(
      directory,
      child => {
        if (child === file || path.basename(child) !== 'package.json') return
        const bytes = fs.readFileSync(child)
        /** @type {{name?:unknown,version?:unknown}|null} */
        let body = null
        try {
          body = JSON.parse(bytes.toString())
        } catch {
          /* Keep malformed test metadata in the coverage census. */
        }
        nested.push({
          path: display + '/' + path.relative(directory, child),
          manifest_sha256: nodeCrypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex'),
          name: typeof body?.name === 'string' ? body.name : null,
          version: typeof body?.version === 'string' ? body.version : null,
          classification:
            'nested metadata; no independent registry provenance asserted',
        })
      },
      child => {
        symlinks.push({
          path: display + '/' + path.relative(directory, child),
          target_sha256: nodeCrypto
            .createHash('sha256')
            .update(fs.readlinkSync(child))
            .digest('hex'),
          followed: false,
        })
      }
    )
    return row
  }
  for (const name of fs
    .readdirSync(owned(root, '.yarn/cache'))
    .filter(n => n.endsWith('.zip'))
    .sort()) {
    const file = path.join(root, '.yarn/cache', name)
    const modules = path.join(file, 'node_modules')
    const names = fs
      .readdirSync(modules)
      .flatMap(n =>
        n.startsWith('@')
          ? fs.readdirSync(path.join(modules, n)).map(child => n + '/' + child)
          : [n]
      )
    requireCondition(names.length === 1, 'zip-root-package-set')
    const row = packageTree(
      path.join(modules, names[0]),
      'zip',
      '.yarn/cache/' + name
    )
    const sha512 = digest(file, 'sha512')
    const origin = originalLock
      .split('\n\n')
      .filter(block => block.includes('/' + sha512 + '\n'))
      .map(block =>
        block
          .split('\n')
          .find(line => line.startsWith('  resolution: '))
          ?.slice(14)
      )
    rows[rows.length - 1] = {
      ...row,
      bytes: fs.statSync(file).size,
      sha256: digest(file),
      original_lock_resolution_records: origin,
    }
  }
  for (const location of [
    ...new Set(Object.values(state.packages).map(info => info.location)),
  ].sort()) {
    if (
      !location.startsWith('.yarn/unplugged/') &&
      !location.startsWith(PORTALS + '/')
    )
      continue
    const directory = owned(root, location)
    if (!fs.existsSync(path.join(directory, 'package.json'))) continue
    packageTree(
      directory,
      location.startsWith(PORTALS + '/') ? 'portal' : 'unplugged',
      location
    )
  }
  return {
    packages: rows,
    symlinks,
    nested_package_json_metadata: nested,
    workspaces: Object.entries(state.packages)
      .filter(([key]) => key.includes('workspace:'))
      .map(([locator, info]) => ({ locator, location: info.location })),
    https_forks: Object.entries(state.packages)
      .filter(([key]) => key.includes('https:'))
      .map(([locator, info]) => ({ locator, location: info.location })),
  }
}

/** @param {string} root */
function focus(root) {
  command(
    [COREPACK, 'yarn', 'workspaces', 'focus', '--all', '--production'],
    root
  )
}

/** @param {string} root */
function project(root) {
  requirePnp(process.versions.pnp)
  requireCondition(
    root === ROOT ||
      (process.env.GITHUB_ACTIONS === 'true' &&
        process.env.RUNNER_TEMP &&
        root === path.join(process.env.RUNNER_TEMP, 'overleaf-runtime-audit') &&
        root !== process.env.GITHUB_WORKSPACE),
    'fixed-projection-destination'
  )
  requireCondition(
    command([COREPACK, 'yarn', '--version'], root).trim() === '4.18.0',
    'official-yarn-version'
  )
  const originalLock = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8')
  const originalPnp = digest(path.join(root, '.pnp.cjs'))
  const before = readSnapshot(root)
  const selected = candidates(before)
  const expected = graph(before, true)
  requireCondition(expected.removed === 11, 'eleven-injected-edges')
  const proofs = materialize(root, selected, originalLock)
  focus(root)
  const after = readSnapshot(root)
  assertGraph(expected.nodes, graph(after).nodes)
  requireCondition(
    !Object.keys(after.packages).some(k =>
      ['node-gyp', 'picomatch', 'tinyglobby', 'fdir'].includes(JSON.parse(k)[0])
    ),
    'unused-build-support-remains'
  )
  for (const proof of proofs)
    requireCondition(
      JSON.stringify(payload(owned(root, proof.location))) ===
        JSON.stringify(proof.payload),
      'original-payload-after-yarn'
    )
  const retainedCode = retained(root, after)
  const removed = prune(root, retainedCode.cache, retainedCode.unplugged)
  for (const proof of proofs)
    requireCondition(
      JSON.stringify(payload(owned(root, proof.location))) ===
        JSON.stringify(proof.payload),
      'original-payload-after-prune'
    )
  const receipt = {
    schema: 1,
    yarn: '4.18.0',
    original_pnp_sha256: originalPnp,
    generated_pnp_sha256: digest(path.join(root, '.pnp.cjs')),
    original_lock_sha256: nodeCrypto
      .createHash('sha256')
      .update(originalLock)
      .digest('hex'),
    generated_lock_sha256: digest(path.join(root, 'yarn.lock')),
    injected_edges_removed: expected.removed,
    original_packages: proofs,
    removed,
    missing_optional: retainedCode.missingOptional,
    ...inventory(root, after, originalLock),
    security_or_runtime_qualified: false,
  }
  return receipt
}

function main() {
  const rootManifest = manifest(path.join(process.cwd(), 'package.json'))
  validateContext({
    uid: process.getuid?.() ?? -1,
    cwd: process.cwd(),
    realRoot: fs.realpathSync(process.cwd()),
    script: __filename,
    marker: process.env.OVERLEAF_FINAL_RUNTIME_BUILD || '',
    project: rootManifest.name,
    yarn: rootManifest.packageManager || '',
    mountinfo: fs.readFileSync('/proc/self/mountinfo', 'utf8'),
  })
  requireCondition(
    process.argv[2] === '--final-image-build',
    'explicit-build-command'
  )
  const receipt = project(ROOT)
  fs.mkdirSync('/usr/share/overleaf', { recursive: true })
  fs.writeFileSync(
    '/usr/share/overleaf/runtime-dependencies.json',
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o644 }
  )
}

/** @typedef {{kind:string,name:string,version:string|null,locator:string|null,original_lock_resolution_records?:Array<string|undefined>}} AuditPackage */
/** @param {{packages:AuditPackage[],nested_package_json_metadata:Array<{name:string|null,version:string|null}>}} census */
function sbom(census) {
  const portals = census.packages
    .filter(p => p.kind === 'portal')
    .map(p => p.name + '@' + p.version)
  requireCondition(
    portals.length === 11 &&
      new Set(portals).size === 11 &&
      portals.every(p => REVIEWED.has(p)),
    'complete-portal-audit-identities'
  )
  /** @type {Map<string,{name:string,version:string,classes:Set<string>}>} */
  const identities = new Map()
  /** @param {string} name @param {string} version @param {string} classification */
  function add(name, version, classification) {
    requireCondition(
      name.length > 0 &&
        version.length > 0 &&
        !/\s/.test(name + version) &&
        [...(name + version)].every(
          c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127
        ),
      'audit-identity'
    )
    const key = JSON.stringify([name, version])
    if (!identities.has(key))
      identities.set(key, { name, version, classes: new Set() })
    identities.get(key)?.classes.add(classification)
  }
  const forks = new Map([
    ['diff-match-patch@1.0.5', '1.0.5'],
    ['fast-crc32c@2.0.0', '2.0.0'],
    ['socket.io@0.9.19-overleaf-12', '0.9.19'],
    ['socket.io-client@0.9.17-overleaf-6', '0.9.17'],
  ])
  for (const pkg of census.packages) {
    requireCondition(
      typeof pkg.version === 'string' && typeof pkg.locator === 'string',
      'complete-root-package-identity'
    )
    add(pkg.name, pkg.version, 'actual-physical-manifest')
    /** @type {[string,string]} */
    const locator = JSON.parse(pkg.locator)
    requireCondition(locator[0] === pkg.name, 'actual-locator-package-name')
    let ref = locator[1]
    if (ref.startsWith('virtual:')) ref = ref.slice(ref.indexOf('#') + 1)
    if (ref.startsWith('portal:')) {
      requireCondition(
        pkg.kind === 'portal' && REVIEWED.has(pkg.name + '@' + pkg.version),
        'original-portal-version'
      )
      add(pkg.name, pkg.version, 'original-registry-portal-version')
    } else if (ref.startsWith('patch:')) {
      const source = decodeURIComponent(ref.slice(6).split('#')[0])
      const split = source.lastIndexOf('@npm:')
      requireCondition(
        split > 0 && source.slice(0, split) === pkg.name,
        'original-patch-npm-identity'
      )
      add(
        pkg.name,
        source.slice(split + 5),
        'patched-original-registry-version'
      )
    } else if (ref.startsWith('https:')) {
      const base = forks.get(pkg.name + '@' + pkg.version)
      requireCondition(base, 'reviewed-fork-baseline')
      add(
        pkg.name,
        base,
        'fork-upstream-nominal-candidate-not-applicability-proof'
      )
    } else {
      requireCondition(
        ref === 'npm:' + pkg.version,
        'registry-manifest-version'
      )
      add(pkg.name, pkg.version, 'original-registry-version')
    }
  }
  for (const pkg of census.nested_package_json_metadata)
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string')
      add(pkg.name, pkg.version, 'nested-manifest-nominal-candidate')
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    components: [...identities.values()]
      .sort((a, b) =>
        JSON.stringify([a.name, a.version]).localeCompare(
          JSON.stringify([b.name, b.version])
        )
      )
      .map(p => {
        const purl =
          'pkg:npm/' +
          encodeURIComponent(p.name).replaceAll('%2F', '/') +
          '@' +
          encodeURIComponent(p.version)
        return {
          type: 'library',
          name: p.name,
          version: p.version,
          purl,
          'bom-ref': purl,
          properties: [
            {
              name: 'lope.audit.identity-classification',
              value: [...p.classes].sort().join(';'),
            },
          ],
        }
      }),
  }
}

/** @param {string|undefined} version */
function requirePnp(version) {
  requireCondition(version === '3', 'official-pnp-filesystem-required')
}

module.exports = {
  validateContext,
  lockDescriptors,
  validateCandidates,
  assertGraph,
  payload,
  prune,
  graph,
  retained,
  materialize,
  command,
  inventory,
  snapshot,
  candidates,
  ProjectionRefusal,
  project,
  requirePnp,
  focus,
  sbom,
  digest,
}
if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        failed: true,
        failure_class: 'RuntimeProjection',
        failure_code:
          error instanceof ProjectionRefusal
            ? error.message
            : 'source-or-filesystem-error',
      }) + '\n'
    )
    process.exitCode = 1
  }
}
