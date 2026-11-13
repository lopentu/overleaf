import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import nodeAssert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import {
  Server as TcpServer,
  createConnection,
  createServer as createTcpServer,
} from 'node:net'
import { request } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { startClsiListeners } from '../../../app/js/ClsiListener.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'clsi-listener-'))
  await chmod(dir, 0o700)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const app = express()
  app.get('/health', (_req, res) => res.status(200).send('clsi-ok'))
  const loadHttpApp = express()
  loadHttpApp.get('/state', (_req, res) => res.send('up'))
  const loadTcpServer = createTcpServer(socket => socket.end('up\n'))
  return {
    dir,
    app,
    loadHttpApp,
    loadTcpServer,
    host: '127.0.0.1',
    port: 0,
    loadTcpPort: 0,
    loadHttpPort: 0,
  }
}
function getHttp(
  options: { socketPath: string } | { host: string; port: number },
  path = '/health'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, path, agent: false }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => resolve(Buffer.concat(chunks).toString()))
    })
    req.once('error', reject)
    req.end()
  })
}
async function started(options: Parameters<typeof startClsiListeners>[0]) {
  const handle = await startClsiListeners(options)
  cleanup.push(() => handle.close())
  return handle
}

test('Unix mode serves real Express HTTP and leaves both load listeners unbound', async () => {
  const f = await fixture()
  const socketPath = join(f.dir, 'clsi.sock')
  const handle = await started({ ...f, unixSocket: socketPath })
  nodeAssert.equal(await getHttp({ socketPath }), 'clsi-ok')
  nodeAssert.equal(handle.main.address(), socketPath)
  nodeAssert.equal(f.loadTcpServer.listening, false)
  nodeAssert.equal(handle.loadHttp, undefined)
  nodeAssert.equal((await lstat(socketPath)).mode & 0o777, 0o600)
})

test('default TCP serves HTTP and retains both load listeners', async () => {
  const f = await fixture()
  const handle = await started(f)
  const address = handle.main.address()
  nodeAssert.ok(address && typeof address !== 'string')
  nodeAssert.equal(
    await getHttp({ host: '127.0.0.1', port: address.port }),
    'clsi-ok'
  )
  nodeAssert.equal(f.loadTcpServer.listening, true)
  const tcpAddress = f.loadTcpServer.address()
  nodeAssert.ok(tcpAddress && typeof tcpAddress !== 'string')
  nodeAssert.equal(
    await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: tcpAddress.port,
      })
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()))
    }),
    'up\n'
  )
  const loadAddress = handle.loadHttp?.address()
  nodeAssert.ok(loadAddress && typeof loadAddress !== 'string')
  nodeAssert.equal(
    await getHttp({ host: '127.0.0.1', port: loadAddress.port }, '/state'),
    'up'
  )
})

for (const configured of [
  '',
  'relative.sock',
  '/tmp/../tmp/clsi.sock',
  '/tmp/clsi\0.sock',
  `/tmp/${'x'.repeat(101)}`,
]) {
  test(`refuses invalid explicit Unix path ${JSON.stringify(configured)}`, async () => {
    const f = await fixture()
    await nodeAssert.rejects(
      startClsiListeners({ ...f, unixSocket: configured })
    )
    nodeAssert.equal(f.loadTcpServer.listening, false)
  })
}

for (const kind of ['file', 'directory', 'symlink', 'socket'] as const) {
  test(`refuses existing ${kind} without removing or changing it`, async () => {
    const f = await fixture()
    const p = join(f.dir, 'occupied.sock')
    let rogue: ReturnType<typeof createTcpServer> | undefined
    if (kind === 'file') await writeFile(p, 'sentinel')
    if (kind === 'directory') await mkdir(p)
    if (kind === 'symlink') await symlink('absent-target', p)
    if (kind === 'socket') {
      rogue = createTcpServer()
      await new Promise<void>((resolve, reject) =>
        rogue?.once('error', reject).listen(p, resolve)
      )
      cleanup.push(
        () => new Promise<void>(resolve => rogue?.close(() => resolve()))
      )
    }
    const before = await lstat(p)
    await nodeAssert.rejects(startClsiListeners({ ...f, unixSocket: p }))
    nodeAssert.equal((await lstat(p)).ino, before.ino)
    if (kind === 'file') nodeAssert.equal(await readFile(p, 'utf8'), 'sentinel')
    nodeAssert.equal(f.loadTcpServer.listening, false)
  })
}

