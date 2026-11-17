// @ts-check
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const SCRIPT = '/run/overleaf-runtime-cleanup.cjs'
const NPM = '/usr/lib/node_modules/npm'
const LINKS = new Map([
  ['/usr/bin/npm', '../lib/node_modules/npm/bin/npm-cli.js'],
  ['/usr/bin/npx', '../lib/node_modules/npm/bin/npx-cli.js'],
])
const PARENTS = ['/usr', '/usr/lib', '/usr/lib/node_modules', '/usr/bin']
const LIST_HASH =
  '61512aa81bf4d8b400885228c9154b8c45e01b2da1ee7d3e38b6fe1eb5002162'
const REMOVALS = new Map([
  ['build-essential', '12.10ubuntu1'],
  ['g++', '4:13.2.0-7ubuntu1'],
  ['g++-13', '13.3.0-6ubuntu2~24.04.1'],
  ['g++-x86-64-linux-gnu', '4:13.2.0-7ubuntu1'],
  ['g++-13-x86-64-linux-gnu', '13.3.0-6ubuntu2~24.04.1'],
  ['zlib1g-dev', '1:1.3.dfsg-3.1ubuntu2.3'],
  ['libpcre3-dev', '2:8.39-15build1'],
  ['libstdc++-13-dev', '13.3.0-6ubuntu2~24.04.1'],
  ['libc6-dev', '2.39-0ubuntu8.12'],
  ['linux-libc-dev', '6.8.0-149.149'],
])
const PRESERVED = [
  '/usr/bin/node',
  '/usr/lib/node_modules/corepack',
  '/usr/lib/node_modules/corepack/package.json',
  '/usr/bin/corepack',
  '/usr/bin/yarn',
  '/usr/bin/yarnpkg',
  '/opt/corepack',
  '/usr/local/texlive/2026',
  '/usr/local/bin/latexmk',
  '/usr/bin/python',
  '/usr/bin/python3',
  '/usr/bin/perl',
  '/usr/bin/gcc',
  '/usr/bin/make',
  '/usr/bin/git',
]

/** @param {string} code @returns {never} */
function fail(code) {
  throw new Error(code)
}

/** @param {string} text */
function validateRemovalPlan(text) {
  const seen = new Set()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (/^(Inst|Conf|Purg)\b/.test(line)) fail('unexpected-package-action')
    if (!/^Remv\b/.test(line)) continue
    const match = /^Remv ([a-z0-9][a-z0-9+.-]*)(?::amd64)? \[([^\]]+)\]$/.exec(
      line
    )
    if (!match || seen.has(match[1]) || REMOVALS.get(match[1]) !== match[2])
      fail('unexpected-removal')
    seen.add(match[1])
  }
  if (seen.size !== REMOVALS.size) fail('incomplete-removal-plan')
}

/** @typedef {{uid:number,cwd:string,script:string,buildIntent:string|undefined,nodeVersion:string,projectName:string,packageManager:string,mountinfo:string}} BuildContext */
/** @param {BuildContext} ctx */
function validateContext(ctx) {
  if (
    ctx.uid !== 0 ||
    ctx.cwd !== '/overleaf' ||
    ctx.script !== SCRIPT ||
    ctx.buildIntent !== '1' ||
    ctx.nodeVersion !== 'v24.22.3' ||
    ctx.projectName !== 'overleaf' ||
    ctx.packageManager !== 'yarn@4.18.0'
  )
    fail('final-image-build-only')
  const rows = ctx.mountinfo
    .split('\n')
    .filter(Boolean)
    .map(line => line.split(' - ')[0].split(' '))
  const matching = rows.filter(row => row[4] === SCRIPT)
  if (matching.length !== 1 || !matching[0][5].split(',').includes('ro'))
    fail('readonly-build-context-required')
}

/** @typedef {{path:string,uid:number,directory:boolean,symlink:boolean,mode:number}} DirectoryState */
/** @typedef {{path:string,uid:number,symlink:boolean,target:string}} LinkState */
/** @typedef {{nodeVersion:string,listHash:string,npmVersion:string,parents:DirectoryState[],tree:DirectoryState,links:LinkState[],ownedPaths:string[]}} NpmState */
/** @param {NpmState} state */
function validateNpmPaths(state) {
  if (
    state.nodeVersion !== '24.22.3-1nodesource1' ||
    state.listHash !== LIST_HASH ||
    state.npmVersion !== '11.19.1'
  )
    fail('unexpected-npm-owner')
  const parents = new Set(state.parents.map(row => row.path))
  if (
    parents.size !== PARENTS.length ||
    !PARENTS.every(name => parents.has(name))
  )
    fail('npm-parent-set')
  for (const row of [...state.parents, state.tree]) {
    if (
      row.uid !== 0 ||
      !row.directory ||
      row.symlink ||
      (row.mode & 0o022) !== 0
    )
      fail('unsafe-npm-path')
  }
  if (state.tree.path !== NPM || state.links.length !== LINKS.size)
    fail('npm-path-set')
  const seen = new Set()
  for (const link of state.links) {
    if (
      seen.has(link.path) ||
      link.uid !== 0 ||
      !link.symlink ||
      LINKS.get(link.path) !== link.target
    )
      fail('unsafe-npm-link')
    seen.add(link.path)
  }
  const owned = new Set(state.ownedPaths)
  if (![NPM, ...LINKS.keys()].every(name => owned.has(name)))
    fail('npm-not-nodejs-owned')
}

