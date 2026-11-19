// @ts-check
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const projection = require('./runtime-dependencies.cjs')
const SCANNER_SHA =
  'fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8'
// A known-vulnerable fixture scanned separately from the runtime SBOM.
const POSITIVE_CONTROL = {
  name: 'lodash',
  version: '4.17.20',
  id: 'GHSA-35jh-r3h4-6jhm',
}
const EMPTY_CONFIG = '# No ignores or overrides.\n'
const GiB = 1024 ** 3
/** @typedef {{name:string,version:string,id:string,severity:string}} Finding */
class AuditRefusal extends Error {}

/** @param {unknown} value @param {string} code @returns {asserts value} */
function check(value, code) {
  if (!value) throw new AuditRefusal(code)
}
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'audit-object-schema'
  )
  return /** @type {Record<string,unknown>} */ (value)
}
/** @param {unknown} value @returns {unknown[]} */
function array(value) {
  check(Array.isArray(value), 'audit-array-schema')
  return value
}
/** @param {{uid:number,actions:string,repository:string,workspace:string,temp:string,realWorkspace:string,realTemp:string}} state */
function validateCiContext(state) {
  check(
    state.uid > 0 &&
      state.actions === 'true' &&
      state.repository === 'lopentu/overleaf' &&
      path.isAbsolute(state.workspace) &&
      path.isAbsolute(state.temp) &&
      state.realWorkspace === state.workspace &&
      state.realTemp === state.temp &&
      !state.workspace.startsWith(
        path.join(state.temp, 'overleaf-runtime-audit')
      ),
    'fixed-public-ci-context'
  )
}
/** @param {unknown} value */
function noSuppression(value) {
  if (Array.isArray(value)) {
    for (const child of value) noSuppression(child)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/ignored|suppressed|hidden|filtered/i.test(key))
      check(
        child === false ||
          child === null ||
          child === '' ||
          (Array.isArray(child) && child.length === 0),
        'suppressed-audit-findings'
      )
    noSuppression(child)
  }
}
/** @param {unknown} value @param {{components:Array<{name:string,version:string}>}} bom @returns {Finding[]} */
function inspectReport(value, bom) {
  noSuppression(value)
  const expected = new Set(
    bom.components.map(p => JSON.stringify([p.name, p.version]))
  )
  check(
    expected.size === bom.components.length && expected.size > 0,
    'unique-input-identities'
  )
  const observed = new Set()
  /** @type {Finding[]} */
  const findings = []
  for (const source of array(object(value).results))
    for (const entry of array(object(source).packages)) {
      const pkg = object(object(entry).package)
      check(
        typeof pkg.name === 'string' &&
          typeof pkg.version === 'string' &&
          pkg.ecosystem === 'npm',
        'scanned-package-schema'
      )
      const key = JSON.stringify([pkg.name, pkg.version])
      check(
        expected.has(key) && !observed.has(key),
        'scanner-identity-coverage'
      )
      observed.add(key)
      const vulnerabilities = object(entry).vulnerabilities
      for (const item of vulnerabilities === undefined
        ? []
        : array(vulnerabilities)) {
        const vuln = object(item),
          severity = object(vuln.database_specific).severity
        check(
          typeof vuln.id === 'string' &&
            typeof severity === 'string' &&
            ['LOW', 'MODERATE', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(
              severity
            ),
          'known-vulnerability-severity'
        )
        findings.push({
          name: pkg.name,
          version: pkg.version,
          id: vuln.id,
          severity: severity === 'MEDIUM' ? 'MODERATE' : severity,
        })
      }
    }
  check(observed.size === expected.size, 'scanner-identity-coverage')
  return findings
}
/** @param {Finding[]} findings */
function assertClean(findings) {
  check(
    !findings.some(v => v.severity === 'HIGH' || v.severity === 'CRITICAL'),
    'runtime-high-or-critical'
  )
}
/** @param {Finding[]} findings */
function assertPositive(findings) {
  check(
    findings.some(
      v =>
        v.name === POSITIVE_CONTROL.name &&
        v.version === POSITIVE_CONTROL.version &&
        v.id === POSITIVE_CONTROL.id &&
        v.severity === 'HIGH'
    ),
    'missing-exact-high-positive-control'
  )
}
/** @param {string[]} args @param {string} cwd */
function run(args, cwd) {
  const env = { ...process.env }
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_INTERNAL_SUPER_PREFIX',
  ])
    delete env[name]
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 ** 2,
  })
  check(!result.error && result.status === 0, 'ci-source-command-failed')
  return result.stdout
}
/** @param {string} root @param {string} file @param {boolean} [allowMissing] */
function sourceInput(root, file, allowMissing = false) {
  check(
    fs.realpathSync(root) === root &&
      (file === root || file.startsWith(root + '/')),
    'source-input-root'
  )
  let current = root
  const parts = path.relative(root, file).split(path.sep)
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    try {
      check(
        fs.lstatSync(current).isDirectory() &&
          !fs.lstatSync(current).isSymbolicLink(),
        'source-input-ancestor-link'
      )
    } catch (error) {
      if (
        allowMissing &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        break
      throw error
    }
  }
  return file
}