for (const mode of [0o755, 0o750, 0o770, 0o777]) {
  test(`refuses nonprivate parent mode ${mode.toString(8)}`, async () => {
    const f = await fixture()
    await chmod(f.dir, mode)
    await nodeAssert.rejects(
      startClsiListeners({ ...f, unixSocket: join(f.dir, 'clsi.sock') })
    )
  })
}

test('refuses symlink parent even when target is private', async () => {
  const f = await fixture()
  await symlink(f.dir, join(f.dir, 'alias'))
  await nodeAssert.rejects(
    startClsiListeners({ ...f, unixSocket: join(f.dir, 'alias/clsi.sock') })
  )
})

test('refuses unsafe writable ancestor above private leaf', async () => {
  const f = await fixture()
  await mkdir(join(f.dir, 'private'), { mode: 0o700 })
  await chmod(f.dir, 0o777)
  await nodeAssert.rejects(
    startClsiListeners({ ...f, unixSocket: join(f.dir, 'private/clsi.sock') })
  )
})

test('orderly close is idempotent, preserves sibling and permits exact-path restart', async () => {
  const f = await fixture()
  const p = join(f.dir, 'clsi.sock')
  await writeFile(join(f.dir, 'keep'), 'sibling')
  const first = await started({ ...f, unixSocket: p })
  await first.close()
  await first.close()
  await nodeAssert.rejects(lstat(p), { code: 'ENOENT' })
  nodeAssert.equal(await readFile(join(f.dir, 'keep'), 'utf8'), 'sibling')
  const second = await started({ ...f, unixSocket: p })
  nodeAssert.equal(await getHttp({ socketPath: p }), 'clsi-ok')
  await second.close()
})

test('later TCP startup failure closes main HTTP instead of leaving partial service', async () => {
  const f = await fixture()
  const reservation = createTcpServer()
  await new Promise<void>((resolve, reject) =>
    reservation.once('error', reject).listen(0, '127.0.0.1', resolve)
  )
  const mainAddress = reservation.address()
  nodeAssert.ok(mainAddress && typeof mainAddress !== 'string')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const blocker = createTcpServer()
  await new Promise<void>((resolve, reject) =>
    blocker.once('error', reject).listen(0, '127.0.0.1', resolve)
  )
  cleanup.push(
    () => new Promise<void>(resolve => blocker.close(() => resolve()))
  )
  const address = blocker.address()
  nodeAssert.ok(address && typeof address !== 'string')
  await nodeAssert.rejects(
    startClsiListeners({
      ...f,
      port: mainAddress.port,
      loadHttpPort: address.port,
    }),
    { code: 'EADDRINUSE' }
  )
  await nodeAssert.rejects(
    getHttp({ host: '127.0.0.1', port: mainAddress.port }),
    { code: 'ECONNREFUSED' }
  )
  nodeAssert.equal(f.loadTcpServer.listening, false)
})

test('main bind failure rejects without starting either load listener', async () => {
  const f = await fixture()
  const blocker = createTcpServer()
  await new Promise<void>((resolve, reject) =>
    blocker.once('error', reject).listen(0, '127.0.0.1', resolve)
  )
  cleanup.push(
    () => new Promise<void>(resolve => blocker.close(() => resolve()))
  )
  const address = blocker.address()
  nodeAssert.ok(address && typeof address !== 'string')
  await nodeAssert.rejects(startClsiListeners({ ...f, port: address.port }), {
    code: 'EADDRINUSE',
  })
  nodeAssert.equal(f.loadTcpServer.listening, false)
})

async function child(socketPath: string) {
  const proc = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./ClsiListener.child.ts', import.meta.url)),
      socketPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const exited = once(proc, 'exit')
  cleanup.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL')
      await exited
    }
  })
  await new Promise<void>((resolve, reject) => {
    proc.stdout.once('data', chunk =>
      chunk.toString() === 'ready\n'
        ? resolve()
        : reject(new Error('Unexpected readiness'))
    )
    proc.once('error', reject)
    proc.once('exit', () => reject(new Error('Child exited before readiness')))
    proc.stderr.once('data', chunk => reject(new Error(chunk.toString())))
  })
  return { proc, exited }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(
    `${signal} removes owned endpoint, closes active HTTP and permits restart`,
    { timeout: 5000 },
    async () => {
      const f = await fixture()
      const p = join(f.dir, 'clsi.sock')
      const first = await child(p)
      nodeAssert.equal(await getHttp({ socketPath: p }), 'child-ok')
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          { socketPath: p, path: '/hold', agent: false },
          resolve
        )
        req.once('error', reject)
        req.end()
      })
      await once(response, 'data')
      const aborted = once(response, 'aborted')
      // ECONNRESET is expected when shutdown closes this deliberately held response.
      response.on('error', () => {})
      first.proc.kill(signal)
      nodeAssert.deepEqual(await first.exited, [0, null])
      await aborted
      await nodeAssert.rejects(lstat(p), { code: 'ENOENT' })
      const second = await child(p)
      second.proc.kill(signal)
      nodeAssert.deepEqual(await second.exited, [0, null])
    }
  )
}

