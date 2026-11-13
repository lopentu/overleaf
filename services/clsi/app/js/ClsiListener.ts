import { chmod } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener, Server as HttpServer } from 'node:http'
import type { ListenOptions, Server as TcpServer } from 'node:net'
import { assertNewPrivateUnixSocketPath } from './PrivateUnixSocketPath.ts'

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
  if (socketPath !== undefined) await assertNewPrivateUnixSocketPath(socketPath)
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