/** @param {string} text @param {Set<string>} removalNames @returns {Map<string,string>} */
function parseInstalled(text, removalNames) {
  const installed = new Map()
  for (const stanza of text.split(/\n\n+/)) {
    const fields = new Map(
      stanza
        .split('\n')
        .filter(line => /^[A-Za-z-]+: /.test(line))
        .map(line => {
          const index = line.indexOf(': ')
          return [line.slice(0, index), line.slice(index + 2)]
        })
    )
    if (fields.get('Status') !== 'install ok installed') continue
    const name = fields.get('Package'),
      version = fields.get('Version')
    if (!name || !version || installed.has(name))
      fail('invalid-installed-state')
    if (removalNames.has(name) && fields.get('Essential') === 'yes')
      fail('essential-removal-refused')
    installed.set(name, version)
  }
  if (!installed.size) fail('empty-installed-state')
  return installed
}

/** @param {Map<string,string>} before @param {Map<string,string>} after @param {Set<string>} removed */
function validateRetainedPackages(before, after, removed) {
  if (after.size !== before.size - removed.size) fail('remaining-package-count')
  for (const [name, version] of before) {
    if (removed.has(name) ? after.has(name) : after.get(name) !== version)
      fail('remaining-package-drift')
  }
}

/** @param {string} filename @param {number} limit */
function readBounded(filename, limit) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.size > limit) fail('public-build-file-required')
  const body = fs.readFileSync(filename)
  if (body.length > limit) fail('public-build-file-too-large')
  return body
}

/** @param {string} filename @returns {Record<string,unknown>} */
function publicObject(filename) {
  /** @type {unknown} */
  const value = JSON.parse(readBounded(filename, 65536).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('public-object-required')
  return /** @type {Record<string,unknown>} */ (value)
}

/** @param {string} filename */
function directoryState(filename) {
  const stat = fs.lstatSync(filename)
  return {
    path: filename,
    uid: stat.uid,
    directory: stat.isDirectory(),
    symlink: stat.isSymbolicLink(),
    mode: stat.mode & 0o777,
  }
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] */
function runCommand(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 ** 2,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LC_ALL: 'C',
      DEBIAN_FRONTEND: 'noninteractive',
      ...extraEnv,
    },
  })
  if (result.error || result.status !== 0) fail('package-command-failed')
  return result.stdout
}

/** @param {string} filename */
function fingerprint(filename) {
  const stat = fs.lstatSync(filename),
    real = fs.realpathSync(filename)
  const target = fs.statSync(real)
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    link: stat.isSymbolicLink() ? fs.readlinkSync(filename) : null,
    real,
    hash: target.isFile()
      ? nodeCrypto.hash('sha256', readBounded(real, 256 * 1024 ** 2))
      : null,
  }
}

/** @param {Map<string,string>} installed */
function verifyActualNpmPaths(installed) {
  const ownership = readBounded('/var/lib/dpkg/info/nodejs.list', 1024 ** 2)
  const npm = publicObject(NPM + '/package.json')
  validateNpmPaths({
    nodeVersion: installed.get('nodejs') || '',
    listHash: nodeCrypto.hash('sha256', ownership),
    npmVersion: String(npm.version),
    parents: PARENTS.map(directoryState),
    tree: directoryState(NPM),
    links: [...LINKS.keys()].map(filename => {
      const stat = fs.lstatSync(filename)
      return {
        path: filename,
        uid: stat.uid,
        symlink: stat.isSymbolicLink(),
        target: stat.isSymbolicLink() ? fs.readlinkSync(filename) : '',
      }
    }),
    ownedPaths: ownership.toString('utf8').split('\n'),
  })
  for (const filename of [...LINKS.keys()]) {
    if (
      fs.realpathSync(filename) !==
      path.resolve(path.dirname(filename), LINKS.get(filename) || '')
    )
      fail('npm-target-drift')
  }
}

