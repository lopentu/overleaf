import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkRelayPaths } from '../../deploy/compiler-relay/launch.mts'

interface Service {
  image: string
  pull_policy: string
  depends_on?: Record<string, { condition: string }>
  environment?: Record<string, string>
  container_name?: string
  network_mode?: string
  networks: Record<string, object | null>
  ports?: { host_ip: string; published: string; target: number }[]
  privileged?: boolean
  user?: string
  read_only?: boolean
  cap_drop?: string[]
  security_opt?: string[]
  group_add?: string[]
  entrypoint?: string[]
  command?: string[]
  healthcheck?: { test: string[] }
  volumes?: {
    type: string
    source: string
    target: string
    read_only?: boolean
    volume?: { nocopy?: boolean }
    bind?: { create_host_path?: boolean }
  }[]
}

interface ComposeConfig {
  services: Record<string, Service>
  networks: Record<string, { internal?: boolean }>
  volumes?: Record<string, object>
}

const pins = {
  OVERLEAF_IMAGE: `sha256:${'1'.repeat(64)}`,
  MONGO_IMAGE: `sha256:${'2'.repeat(64)}`,
  REDIS_IMAGE: `sha256:${'3'.repeat(64)}`,
}
const fixture = mkdtempSync(join(tmpdir(), 'overleaf-compose-config-'))
const appEnv = join(fixture, 'app.env')
const runtimeEnv = join(fixture, 'runtime.env')
writeFileSync(appEnv, 'OVERLEAF_SITE_URL=http://127.0.0.1:18088\n', {
  mode: 0o600,
})

function renderCompose(files: string[], entries: Record<string, string>) {
  writeFileSync(
    runtimeEnv,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600 }
  )
  return spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      runtimeEnv,
      ...files.flatMap(file => ['-f', file]),
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, DOCKER_HOST: 'unix:///no-docker-engine' },
      timeout: 30_000,
    }
  )
}

function render(overlay?: string, omit?: keyof typeof pins) {
  const entries: Record<string, string> = {
    ...pins,
    OVERLEAF_APP_ENV_FILE: appEnv,
    OVERLEAF_HTTP_PORT: '18088',
  }
  if (omit) delete entries[omit]
  return renderCompose(overlay ? ['compose.yaml', overlay] : [], entries)
}

function config(overlay?: string): ComposeConfig {
  const result = render(overlay)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('portable Compose renders only the pinned core and binds web to localhost', () => {
  const { services, networks } = config()
  assert.deepEqual(Object.keys(services).sort(), [
    'mongo',
    'redis',
    'sharelatex',
  ])
  assert.equal(services.sharelatex.image, pins.OVERLEAF_IMAGE)
  assert.equal(services.mongo.image, pins.MONGO_IMAGE)
  assert.equal(services.redis.image, pins.REDIS_IMAGE)
  assert.equal(services.sharelatex.ports?.length, 1)
  const [http] = services.sharelatex.ports ?? []
  assert.equal(http.host_ip, '127.0.0.1')
  assert.equal(http.published, '18088')
  assert.equal(http.target, 80)
  assert.equal(
    services.sharelatex.environment?.OVERLEAF_SECURE_COOKIE,
    undefined
  )
  assert.equal(
    services.sharelatex.environment?.BLOCK_CROSS_ORIGIN_REQUESTS,
    'true'
  )
  assert.equal(
    services.sharelatex.depends_on?.mongo.condition,
    'service_healthy'
  )
  assert.equal(networks.backend.internal, true)
  assert.ok(networks.frontend && !networks.frontend.internal)
  assert.deepEqual(Object.keys(services.sharelatex.networks).sort(), [
    'backend',
    'frontend',
  ])
  for (const option of [
    'OVERLEAF_ENABLE_REGISTER_PAGE',
    'GIT_BRIDGE_ENABLED',
    'DOCKER_RUNNER',
    'SANDBOXED_COMPILES',
    'SANDBOXED_COMPILES_SIBLING_CONTAINERS',
  ]) {
    assert.equal(services.sharelatex.environment?.[option], 'false')
  }
  assert.ok(
    services.sharelatex.volumes?.some(
      volume =>
        volume.type === 'bind' &&
        volume.source.endsWith('/deploy/block-bootstrap.conf') &&
        volume.target ===
          '/etc/nginx/vhost-extras/overleaf/10-block-bootstrap.conf' &&
        volume.read_only
    )
  )
  for (const service of Object.values(services)) {
    assert.equal(service.pull_policy, 'never')
    assert.ok(
      !service.privileged && !service.network_mode && !service.container_name
    )
    assert.ok(
      service.volumes?.every(volume => !volume.target.endsWith('docker.sock'))
    )
  }
  for (const name of ['mongo', 'redis']) {
    assert.equal(services[name].ports, undefined)
    assert.equal(Object.keys(services[name].networks).length, 1)
    assert.equal(
      networks[Object.keys(services[name].networks)[0]].internal,
      true
    )
  }
})

test('every state store has a distinct persistent volume and the TLS overlay sets secure cookies', () => {
  const { services, volumes } = config('deploy/compose.https.yaml')
  assert.equal(services.sharelatex.environment?.OVERLEAF_SECURE_COOKIE, 'true')
  for (const [name, source, target] of [
    ['sharelatex', 'overleaf', '/var/lib/overleaf'],
    ['mongo', 'mongo', '/data/db'],
    ['mongo', 'mongo-configdb', '/data/configdb'],
    ['redis', 'redis', '/data'],
  ]) {
    assert.ok(volumes?.[source])
    assert.ok(
      services[name].volumes?.some(
        volume =>
          volume.type === 'volume' &&
          volume.source === source &&
          volume.target === target &&
          volume.volume?.nocopy === true
      )
    )
  }
})

test('the optional LOPE overlay replaces the four stores with existing host directories', () => {
  const { services } = config('deploy/compose.lope.yaml')
  for (const [name, source, target] of [
    ['sharelatex', 'overleaf', '/var/lib/overleaf'],
    ['mongo', 'mongo', '/data/db'],
    ['mongo', 'mongo-configdb', '/data/configdb'],
    ['redis', 'redis', '/data'],
  ]) {
    const mount = services[name].volumes?.find(
      volume => volume.target === target
    )
    assert.equal(mount?.type, 'bind')
    assert.equal(mount?.source, `/srv/lope/services/overleaf/${source}`)
    assert.ok(!mount?.bind?.create_host_path)
  }
})

test('missing image pins fail before Compose can use an unintended image', () => {
  for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
    const result = render(undefined, name)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(name))
  }
})

