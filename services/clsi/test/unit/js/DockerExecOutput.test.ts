import nodeAssert from 'node:assert/strict'
import Docker from 'dockerode'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { collectExecOutput } from '../../../app/js/DockerExecOutput.ts'

// Creates a modem only. No Docker API call, socket or network operation occurs.
const docker = new Docker({ host: '127.0.0.1', port: 1 })
function frame(channel: number, content: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header[0] = channel
  header.writeUInt32BE(content.length, 4)
  return Buffer.concat([header, content])
}
async function collect(
  chunks: readonly Buffer[]
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const source = new PassThrough()
  const result = collectExecOutput(docker, source, new AbortController().signal)
  // Feeding after collection attaches handlers mirrors Dockerode's live stream.
  for (const chunk of chunks) source.write(chunk)
  source.end()
  return await result
}
describe('bounded Dockerode exec output framing', () => {
  it('accepts 4000 valid one-byte frames in a single 36 KB source chunk without recursive overflow', async () => {
    const wire = Buffer.concat(
      Array.from({ length: 4000 }, () => frame(1, Buffer.from('A')))
    )
    const result = await collect([wire])
    expect(result.stdout).toEqual(Buffer.alloc(4000, 'A'))
    expect(result.stderr.length).toBe(0)
  })
  for (const wire of [
    Buffer.from([1, 0, 0]),
    frame(1, Buffer.from('hello')).subarray(0, 9),
  ]) {
    it(`rejects EOF inside a ${wire.length === 3 ? 'header' : 'payload'} rather than reporting empty success`, async () => {
      await nodeAssert.rejects(collect([wire]), /incomplete|truncated/i)
    })
  }
  it('accepts empty output and zero-length stdout/stderr frames', async () => {
    expect(await collect([])).toEqual({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    })
    expect(
      await collect([frame(1, Buffer.alloc(0)), frame(2, Buffer.alloc(0))])
    ).toEqual({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  })
  it('routes interleaved channels with arbitrary transport boundaries including each header byte', async () => {
    const wire = Buffer.concat([
      frame(1, Buffer.from('first')),
      frame(2, Buffer.from('error')),
      frame(1, Buffer.alloc(0)),
      frame(1, Buffer.from([0, 255, 13, 10])),
    ])
    const result = await collect(Array.from(wire, byte => Buffer.from([byte])))
    expect(result.stdout).toEqual(
      Buffer.concat([Buffer.from('first'), Buffer.from([0, 255, 13, 10])])
    )
    expect(result.stderr.toString()).toBe('error')
  })
  it('accepts a large payload and many trailing small frames in the same chunk', async () => {
    const large = Buffer.alloc(256 * 1024, 0x42)
    const tinyFrames = Array.from({ length: 4000 }, () =>
      frame(2, Buffer.from('E'))
    )
    const result = await collect([
      Buffer.concat([frame(1, large), ...tinyFrames]),
    ])
    expect(result.stdout).toEqual(large)
    expect(result.stderr).toEqual(Buffer.alloc(4000, 'E'))
  })
  it('rejects incomplete payload after a completed frame rather than returning the prefix', async () => {
    await nodeAssert.rejects(
      collect([
        frame(1, Buffer.from('prefix')),
        frame(2, Buffer.from('incomplete')).subarray(0, 10),
      ]),
      /incomplete|truncated/i
    )
  })
  for (const wire of [
    frame(3, Buffer.from('bad')),
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
  ]) {
    it(`rejects malformed non-TTY framing ${wire.toString('hex')}`, async () => {
      await nodeAssert.rejects(collect([wire]), /frame|header/i)
    })
  }
  it('enforces the combined decoded budget across stdout and stderr', async () => {
    const almost = Buffer.alloc(1024 * 1024 - 1)
    await nodeAssert.rejects(
      collect([frame(1, almost), frame(2, Buffer.alloc(2))]),
      /output.*limit/i
    )
  })
  it('accepts exactly the combined decoded limit with a large split payload', async () => {
    const wire = frame(1, Buffer.alloc(1024 * 1024, 0x43))
    const result = await collect([wire.subarray(0, 100), wire.subarray(100)])
    expect(result.stdout.length).toBe(1024 * 1024)
    expect(result.stdout[1024 * 1024 - 1]).toBe(0x43)
  })
  it('rejects excessive framing wire bytes even when decoded data is empty', async () => {
    const empty = frame(1, Buffer.alloc(0))
    const wire = Buffer.alloc(2 * 1024 * 1024 + 8)
    for (let offset = 0; offset < wire.length; offset += 8)
      empty.copy(wire, offset)
    await nodeAssert.rejects(collect([wire]), /wire.*limit/i)
  })
})
