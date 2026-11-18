import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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

function render(overlay?: string, omit?: keyof typeof pins) {
  const entries = Object.entries({
    ...pins,
    OVERLEAF_APP_ENV_FILE: appEnv,
    OVERLEAF_HTTP_PORT: '18088',
  }).filter(([key]) => key !== omit)
  writeFileSync(
    runtimeEnv,
    entries.map(([key, value]) => `${key}=${value}\n`).join(''),
    { mode: 0o600 }
  )
  return spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      runtimeEnv,
      ...(overlay ? ['-f', 'compose.yaml', '-f', overlay] : []),
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

test.after(() => rmSync(fixture, { recursive: true, force: true }))
