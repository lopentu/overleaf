import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'
import process from 'node:process'

type Role = 'web' | 'worker'

interface RelayPaths {
  listenerDirectory: string
  tlsDirectory: string
  backendSocket: string
  tunnelSocket: string
}

const mountedPaths: RelayPaths = {
  listenerDirectory: '/relay/run',
  tlsDirectory: '/relay/tls',
  backendSocket: '/relay/input/upstream.sock',
  tunnelSocket: '/relay/input/tunnel.sock',
}

function invalid(): never {
  throw new Error('COMPILER_RELAY_INPUTS_INVALID')
}

function canonical(path: string) {
  if (!isAbsolute(path) || realpathSync(path) !== path) invalid()
  return lstatSync(path)
}

function contains(directory: string, path: string) {
  const local = relative(directory, path)
  return local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)
}

export function checkRelayPaths(paths: RelayPaths, owner: number): void {
  const { listenerDirectory, tlsDirectory, backendSocket, tunnelSocket } = paths
  const listeners = canonical(listenerDirectory)
  const tls = canonical(tlsDirectory)
  const backend = canonical(backendSocket)
  const tunnel = canonical(tunnelSocket)
  if (
    !listeners.isDirectory() ||
    listeners.uid !== owner ||
    (listeners.mode & 0o7777) !== 0o700 ||
    readdirSync(listenerDirectory).length !== 0 ||
    !tls.isDirectory() ||
    (tls.uid !== owner && tls.uid !== 0) ||
    (tls.mode & 0o027) !== 0 ||
    (tls.dev === listeners.dev && tls.ino === listeners.ino) ||
    contains(listenerDirectory, tlsDirectory) ||
    contains(tlsDirectory, listenerDirectory) ||
    !backend.isSocket() ||
    !tunnel.isSocket() ||
    (backend.dev === tunnel.dev && backend.ino === tunnel.ino) ||
    [backendSocket, tunnelSocket].some(socket =>
      [listenerDirectory, tlsDirectory].some(directory =>
        contains(directory, socket)
      )
    )
  )
    invalid()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid()
  return value as Record<string, unknown>
}

function relayRole(value: unknown): Role {
  if (value !== 'web' && value !== 'worker') return invalid()
  return value
}

function checkRenderedConfig(expectedBackend: string, expectedTunnel: string) {
  const config: unknown = JSON.parse(readFileSync(0, 'utf8'))
  const relay = record(record(record(config).services).relay)
  if (
    !Array.isArray(relay.command) ||
    relay.command.length !== 1 ||
    !Array.isArray(relay.volumes)
  )
    return invalid()
  const role = relayRole(relay.command[0])
  const mounts = relay.volumes.map(record)
  function source(target: string): string {
    const matches = mounts.filter(mount => mount.target === target)
    const [mount] = matches
    if (
      matches.length !== 1 ||
      mount.type !== 'bind' ||
      typeof mount.source !== 'string'
    )
      return invalid()
    return mount.source
  }
  const paths = {
    listenerDirectory: source(mountedPaths.listenerDirectory),
    tlsDirectory: source(mountedPaths.tlsDirectory),
    backendSocket: source(mountedPaths.backendSocket),
    tunnelSocket: source(mountedPaths.tunnelSocket),
  }
  if (
    paths.backendSocket !== expectedBackend ||
    paths.tunnelSocket !== expectedTunnel ||
    (role === 'worker' && basename(expectedBackend) !== 'clsi.sock')
  )
    return invalid()
  checkRelayPaths(paths, 33)
}

if (typeof import.meta.main !== 'boolean') invalid()

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--check' && args.length === 3) {
      checkRenderedConfig(args[1], args[2])
    } else if (args[0] === '--run' && args.length === 2) {
      const role = relayRole(args[1])
      checkRelayPaths(mountedPaths, 33)
      const nginx = '/usr/sbin/nginx'
      if (process.execve === undefined) invalid()
      process.execve(nginx, [
        nginx,
        '-c',
        `/relay/config/${role}.conf`,
        '-g',
        'daemon off;',
      ])
    } else {
      invalid()
    }
  } catch {
    process.stderr.write('COMPILER_RELAY_STARTUP_FAILED\n')
    process.exitCode = 1
  }
}
