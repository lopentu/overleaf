import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import Docker from 'dockerode'
import tar from 'tar-stream'

export type Phase =
  | 'volume'
  | 'create'
  | 'start'
  | 'upload'
  | 'exec'
  | 'collect'
  | 'remove-container'
  | 'remove-volume'
export class DockerApiFixture {
  readonly events: string[] = []
  readonly failures = new Set<string>()
  readonly holds = new Map<Phase, Promise<void>>()
  containerConfig: Docker.ContainerCreateOptions | undefined
  volumeConfig: Docker.VolumeCreateOptions | undefined
  execConfig: Docker.ExecCreateOptions | undefined
  ownedContainer = false
  containerLabelsMismatch = false
  ownedVolume = false
  labelsMismatch = false
  exitCode = 0
  output = Buffer.from('ok')
  uploaded: Buffer = Buffer.alloc(0)
  execResponse: ServerResponse | undefined
  holdExec = false
  holdCollect = false
  lateVolumeDelayMs: number | undefined
  private lateVolumeTimer: ReturnType<typeof setTimeout> | undefined
  readonly server = http.createServer((request, response) => {
    void this.respond(request, response).catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error))
      )
    })
  })
  async open(): Promise<Docker> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (typeof address !== 'object' || address === null)
      throw new Error('address')
    return new Docker({
      host: '127.0.0.1',
      port: address.port,
      version: 'v1.47',
    })
  }
  async close(): Promise<void> {
    if (this.lateVolumeTimer) clearTimeout(this.lateVolumeTimer)
    this.server.closeAllConnections()
    await new Promise<void>(resolve =>
      this.server.close(() => {
        resolve()
      })
    )
  }
  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('unexpected body')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  private async respond(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const route = new URL(
      request.url ?? '/',
      'http://localhost'
    ).pathname.replace('/v1.47', '')
    const method = request.method
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (method === 'GET' && route === '/containers/json') {
      json(
        200,
        this.ownedContainer
          ? [
              {
                Id: 'job-container-id',
                Names: [`/${this.containerConfig?.name ?? ''}`],
                Labels: this.containerConfig?.Labels,
              },
            ]
          : []
      )
    } else if (method === 'GET' && route === '/volumes') {
      json(200, {
        Volumes: this.ownedVolume
          ? [
              {
                Name: this.volumeConfig?.Name,
                Labels: this.volumeConfig?.Labels,
              },
            ]
          : [],
      })
    } else if (method === 'POST' && route === '/volumes/create') {
      this.volumeConfig = JSON.parse(
        (await this.body(request)).toString()
      ) as Docker.VolumeCreateOptions
      this.events.push('volume')
      if (this.lateVolumeDelayMs !== undefined) {
        this.lateVolumeTimer = setTimeout(() => {
          this.ownedVolume = true
          this.events.push('late-volume')
        }, this.lateVolumeDelayMs)
        response.destroy()
        return
      }
      await this.holds.get('volume')
      this.ownedVolume = true
      json(201, { Name: this.volumeConfig.Name })
    } else if (method === 'GET' && route.startsWith('/volumes/')) {
      if (!this.ownedVolume) {
        json(404, { message: 'absent' })
        return
      }
      json(200, {
        Name: this.volumeConfig?.Name,
        Labels: this.labelsMismatch ? {} : this.volumeConfig?.Labels,
      })
    } else if (method === 'DELETE' && route.startsWith('/volumes/')) {
      this.events.push('remove-volume')
      await this.holds.get('remove-volume')
      if (this.failures.has('remove-volume')) {
        json(500, { message: 'volume busy' })
        return
      }
      if (this.ownedContainer) {
        json(409, { message: 'volume in use' })
        return
      }
      this.ownedVolume = false
      response.writeHead(204).end()
    } else if (method === 'POST' && route === '/containers/create') {
      this.containerConfig = JSON.parse(
        (await this.body(request)).toString()
      ) as Docker.ContainerCreateOptions
      this.events.push('create')
      await this.holds.get('create')
      this.ownedContainer = true
      json(201, { Id: 'job-container-id', Warnings: [] })
    } else if (
      method === 'GET' &&
      route.endsWith('/json') &&
      route.startsWith('/containers/')
    ) {
      if (!this.ownedContainer) {
        json(404, { message: 'absent' })
        return
      }
      json(200, {
        Id: 'job-container-id',
        Name: `/${this.containerConfig?.name ?? ''}`,
        Config: {
          Labels:
            this.labelsMismatch || this.containerLabelsMismatch
              ? {}
              : this.containerConfig?.Labels,
        },
      })
    } else if (method === 'DELETE' && route.startsWith('/containers/')) {
      this.events.push('remove-container')
      await this.holds.get('remove-container')
      if (this.failures.has('remove-container')) {
        json(500, { message: 'remove failure' })
        return
      }
      this.ownedContainer = false
      if (this.failures.has('remove-container-response')) {
        json(500, { message: 'ambiguous deletion response' })
        return
      }
      response.writeHead(204).end()
    } else if (
      method === 'POST' &&
      route.endsWith('/start') &&
      route.startsWith('/containers/')
    ) {
      this.events.push('start')
      await this.holds.get('start')
      response.writeHead(204).end()
    } else if (method === 'PUT' && route.endsWith('/archive')) {
      this.events.push('upload')
      this.uploaded = await this.body(request)
      await this.holds.get('upload')
      if (this.failures.has('upload')) {
        json(500, { message: 'upload failure' })
        return
      }
      response.writeHead(200).end()
    } else if (
      method === 'POST' &&
      route.endsWith('/exec') &&
      route.startsWith('/containers/')
    ) {
      this.execConfig = JSON.parse(
        (await this.body(request)).toString()
      ) as Docker.ExecCreateOptions
      json(201, { Id: 'exec-id' })
    } else if (method === 'POST' && route === '/exec/exec-id/start') {
      await this.body(request)
      this.events.push('exec')
      await this.holds.get('exec')
      this.execResponse = response
      response.writeHead(200, {
        'content-type': 'application/vnd.docker.raw-stream',
      })
      response.flushHeaders()
      if (!this.holdExec) {
        const header = Buffer.alloc(8)
        header[0] = 1
        header.writeUInt32BE(this.output.length, 4)
        response.end(Buffer.concat([header, this.output]))
      }
    } else if (method === 'GET' && route === '/exec/exec-id/json') {
      json(200, { ID: 'exec-id', Running: false, ExitCode: this.exitCode })
    } else if (method === 'POST' && route.endsWith('/pause')) {
      this.events.push('pause')
      response.writeHead(204).end()
    } else if (method === 'POST' && route.endsWith('/unpause')) {
      this.events.push('unpause')
      response.writeHead(204).end()
    } else if (method === 'GET' && route.endsWith('/archive')) {
      this.events.push('collect')
      await this.holds.get('collect')
      response.writeHead(200, { 'content-type': 'application/x-tar' })
      response.flushHeaders()
      if (this.holdCollect) {
        this.events.push('collect-stream')
        return
      }
      const pack = tar.pack()
      pack.entry({ name: 'compile/', type: 'directory' })
      pack.entry({ name: 'compile/result.pdf' }, Buffer.from('synthetic-pdf'))
      pack.finalize()
      pack.pipe(response)
    } else {
      this.events.push(`unexpected:${method ?? 'unknown'}:${route}`)
      json(404, { message: 'unsupported fixture route' })
    }
  }
}
export function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {
    throw new Error('uninitialized')
  }
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
export async function waitForEvent(
  fixture: DockerApiFixture,
  event: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.events.includes(event)) return
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error(`never reached ${event}`)
}
