import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import process from 'node:process'

type Role = 'web' | 'worker'

interface RelayPaths {
  listenerDirectory: string
  tlsDirectory: string
  backendPath: string
  tunnelSocket: string
}

const mountedPaths: RelayPaths = {
  listenerDirectory: '/relay/run',
  tlsDirectory: '/relay/tls',
  backendPath: '/relay/input/backend',
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

export function checkRelayPaths(
  paths: RelayPaths,
  owner: number,
  role: Role = 'worker',
  filestoreOwner = { uid: 0, gid: owner }
): 'socket' | 'directory' {
  const { listenerDirectory, tlsDirectory, backendPath, tunnelSocket } = paths
  const listeners = canonical(listenerDirectory)
  const tls = canonical(tlsDirectory)
  const backend = canonical(backendPath)
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
    !tunnel.isSocket() ||
    (backend.dev === tunnel.dev && backend.ino === tunnel.ino) ||
    [backendPath, tunnelSocket].some(input =>
      [listenerDirectory, tlsDirectory].some(directory =>
        contains(directory, input)
      )
    )
  )
    invalid()
  if (backend.isSocket()) return 'socket'
  if (
    role !== 'web' ||
    !backend.isDirectory() ||
    backend.uid !== filestoreOwner.uid ||
    backend.gid !== filestoreOwner.gid ||
    (backend.mode & 0o7777) !== 0o750 ||
    [listenerDirectory, tlsDirectory, tunnelSocket].some(path =>
      contains(backendPath, path)
    ) ||
    [listeners, tls].some(
      directory =>
        directory.dev === backend.dev && directory.ino === backend.ino
    )
  )
    invalid()

  const entries = readdirSync(backendPath)
  const socketName = 'filestore-http.sock'
  if (entries.some(entry => entry !== socketName)) invalid()
  const socket = lstatSync(join(backendPath, socketName), {
    throwIfNoEntry: false,
  })
  if (!socket) return 'directory'
  if (
    !socket.isSocket() ||
    socket.nlink !== 1 ||
    socket.uid !== filestoreOwner.uid ||
    (socket.dev === tunnel.dev && socket.ino === tunnel.ino)
  )
    invalid()
  return 'directory'
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
    !Array.isArray(relay.volumes) ||
    relay.volumes.length !== 5
  )
    return invalid()
  const role = relayRole(relay.command[0])
  const mounts = relay.volumes.map(record)
  function source(target: string, readOnly = true): string {
    const matches = mounts.filter(mount => mount.target === target)
    const [mount] = matches
    if (
      matches.length !== 1 ||
      mount.type !== 'bind' ||
      typeof mount.source !== 'string' ||
      (mount.read_only ?? false) !== readOnly
    )
      return invalid()
    return mount.source
  }
  source('/relay/config')
  const paths = {
    listenerDirectory: source(mountedPaths.listenerDirectory, false),
    tlsDirectory: source(mountedPaths.tlsDirectory),
    backendPath: source(mountedPaths.backendPath),
    tunnelSocket: source(mountedPaths.tunnelSocket),
  }
  if (
    paths.backendPath !== expectedBackend ||
    paths.tunnelSocket !== expectedTunnel ||
    (role === 'worker' && basename(expectedBackend) !== 'clsi.sock')
  )
    return invalid()
  checkRelayPaths(paths, 33, role)
}

if (typeof import.meta.main !== 'boolean') invalid()

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--check' && args.length === 3) {
      checkRenderedConfig(args[1], args[2])
    } else if (args[0] === '--run' && args.length === 2) {
      const role = relayRole(args[1])
      const mode = checkRelayPaths(mountedPaths, 33, role)
      const config = mode === 'directory' ? 'web-directory' : role
      const nginx = '/usr/sbin/nginx'
      if (process.execve === undefined) invalid()
      process.execve(nginx, [
        nginx,
        '-c',
        `/relay/config/${config}.conf`,
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
