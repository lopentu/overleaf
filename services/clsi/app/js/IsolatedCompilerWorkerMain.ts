import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { z } from '@overleaf/validation-tools'
import type { IsolatedCompilerWorkerConfiguration } from './IsolatedCompilerWorker.ts'

const MAX_CONFIG_BYTES = 64 * 1024
const nonempty = z.string().min(1)
const configurationShape = z.strictObject({
  runtimeRoot: nonempty,
  stateRoot: nonempty,
  dockerSocket: nonempty,
  daemonId: nonempty,
  profile: z.strictObject({
    id: nonempty,
    image: nonempty,
    aliases: z.array(nonempty).min(1).max(64),
    variant: z.enum(['standard', 'checkpoint']),
    texBinDirectory: nonempty,
    tools: z.strictObject({
      latexmk: nonempty,
      texcount: nonempty,
      synctex: nonempty,
      time: nonempty.optional(),
    }),
    latexmkCommandPrefix: z.array(nonempty).max(2).optional(),
  }),
  downloadHost: nonempty,
  outputUrlPrefix: z.string(),
  filestoreBridge: z
    .strictObject({ sourceOrigin: nonempty, proxyOrigin: nonempty })
    .optional(),
})

function invalidConfig(): Error {
  return new Error('ISOLATED_WORKER_CONFIG_INVALID')
}

async function readConfiguration(
  filePath: string
): Promise<IsolatedCompilerWorkerConfiguration> {
  const uid = process.geteuid?.()
  if (
    uid === undefined ||
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath ||
    Buffer.byteLength(filePath) > 4096
  )
    throw invalidConfig()

  try {
    const parent = path.dirname(filePath)
    if ((await realpath(parent)) !== parent) throw invalidConfig()
    for (let current = parent; ; current = path.dirname(current)) {
      const stat = await lstat(current)
      const rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0
      if (
        !stat.isDirectory() ||
        (stat.uid !== 0 && stat.uid !== uid) ||
        ((stat.mode & 0o022) !== 0 && !rootSticky)
      )
        throw invalidConfig()
      if (current === path.dirname(current)) break
    }

    if (!(await lstat(filePath)).isFile()) throw invalidConfig()
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        (stat.uid !== 0 && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0 ||
        stat.size < 1 ||
        stat.size > MAX_CONFIG_BYTES
      )
        throw invalidConfig()

      // One extra byte detects growth while using the same checked descriptor.
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset
        )
        if (bytesRead === 0) break
        offset += bytesRead
      }
      const after = await file.stat()
      if (
        offset !== stat.size ||
        after.size !== stat.size ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw invalidConfig()

      const decoded: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, offset)
        )
      )
      const { profile, filestoreBridge, ...configuration } =
        configurationShape.parse(decoded)
      const { tools, latexmkCommandPrefix, ...profileFields } = profile
      const { time, ...requiredTools } = tools
      return {
        ...configuration,
        profile: {
          ...profileFields,
          tools: { ...requiredTools, ...(time === undefined ? {} : { time }) },
          ...(latexmkCommandPrefix === undefined
            ? {}
            : { latexmkCommandPrefix }),
        },
        ...(filestoreBridge === undefined ? {} : { filestoreBridge }),
      }
    } finally {
      await file.close()
    }
  } catch {
    throw invalidConfig()
  }
}

export async function runIsolatedCompilerWorker(
  args: readonly string[],
  stopping: AbortSignal
): Promise<void> {
  const [flag, file] = args
  if (args.length !== 2 || flag !== '--config' || file === undefined)
    throw invalidConfig()
  const configuration = await readConfiguration(file)
  if (stopping.aborted) return
  const { startIsolatedCompilerWorker } =
    await import('./IsolatedCompilerWorker.ts')
  if (stopping.aborted) return
  const worker = await startIsolatedCompilerWorker(configuration)
  try {
    if (!stopping.aborted) await once(stopping, 'abort')
  } finally {
    try {
      await worker.close()
    } catch {
      // The factory keeps its lease while owned cleanup is incomplete.
      await worker.close()
    }
  }
}

if (import.meta.main) {
  const stopping = new AbortController()
  const stop = () => stopping.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await runIsolatedCompilerWorker(process.argv.slice(2), stopping.signal)
  } catch {
    process.stderr.write('ISOLATED_WORKER_LAUNCH_FAILED\n')
    process.exitCode = 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}
