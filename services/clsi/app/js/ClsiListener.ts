import { chmod, lstat, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener, Server as HttpServer } from 'node:http'
import type { ListenOptions, Server as TcpServer } from 'node:net'
import { dirname, isAbsolute, normalize } from 'node:path'

export interface ClsiListenerOptions {
  app: RequestListener
  loadHttpApp: RequestListener
  loadTcpServer: TcpServer
  host: string
  port: number | string
  loadTcpPort: number | string
  loadHttpPort: number | string
  unixSocket?: string
}

export interface ClsiListeners {
  main: HttpServer
  loadHttp?: HttpServer
  close: () => Promise<void>
}

async function validateSocketPath(socketPath: string): Promise<void> {
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath.includes('\0') ||
    socketPath.endsWith('/') ||
    Buffer.byteLength(socketPath) > 100
  ) {
    throw new Error(
      'CLSI Unix socket requires a canonical absolute path of at most 100 bytes'
    )
  }
  if (!process.geteuid)
    throw new Error('CLSI Unix sockets require POSIX ownership')
  const uid = process.geteuid()
  const parent = dirname(socketPath)
  // realpath equality excludes symlinks in every parent component.
  if ((await realpath(parent)) !== parent) {
    throw new Error('CLSI Unix socket parent must not contain symlinks')
  }
  const leaf = await lstat(parent)
  if (
    !leaf.isDirectory() ||
    leaf.uid !== uid ||
    (leaf.mode & 0o7777) !== 0o700
  ) {
    throw new Error(
      'CLSI Unix socket parent must be worker-owned with mode 0700'
    )
  }
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor)
    const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== uid) ||
      ((info.mode & 0o022) !== 0 && !rootSticky)
    ) {
      throw new Error('CLSI Unix socket has an unsafe ancestor')
    }
    if (ancestor === dirname(ancestor)) break
  }
  try {
    await lstat(socketPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  throw new Error('CLSI Unix socket path already exists; refusing to remove it')
}

function tcpPort(value: number | string): number {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/.test(value))
  ) {
    throw new Error('Invalid CLSI TCP port')
  }
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid CLSI TCP port')
  }
  return port
}

function listen(server: TcpServer, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options)
  })
}

function closeServer(server: TcpServer): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
    if (
      'closeAllConnections' in server &&
      typeof server.closeAllConnections === 'function'
    ) {
      server.closeAllConnections()
    }
  })
}

/** Owns only the listeners it starts. Parent namespace must remain exclusively
 * managed by trusted worker/root code: Node close unlinks its bound pathname.
 * Existing paths are always refused, including sockets left by an abrupt exit.
 */
export async function startClsiListeners(
  options: ClsiListenerOptions
): Promise<ClsiListeners> {
  const socketPath = options.unixSocket
  if (socketPath !== undefined) await validateSocketPath(socketPath)
  const tcp =
    socketPath === undefined
      ? {
          port: tcpPort(options.port),
          loadTcpPort: tcpPort(options.loadTcpPort),
          loadHttpPort: tcpPort(options.loadHttpPort),
        }
      : undefined
  const main = createServer(options.app)
  const loadHttp =
    socketPath === undefined ? createServer(options.loadHttpApp) : undefined
  const owned: TcpServer[] = []
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      const results = await Promise.allSettled(owned.map(closeServer))
      const errors = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason as unknown)
      if (errors.length > 0)
        throw new AggregateError(errors, 'CLSI listener cleanup failed')
    })()
    return closing
  }
  try {
    if (socketPath !== undefined) {
      await listen(main, { path: socketPath })
      owned.push(main)
      await chmod(socketPath, 0o600)
    } else if (tcp && loadHttp) {
      await listen(main, { port: tcp.port, host: options.host })
      owned.push(main)
      await listen(options.loadTcpServer, {
        port: tcp.loadTcpPort,
        host: options.host,
      })
      owned.push(options.loadTcpServer)
      await listen(loadHttp, { port: tcp.loadHttpPort, host: options.host })
      owned.push(loadHttp)
    }
    return loadHttp ? { main, loadHttp, close } : { main, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'CLSI listener startup and cleanup failed',
        { cause: cleanupError }
      )
    }
    throw error
  }
}

export function installUnixListenerShutdown(
  listeners: ClsiListeners,
  onError: (error: Error) => void
): void {
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void listeners.close().then(
      () => process.exit(0),
      error => {
        try {
          onError(
            error instanceof Error
              ? error
              : new Error('CLSI listener shutdown failed', { cause: error })
          )
        } finally {
          process.exit(1)
        }
      }
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