const compilerCompose = 'deploy/compose.compiler.yaml'
const filestoreCompose = 'deploy/compose.compiler-filestore.yaml'
const compilerEnv = {
  COMPILER_WORKER_IMAGE: `sha256:${'4'.repeat(64)}`,
  COMPILER_RUNTIME_DIR: join(fixture, 'runtime'),
  COMPILER_STATE_DIR: join(fixture, 'state'),
  COMPILER_CONFIG_FILE: join(fixture, 'compiler.json'),
  COMPILER_DOCKER_GID: '967',
}

function isolatedServices(files: string[], entries: Record<string, string>) {
  const result = renderCompose(files, entries)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const rendered: ComposeConfig = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(rendered.networks ?? {}), [])
  assert.deepEqual(Object.keys(rendered.volumes ?? {}), [])
  for (const service of Object.values(rendered.services)) {
    assert.equal(service.image, compilerEnv.COMPILER_WORKER_IMAGE)
    assert.equal(service.pull_policy, 'never')
    assert.equal(service.user, '33:33')
    assert.equal(service.read_only, true)
    assert.deepEqual(service.cap_drop, ['ALL'])
    assert.ok(
      service.security_opt?.some(option => option.includes('no-new-privileges'))
    )
    assert.ok(service.security_opt?.includes('apparmor=docker-default'))
    assert.equal(service.ports, undefined)
    assert.ok(!service.privileged)
    assert.ok(
      service.volumes?.every(
        volume =>
          volume.type === 'bind' &&
          volume.bind !== undefined &&
          volume.bind.create_host_path !== true
      )
    )
  }
  return rendered.services
}

test('the dedicated compiler keeps a private runtime directory and has no network', () => {
  const services = isolatedServices([compilerCompose], compilerEnv)
  assert.deepEqual(Object.keys(services), ['compiler'])
  const { compiler } = services
  assert.equal(compiler.network_mode, 'none')
  assert.deepEqual(compiler.entrypoint, ['/usr/bin/node'])
  assert.deepEqual(compiler.command, [
    '/overleaf/services/clsi/app/js/IsolatedCompilerWorkerMain.ts',
    '--config',
    '/worker/settings.json',
  ])
  assert.deepEqual(compiler.group_add, [compilerEnv.COMPILER_DOCKER_GID])
  assert.ok(compiler.healthcheck?.test.includes('/worker/runtime/clsi.sock'))
  assert.deepEqual(
    compiler.volumes?.map(mount => [
      mount.source,
      mount.target,
      !!mount.read_only,
    ]),
    [
      [compilerEnv.COMPILER_RUNTIME_DIR, '/worker/runtime', false],
      [compilerEnv.COMPILER_STATE_DIR, '/worker/state', false],
      [compilerEnv.COMPILER_CONFIG_FILE, '/worker/settings.json', true],
    ]
  )
})

