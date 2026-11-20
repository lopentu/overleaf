const { lstatSync, unlinkSync } = require('node:fs')
const { createConnection } = require('node:net')
const { dirname } = require('node:path')

/** @param {string} path */
function proveSocketIsStale(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error('The filestore socket already has a listener'))
    })
    socket.once('error', error => {
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(undefined)
      else reject(error)
    })
    socket.setTimeout(1000, () => {
      socket.destroy(new Error('The filestore socket probe timed out'))
    })
  })
}

/** @param {string} path */
async function prepareFilestoreSocket(path, owner = 33) {
  const directory = lstatSync(dirname(path))
  const mode = directory.mode & 0o7777
  const writer = process.geteuid?.()
  const shared =
    directory.uid === writer && directory.gid === owner && mode === 0o750
  const dedicated = directory.uid === owner && mode === 0o700
  if (!directory.isDirectory() || (!shared && !dedicated)) {
    throw new Error(
      'The filestore socket requires its private runtime directory'
    )
  }

  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (!existing) return
  if (
    !existing.isSocket() ||
    existing.nlink !== 1 ||
    (existing.uid !== writer && (shared || existing.uid !== owner))
  ) {
    throw new Error('The filestore socket path contains an unexpected file')
  }

  await proveSocketIsStale(path)
  const current = lstatSync(path, { throwIfNoEntry: false })
  if (!current) return
  if (current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error('The filestore socket changed during the startup check')
  }
  unlinkSync(path)
}

module.exports = { prepareFilestoreSocket }

if (require.main === module) {
  prepareFilestoreSocket(
    '/run/overleaf-compiler/filestore/filestore-http.sock'
  ).catch(() => {
    console.error('NGINX could not prepare the private filestore socket')
    process.exitCode = 1
  })
}