test(
  'abrupt exit leaves stale socket and restart refuses it without deletion',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = join(f.dir, 'clsi.sock')
    const running = await child(p)
    running.proc.kill('SIGKILL')
    nodeAssert.deepEqual(await running.exited, [null, 'SIGKILL'])
    const before = await lstat(p)
    nodeAssert.ok(before.isSocket())
    await nodeAssert.rejects(startClsiListeners({ ...f, unixSocket: p }))
    nodeAssert.equal((await lstat(p)).ino, before.ino)
  }
)

for (const configured of [0, '0', 3013, '3013', '003013'] as const) {
  test(`TCP port ${JSON.stringify(configured)} always supplies explicit numeric port and host without binding`, async () => {
    const f = await fixture()
    const original = TcpServer.prototype.listen
    const stopped = new Error('intercepted before kernel bind')
    const calls: unknown[][] = []
    TcpServer.prototype.listen = function (...args: unknown[]): never {
      calls.push(args)
      throw stopped
    }
    try {
      await nodeAssert.rejects(
        startClsiListeners({ ...f, port: configured }),
        error => error === stopped
      )
      nodeAssert.deepEqual(calls, [
        [{ port: Number(configured), host: '127.0.0.1' }],
      ])
    } finally {
      TcpServer.prototype.listen = original
    }
  })
}

for (const field of ['port', 'loadTcpPort', 'loadHttpPort'] as const) {
  for (const configured of [
    -1,
    65536,
    1.5,
    NaN,
    Infinity,
    '',
    ' ',
    'no-port',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '0x100',
    '65536',
    '/tmp/not-a-port.sock',
  ] as const) {
    test(`invalid TCP ${field} ${JSON.stringify(configured)} rejects before any listen call`, async () => {
      const f = await fixture()
      const original = TcpServer.prototype.listen
      let calls = 0
      TcpServer.prototype.listen = function (): never {
        calls++
        throw new Error('must not bind invalid TCP configuration')
      }
      try {
        await nodeAssert.rejects(
          startClsiListeners({ ...f, [field]: configured }),
          /invalid.*TCP.*port/i
        )
        nodeAssert.equal(calls, 0)
      } finally {
        TcpServer.prototype.listen = original
      }
    })
  }
}

test('numeric string zero binds all three TCP listeners only to the configured loopback host', async () => {
  const f = await fixture()
  const handle = await started({
    ...f,
    port: '0',
    loadTcpPort: '0',
    loadHttpPort: '0',
  })
  for (const server of [handle.main, f.loadTcpServer, handle.loadHttp]) {
    nodeAssert.ok(server)
    const address = server.address()
    nodeAssert.ok(address && typeof address !== 'string')
    nodeAssert.equal(address.address, '127.0.0.1')
  }
  const address = handle.main.address()
  nodeAssert.ok(address && typeof address !== 'string')
  nodeAssert.equal(
    await getHttp({ host: '127.0.0.1', port: address.port }),
    'clsi-ok'
  )
})

test('explicit Unix mode ignores unused invalid TCP ports and starts no load listener', async () => {
  const f = await fixture()
  const socketPath = join(f.dir, 'clsi.sock')
  const handle = await started({
    ...f,
    unixSocket: socketPath,
    port: 'not-a-port',
    loadTcpPort: -1,
    loadHttpPort: '65536',
  })
  nodeAssert.equal(await getHttp({ socketPath }), 'clsi-ok')
  nodeAssert.equal(handle.main.address(), socketPath)
  nodeAssert.equal(f.loadTcpServer.listening, false)
  nodeAssert.equal(handle.loadHttp, undefined)
})