test('the filestore adapter shares the isolated network and mounts only its socket and config', () => {
  const bridgeDir = join(fixture, 'filestore')
  const { compiler, filestore } = isolatedServices(
    [compilerCompose, filestoreCompose],
    { ...compilerEnv, COMPILER_FILESTORE_SOCKET_DIR: bridgeDir }
  )
  assert.equal(compiler.network_mode, 'none')
  assert.equal(filestore.network_mode, 'service:compiler')
  assert.equal(filestore.group_add, undefined)
  assert.deepEqual(filestore.entrypoint, ['/usr/sbin/nginx'])
  assert.deepEqual(
    filestore.volumes?.map(mount => [mount.target, !!mount.read_only]),
    [
      ['/worker/filestore/filestore.sock', true],
      ['/etc/overleaf/compiler-filestore.conf', true],
    ]
  )
  assert.equal(filestore.volumes?.[0].source, join(bridgeDir, 'filestore.sock'))
  assert.ok(
    filestore.volumes?.[1].source.endsWith(
      '/deploy/compiler-filestore.nginx.conf'
    )
  )
})

test('a dedicated compiler cannot start without explicit image, runtime and config inputs', () => {
  for (const name of Object.keys(compilerEnv)) {
    const entries: Record<string, string> = { ...compilerEnv }
    delete entries[name]
    const result = renderCompose([compilerCompose], entries)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(name))
  }
})

const relayCompose = 'deploy/compose.compiler-relay.yaml'
const relayEnv = {
  COMPILER_RELAY_IMAGE: compilerEnv.COMPILER_WORKER_IMAGE,
  COMPILER_RELAY_ROLE: 'worker',
  COMPILER_RELAY_TLS_DIR: join(fixture, 'tls'),
  COMPILER_RELAY_SOCKET_DIR: join(fixture, 'listeners'),
  COMPILER_RELAY_BACKEND_SOCKET: join(fixture, 'backend.sock'),
  COMPILER_RELAY_TUNNEL_SOCKET: join(fixture, 'tunnel.sock'),
}

test('each compiler relay can reach only the two input sockets and publish private Unix listeners', () => {
  for (const role of ['web', 'worker']) {
    const services = isolatedServices([relayCompose], {
      ...relayEnv,
      COMPILER_RELAY_ROLE: role,
    })
    assert.deepEqual(Object.keys(services), ['relay'])
    const { relay } = services
    assert.equal(relay.network_mode, 'none')
    assert.equal(relay.group_add, undefined)
    assert.deepEqual(relay.entrypoint, [
      '/usr/bin/node',
      '/relay/config/launch.mts',
      '--run',
    ])
    assert.deepEqual(relay.command, [role])
    const mounts = new Map(relay.volumes?.map(mount => [mount.target, mount]))
    assert.deepEqual([...mounts.keys()].sort(), [
      '/relay/config',
      '/relay/input/tunnel.sock',
      '/relay/input/upstream.sock',
      '/relay/run',
      '/relay/tls',
    ])
    assert.deepEqual(
      ['/relay/input/upstream.sock', '/relay/input/tunnel.sock'].map(target => [
        mounts.get(target)?.source,
        mounts.get(target)?.read_only,
      ]),
      [
        [relayEnv.COMPILER_RELAY_BACKEND_SOCKET, true],
        [relayEnv.COMPILER_RELAY_TUNNEL_SOCKET, true],
      ]
    )
    assert.equal(
      mounts.get('/relay/run')?.source,
      relayEnv.COMPILER_RELAY_SOCKET_DIR
    )
    assert.ok(!mounts.get('/relay/run')?.read_only)
    assert.equal(
      mounts.get('/relay/tls')?.source,
      relayEnv.COMPILER_RELAY_TLS_DIR
    )
    assert.equal(mounts.get('/relay/tls')?.read_only, true)
    assert.ok(
      mounts.get('/relay/config')?.source.endsWith('/deploy/compiler-relay')
    )
    assert.equal(mounts.get('/relay/config')?.read_only, true)
  }
})

test('each relay requires an explicit role, image and socket and TLS inputs', () => {
  for (const name of Object.keys(relayEnv)) {
    const entries: Record<string, string> = { ...relayEnv }
    delete entries[name]
    const result = renderCompose([relayCompose], entries)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(name))
  }
})

async function openFixtureSocket(path: string): Promise<Server> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(path, resolve)
  })
  return listener
}

