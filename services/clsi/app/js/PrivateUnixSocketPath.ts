import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'

/** Requires an exclusively trusted worker/root namespace; never creates or
 * removes an endpoint. Does not protect against malicious same-UID/root changes.
 */
export async function assertNewPrivateUnixSocketPath(
  socketPath: string
): Promise<void> {
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath.includes('\0') ||
    socketPath.endsWith('/') ||
    Buffer.byteLength(socketPath) > 100
  )
    throw new Error(
      'Private Unix socket requires a canonical absolute path of at most 100 bytes'
    )
  if (!process.geteuid)
    throw new Error('Private Unix sockets require POSIX ownership')
  const uid = process.geteuid()
  const parent = dirname(socketPath)
  if ((await realpath(parent)) !== parent)
    throw new Error('Private Unix socket parent must not contain symlinks')
  const leaf = await lstat(parent)
  if (!leaf.isDirectory() || leaf.uid !== uid || (leaf.mode & 0o7777) !== 0o700)
    throw new Error(
      'Private Unix socket parent must be worker-owned with mode 0700'
    )
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor)
    const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== uid) ||
      ((info.mode & 0o022) !== 0 && !rootSticky)
    )
      throw new Error('Private Unix socket has an unsafe ancestor')
    if (ancestor === dirname(ancestor)) break
  }
  try {
    await lstat(socketPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  throw new Error(
    'Private Unix socket path already exists; refusing to remove it'
  )
}