function main() {
  if (
    process.getuid?.() !== 0 ||
    process.argv.length !== 3 ||
    process.argv[2] !== '--final-image-build' ||
    process.argv[1] !== SCRIPT ||
    process.env.OVERLEAF_FINAL_RUNTIME_BUILD !== '1'
  )
    fail('final-image-build-only')
  const pkg = publicObject('/overleaf/package.json')
  validateContext({
    uid: process.getuid(),
    cwd: fs.realpathSync(process.cwd()),
    script: fs.realpathSync(process.argv[1]),
    buildIntent: process.env.OVERLEAF_FINAL_RUNTIME_BUILD,
    nodeVersion: process.version,
    projectName: String(pkg.name),
    packageManager: String(pkg.packageManager),
    mountinfo: readBounded('/proc/self/mountinfo', 1024 ** 2).toString('utf8'),
  })
  const removed = new Set(REMOVALS.keys())
  if (runCommand('/usr/bin/dpkg', ['--audit']).trim())
    fail('incomplete-dpkg-state')
  const before = parseInstalled(
    readBounded('/var/lib/dpkg/status', 4 * 1024 ** 2).toString('utf8'),
    removed
  )
  for (const [name, version] of REMOVALS)
    if (before.get(name) !== version) fail('removal-version-drift')
  verifyActualNpmPaths(before)
  for (const filename of [
    '/usr/local/bin/npm',
    '/usr/local/bin/npx',
    '/usr/local/lib/node_modules/npm',
  ]) {
    if (fs.existsSync(filename)) fail('unexpected-global-npm-copy')
  }
  const preserved = PRESERVED.map(filename => [filename, fingerprint(filename)])
  const temporary = fs.mkdtempSync('/tmp/overleaf-runtime-cleanup-')
  try {
    fs.chmodSync(temporary, 0o700)
    const empty = temporary + '/empty'
    fs.mkdirSync(empty)
    const config = temporary + '/apt.conf'
    fs.writeFileSync(
      config,
      `Dir::Etc::parts "${empty}";\nDir::Etc::main "/dev/null";\nDir::Etc::sourcelist "/dev/null";\nDir::Etc::sourceparts "${empty}";\nDir::Etc::preferences "/dev/null";\nDir::Etc::preferencesparts "${empty}";\nDir::State::lists "${empty}";\nDir::Cache::pkgcache "";\nDir::Cache::srcpkgcache "";\n`
    )
    const flags = [
      '--no-download',
      '--no-auto-remove',
      '-o',
      'APT::Get::AutomaticRemove=false',
      '-o',
      'APT::Get::AllowUnauthenticated=false',
      '-o',
      'Acquire::Retries=0',
    ]
    const preview = runCommand(
      '/usr/bin/apt-get',
      [...flags, '--simulate', 'remove', 'linux-libc-dev'],
      { APT_CONFIG: config }
    )
    validateRemovalPlan(preview)
    runCommand(
      '/usr/bin/apt-get',
      [...flags, '--assume-yes', 'remove', 'linux-libc-dev'],
      { APT_CONFIG: config }
    )
    if (runCommand('/usr/bin/dpkg', ['--audit']).trim())
      fail('incomplete-dpkg-state')
    const after = parseInstalled(
      readBounded('/var/lib/dpkg/status', 4 * 1024 ** 2).toString('utf8'),
      removed
    )
    validateRetainedPackages(before, after, removed)
    verifyActualNpmPaths(after)
    // These exact symlinks are unlinked; rmSync does not follow tree symlinks.
    for (const filename of LINKS.keys()) fs.unlinkSync(filename)
    fs.rmSync(NPM, { recursive: true, force: false, maxRetries: 0 })
    if ([NPM, ...LINKS.keys()].some(filename => fs.existsSync(filename)))
      fail('npm-pruning-incomplete')
    for (const [filename, snapshot] of preserved) {
      if (
        typeof filename !== 'string' ||
        JSON.stringify(fingerprint(filename)) !== JSON.stringify(snapshot)
      )
        fail('preserved-runtime-path-drift')
    }
    fs.mkdirSync('/usr/share/overleaf', { recursive: true, mode: 0o755 })
    fs.writeFileSync(
      '/usr/share/overleaf/runtime-cleanup.json',
      JSON.stringify(
        {
          schema: 1,
          removed: [...REMOVALS],
          remaining_installed_packages: after.size,
          npm_paths_removed: [NPM, ...LINKS.keys()],
          retained_package_versions_unchanged: true,
          selected_runtime_paths_unchanged: true,
          nodejs_package_files_intentionally_pruned: true,
          full_nodejs_file_integrity_claimed: false,
          functional_or_security_acceptance_claimed: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o644 }
    )
    console.log(
      JSON.stringify({
        runtime_cleanup_complete: true,
        removed_packages: removed.size,
        remaining_packages: after.size,
        npm_removed: true,
      })
    )
  } finally {
    fs.rmSync(temporary, { recursive: true, force: false, maxRetries: 0 })
  }
}

module.exports = {
  validateRemovalPlan,
  validateContext,
  validateNpmPaths,
  validateRetainedPackages,
  parseInstalled,
}
if (require.main === module) {
  try {
    main()
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9-]+$/.test(error.message)
        ? error.message
        : 'runtime-cleanup-failed'
    console.error('Runtime cleanup refused: ' + code)
    process.exitCode = 1
  }
}