test('relay preflight refuses listener directories with existing files and aliased sockets', async t => {
  const root = mkdtempSync(join(tmpdir(), 'oc-r-'))
  const paths = {
    listenerDirectory: join(root, 'run'),
    tlsDirectory: join(root, 'tls'),
    backendSocket: join(root, 'backend.sock'),
    tunnelSocket: join(root, 'tunnel.sock'),
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(paths.listenerDirectory, { mode: 0o700 })
  mkdirSync(paths.tlsDirectory, { mode: 0o700 })
  for (const path of [paths.backendSocket, paths.tunnelSocket]) {
    const socket = await openFixtureSocket(path)
    t.after(() => new Promise<void>(resolve => socket.close(() => resolve())))
  }
  const uid = process.geteuid?.()
  assert.ok(uid !== undefined)
  checkRelayPaths(paths, uid)
  assert.throws(() =>
    checkRelayPaths({ ...paths, tunnelSocket: paths.backendSocket }, uid)
  )
  assert.throws(() =>
    checkRelayPaths({ ...paths, tlsDirectory: paths.listenerDirectory }, uid)
  )
  writeFileSync(join(paths.listenerDirectory, 'unexpected'), 'fixture')
  assert.throws(() => checkRelayPaths(paths, uid))
})

function renderOverleafVhost(root: string, mode?: string) {
  mkdirSync(join(root, 'templates'), { recursive: true })
  mkdirSync(join(root, 'sites-enabled'))
  const tools = join(root, 'tools')
  mkdirSync(tools)
  for (const name of ['nginx.conf.template', 'overleaf.conf.template']) {
    copyFileSync(join('server-ce/nginx', name), join(root, 'templates', name))
  }
  const source = readFileSync(
    'server-ce/init_scripts/200_nginx_config_template.sh',
    'utf8'
  )
  assert.ok(source.includes("nginx_dir='/etc/nginx'"))
  const initializer = join(root, 'init.sh')
  writeFileSync(
    initializer,
    source.replace("nginx_dir='/etc/nginx'", `nginx_dir='${root}'`)
  )

  // Run the actual initializer without touching host nginx or requiring gettext.
  writeFileSync(
    join(tools, 'envsubst'),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      'const names = new Set(process.argv[2].match(/\\$\\{[A-Z_]+\\}/g))',
      "process.stdout.write(fs.readFileSync(0, 'utf8').replace(/\\$\\{[A-Z_]+\\}/g, token => names.has(token) ? process.env[token.slice(2, -1)] || '' : token))",
    ].join('\n'),
    { mode: 0o700 }
  )
  writeFileSync(join(tools, 'nginx'), '#!/bin/sh\ntest "$*" = -t\n', {
    mode: 0o700,
  })
  writeFileSync(
    join(tools, 'service'),
    '#!/bin/sh\ntest "$*" = "nginx reload"\n',
    { mode: 0o700 }
  )
  const result = spawnSync('/bin/sh', [initializer], {
    encoding: 'utf8',
    env: {
      PATH: `${tools}:/usr/bin:/bin`,
      ...(mode === undefined
        ? {}
        : { OVERLEAF_PROXY_CLSI_OUTPUT_THROUGH_WEB: mode }),
    },
  })
  const vhost = join(root, 'sites-enabled/overleaf.conf')
  return {
    result,
    config: existsSync(vhost) ? readFileSync(vhost, 'utf8') : undefined,
  }
}

test('only the explicit isolated mode routes previews through the authenticated Web handler', () => {
  const implicit = renderOverleafVhost(join(fixture, 'stock'))
  const stock = renderOverleafVhost(join(fixture, 'explicit-stock'), 'false')
  const isolated = renderOverleafVhost(join(fixture, 'isolated'), 'true')
  for (const { result, config } of [implicit, stock, isolated]) {
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      config ?? '',
      /location \/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:4000;/
    )
  }
  const stockInclude =
    'include /etc/nginx/templates/overleaf-embedded-clsi.conf;'
  assert.equal(stock.config, implicit.config)
  assert.ok(stock.config?.includes(stockInclude))
  assert.equal(isolated.config?.includes(stockInclude), false)
  assert.equal(isolated.config?.includes('127.0.0.1:8080'), false)
  const legacy = readFileSync(
    'server-ce/nginx/overleaf-embedded-clsi.conf',
    'utf8'
  )
  assert.equal(
    legacy.match(/proxy_pass http:\/\/127\.0\.0\.1:8080;/g)?.length,
    4
  )
})

test('an invalid isolated output mode fails before publishing an NGINX vhost', () => {
  for (const [name, mode] of [
    ['invalid', 'yes'],
    ['empty', ''],
  ]) {
    const { result, config } = renderOverleafVhost(join(fixture, name), mode)
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OVERLEAF_PROXY_CLSI_OUTPUT_THROUGH_WEB/)
    assert.equal(config, undefined)
  }
})

test.after(() => rmSync(fixture, { recursive: true, force: true }))
