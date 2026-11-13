import type { FileHandle } from 'node:fs/promises'
import { Writable } from 'node:stream'

const FILE_CHUNK_BYTES = 64 * 1024

/** Only the caller closes the FileHandle, after this iterator has settled. */
export async function* readFileChunks(
  file: FileHandle,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  for (;;) {
    signal?.throwIfAborted()
    const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
    signal?.throwIfAborted()
    if (bytesRead === 0) return
    yield buffer.subarray(0, bytesRead)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Borrow a FileHandle without transferring descriptor ownership. Destruction
 * waits for the current write, so the caller may close after pipeline settles.
 */
export function createFileWriter(file: FileHandle): Writable {
  let pending: Promise<void> = Promise.resolve()
  async function writeAll(chunk: Buffer): Promise<void> {
    let offset = 0
    while (offset < chunk.length) {
      const remaining = chunk.length - offset
      const { bytesWritten } = await file.write(chunk, offset, remaining, null)
      if (
        !Number.isSafeInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        bytesWritten > remaining
      ) {
        throw new Error('Archive file write made invalid progress')
      }
      offset += bytesWritten
    }
  }
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) {
        callback(new Error('Archive file stream must be binary'))
        return
      }
      pending = writeAll(chunk)
      void pending.then(
        () => {
          callback()
        },
        (error: unknown) => {
          callback(asError(error))
        }
      )
    },
    destroy(error, callback) {
      void pending.then(
        () => {
          callback(error)
        },
        (writeError: unknown) => {
          callback(error ?? asError(writeError))
        }
      )
    },
  })
}
