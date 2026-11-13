import { Transform, Writable, type Duplex } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type Docker from 'dockerode'

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_WIRE_BYTES = 2 * MAX_OUTPUT_BYTES
/**
 * Validate framing without routing/decoding output. The official modem recursively
 * drains every frame from one data event and has no EOF/completion callback.
 * Deliver each complete header and payload portion separately: a decoder event
 * can finish at most one frame, regardless of the source chunk's frame count.
 * Large payload portions stay intact rather than forcing quadratic tiny copies
 * in the modem's private pending-payload buffer.
 */
function checkedDockerWire(): Transform {
  const header = Buffer.alloc(8)
  let headerBytes = 0
  let payloadBytes = 0
  let declaredBytes = 0
  let wireBytes = 0
  return new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (
        !Buffer.isBuffer(chunk) ||
        (wireBytes += chunk.length) > MAX_WIRE_BYTES
      ) {
        callback(new Error('Compile output wire limit exceeded'))
        return
      }
      let offset = 0
      while (offset < chunk.length) {
        if (payloadBytes > 0) {
          const length = Math.min(payloadBytes, chunk.length - offset)
          payloadBytes -= length
          this.push(chunk.subarray(offset, offset + length))
          offset += length
          continue
        }
        const length = Math.min(
          header.length - headerBytes,
          chunk.length - offset
        )
        chunk.copy(header, headerBytes, offset, offset + length)
        offset += length
        headerBytes += length
        if (headerBytes !== header.length) continue
        const channel = header.readUInt8(0)
        if (
          (channel !== 0 && channel !== 1 && channel !== 2) ||
          header.readUIntBE(1, 3) !== 0
        ) {
          callback(new Error('Invalid Docker exec output frame header'))
          return
        }
        payloadBytes = header.readUInt32BE(4)
        if (payloadBytes > MAX_OUTPUT_BYTES - declaredBytes) {
          callback(new Error('Compile output limit exceeded'))
          return
        }
        declaredBytes += payloadBytes
        headerBytes = 0
        // Do not expose the mutable header reused for the following frame.
        this.push(Buffer.from(header))
      }
      callback()
    },
    flush(callback) {
      callback(
        headerBytes !== 0 || payloadBytes !== 0
          ? new Error('Incomplete Docker exec output frame')
          : undefined
      )
    },
  })
}
/** Use Dockerode's protocol decoder, with independent decoded and wire caps. */
export async function collectExecOutput(
  docker: Docker,
  source: Duplex,
  signal: AbortSignal
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  let total = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const wire = checkedDockerWire()
  const sink = (chunks: Buffer[]): Writable =>
    new Writable({
      write(chunk: unknown, _encoding, callback) {
        if (
          !Buffer.isBuffer(chunk) ||
          (total += chunk.length) > MAX_OUTPUT_BYTES
        )
          callback(new Error('Compile output limit exceeded'))
        else {
          if (chunk.length > 0) chunks.push(chunk)
          callback()
        }
      },
    })
  const out = sink(stdout)
  const err = sink(stderr)
  const fail = (error: Error): void => {
    source.destroy(error)
  }
  out.on('error', fail)
  err.on('error', fail)
  const outDone = finished(out, { cleanup: true })
  const errDone = finished(err, { cleanup: true })
  void outDone.catch(() => {})
  void errDone.catch(() => {})
  docker.modem.demuxStream(wire, out, err)
  try {
    await pipeline(source, wire, { signal })
    out.end()
    err.end()
    await Promise.all([outDone, errDone])
    return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
  } finally {
    source.destroy()
    wire.destroy()
    out.destroy()
    err.destroy()
    await Promise.allSettled([outDone, errDone])
  }
}