/** @param {string} source @param {string} target @param {string} sourceRoot */
function copy(source, target, sourceRoot) {
  const stat = fs.lstatSync(sourceInput(sourceRoot, source))
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(source)
    check(
      !path.isAbsolute(link) &&
        path.resolve(path.dirname(source), link).startsWith(sourceRoot + '/'),
      'source-copy-link-confinement'
    )
    fs.symlinkSync(link, target)
  } else if (stat.isDirectory()) {
    fs.mkdirSync(target, { mode: stat.mode & 0o777 })
    for (const name of fs.readdirSync(source))
      copy(path.join(source, name), path.join(target, name), sourceRoot)
  } else {
    check(stat.isFile() && stat.size <= GiB, 'public-source-file-bound')
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, stat.mode & 0o777)
  }
}
/** @param {string} root @param {string} sourceRoot @returns {number} */
function size(root, sourceRoot) {
  const stat = fs.lstatSync(sourceInput(sourceRoot, root))
  if (stat.isSymbolicLink()) return stat.size
  if (stat.isFile()) return stat.size
  return fs
    .readdirSync(root)
    .reduce((total, name) => total + size(path.join(root, name), sourceRoot), 0)
}
/** @param {string} file @param {unknown} value */
function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
}
/** @param {string} workspace @param {string} temp */
function prepare(workspace, temp) {
  const root = path.join(temp, 'overleaf-runtime-audit')
  check(!fs.existsSync(root), 'fresh-ci-runtime-tree')
  const revision = run(['/usr/bin/git', 'rev-parse', 'HEAD'], workspace).trim()
  check(/^[a-f0-9]{40}$/.test(revision), 'immutable-source-commit')
  const records = run(
    ['/usr/bin/git', 'ls-tree', '-r', '-l', '-z', revision],
    workspace
  )
    .split('\0')
    .filter(Boolean)
  let trackedBytes = 0
  for (const record of records) {
    const match =
      /^(100644|100755|120000) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(
        record
      )
    check(match, 'source-tree-record')
    const [, mode, blob, count, name] = match
    check(
      !path.isAbsolute(name) &&
        !name.split('/').includes('..') &&
        Number(count) <= GiB,
      'tracked-source-paths'
    )
    trackedBytes += Number(count) + 1024
    if (mode === '120000') {
      check(Number(count) <= 4096, 'source-link-bound')
      const link = run(['/usr/bin/git', 'cat-file', 'blob', blob], workspace)
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), link)
      )
      check(
        !path.isAbsolute(link) &&
          !link.includes('\0') &&
          target !== '..' &&
          !target.startsWith('../'),
        'committed-source-link-confinement'
      )
    }
  }
  const generated = [
    '.pnp.cjs',
    '.pnp.loader.mjs',
    '.yarn/cache',
    '.yarn/unplugged',
  ]
  const generatedBytes = generated.reduce(
    (total, name) => total + size(path.join(workspace, name), workspace),
    0
  )
  const available = fs.statfsSync(temp)
  check(
    trackedBytes + generatedBytes <= 8 * GiB &&
      available.bavail * available.bsize >=
        2 * trackedBytes + generatedBytes + GiB,
    'ci-copy-disk-budget'
  )
  const sourceDir = path.join(temp, 'overleaf-runtime-audit-source')
  check(!fs.existsSync(sourceDir), 'fresh-ci-source-archive')
  fs.mkdirSync(root, { mode: 0o700 })
  fs.mkdirSync(sourceDir, { mode: 0o700 })
  const archive = path.join(sourceDir, 'source.tar')
  run(
    [
      '/usr/bin/git',
      '-c',
      'tar.umask=0022',
      'archive',
      '--format=tar',
      '--output=' + archive,
      revision,
    ],
    workspace
  )
  check(
    fs.lstatSync(archive).isFile() &&
      !fs.lstatSync(archive).isSymbolicLink() &&
      fs.statSync(archive).size <= 2 * trackedBytes + 10240,
    'source-archive-bound'
  )
  run(
    [
      '/bin/tar',
      '--extract',
      '--file=' + archive,
      '--directory=' + root,
      '--no-same-owner',
      '--same-permissions',
    ],
    workspace
  )
  save(path.join(sourceDir, 'PROVENANCE.json'), {
    tracked_source_commit: revision,
    archive_sha256: projection.digest(archive),
    tracked_source_is_HEAD_archive: true,
    tracked_working_tree_bytes_used: false,
    generated_inputs_from_guarded_workspace: true,
  })
  for (const name of generated) {
    const target = sourceInput(root, path.join(root, name), true)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    copy(path.join(workspace, name), target, workspace)
  }
  return root
}
/** @param {string} file */
function json(file) {
  check(fs.statSync(file).size <= 32 * 1024 ** 2, 'audit-json-bound')
  return /** @type {unknown} */ (JSON.parse(fs.readFileSync(file, 'utf8')))
}
/** @param {string} tool @param {string} directory @param {string} label @param {ReturnType<typeof projection.sbom>} bom */
function scan(tool, directory, label, bom) {
  const config = path.join(directory, 'empty-osv-scanner.toml')
  check(
    fs.readFileSync(config, 'utf8') === EMPTY_CONFIG,
    'empty-no-ignore-config'
  )
  const input = path.join(directory, label + '.cdx.json'),
    report = path.join(directory, label + '-report.json')
  save(input, bom)
  const result = spawnSync(
    tool,
    [
      'scan',
      'source',
      '--offline',
      '--no-resolve',
      '--all-packages',
      '--all-vulns',
      '--config=' + config,
      '--format=json',
      '--output-file=' + report,
      '--lockfile=' + input,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 540000,
      maxBuffer: 4 * 1024 ** 2,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: path.join(directory, 'home'),
        XDG_CONFIG_HOME: path.join(directory, 'home'),
        OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: path.join(directory, 'cache'),
        NO_COLOR: '1',
      },
    }
  )
  fs.writeFileSync(
    path.join(directory, label + '-stdout.log'),
    result.stdout || '',
    { flag: 'wx', mode: 0o600 }
  )
  fs.writeFileSync(
    path.join(directory, label + '-stderr.log'),
    result.stderr || '',
    { flag: 'wx', mode: 0o600 }
  )
  check(
    !result.error &&
      (result.status === 0 || result.status === 1) &&
      fs.existsSync(report),
    'offline-scanner-result'
  )
  const findings = inspectReport(json(report), bom)
  check(
    (result.status === 0 && findings.length === 0) ||
      (result.status === 1 && findings.length > 0),
    'scanner-exit-finding-coherence'
  )
  return findings
}
function main() {
  const workspace = process.env.GITHUB_WORKSPACE || '',
    temp = process.env.RUNNER_TEMP || ''
  validateCiContext({
    uid: process.getuid?.() ?? -1,
    actions: process.env.GITHUB_ACTIONS || '',
    repository: process.env.GITHUB_REPOSITORY || '',
    workspace,
    temp,
    realWorkspace: fs.realpathSync(workspace),
    realTemp: fs.realpathSync(temp),
  })
  check(process.argv[2] === '--ci-runtime-audit', 'explicit-ci-audit-command')
  projection.requirePnp(process.versions.pnp)
  const downloads = path.join(temp, 'overleaf-osv-downloads'),
    tool = path.join(downloads, 'osv-scanner')
  check(projection.digest(tool) === SCANNER_SHA, 'official-scanner-sha256')
  const db = path.join(downloads, 'npm-all.zip')
  check(
    fs.statSync(db).size >= 1024 ** 2 && fs.statSync(db).size <= GiB,
    'full-public-database-bound'
  )
  const evidence = path.join(temp, 'overleaf-runtime-audit-evidence')
  fs.mkdirSync(evidence, { mode: 0o700 })
  fs.mkdirSync(path.join(evidence, 'home'), { mode: 0o700 })
  fs.mkdirSync(path.join(evidence, 'cache/osv-scalibr/npm'), {
    recursive: true,
  })
  fs.copyFileSync(
    db,
    path.join(evidence, 'cache/osv-scalibr/npm/all.zip'),
    fs.constants.COPYFILE_EXCL
  )
  fs.writeFileSync(
    path.join(evidence, 'empty-osv-scanner.toml'),
    EMPTY_CONFIG,
    { flag: 'wx', mode: 0o600 }
  )
  save(path.join(evidence, 'INPUTS.json'), {
    scanner_sha256: SCANNER_SHA,
    full_public_db_sha256: projection.digest(db),
    database_headers_sha256: projection.digest(
      path.join(downloads, 'npm-headers.txt')
    ),
    empty_config_sha256: nodeCrypto
      .createHash('sha256')
      .update(EMPTY_CONFIG)
      .digest('hex'),
    inventory_network_export: false,
  })
  const root = prepare(workspace, temp)
  save(
    path.join(evidence, 'TRACKED-SOURCE.json'),
    json(path.join(temp, 'overleaf-runtime-audit-source/PROVENANCE.json'))
  )
  projection.focus(root) // Establish the same production baseline as the image build.
  const receipt = projection.project(root)
  save(path.join(evidence, 'runtime-inventory.json'), receipt)
  const bom = projection.sbom(receipt)
  const { name, version } = POSITIVE_CONTROL
  const purl = `pkg:npm/${name}@${version}`
  const control = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    components: [
      {
        type: 'library',
        name,
        version,
        purl,
        'bom-ref': purl,
        properties: [],
      },
    ],
  }
  assertPositive(scan(tool, evidence, 'positive-control', control))
  const findings = scan(tool, evidence, 'runtime', bom)
  save(path.join(evidence, 'FINDINGS.json'), findings)
  assertClean(findings)
  process.stdout.write(
    JSON.stringify({
      offline_runtime_audit_passed: true,
      identities: bom.components.length,
      high: 0,
      critical: 0,
      lower_findings: findings.length,
      exact_high_positive_control: true,
      no_inventory_export: true,
      image_runtime_qualified: false,
    }) + '\n'
  )
}
module.exports = {
  validateCiContext,
  inspectReport,
  assertClean,
  assertPositive,
  prepare,
  copy,
  scan,
}
if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        failed: true,
        failure_class: 'OfflineRuntimeAudit',
        failure_code:
          error instanceof AuditRefusal ||
          error instanceof projection.ProjectionRefusal
            ? error.message
            : 'source-or-filesystem-error',
      }) + '\n'
    )
    process.exitCode = 1
  }
}
