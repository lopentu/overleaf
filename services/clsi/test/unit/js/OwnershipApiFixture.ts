import http from 'node:http'
import { once } from 'node:events'
import Docker from 'dockerode'

interface Resource {
  identity: string
  manager: string
  name: string
  drift: boolean
}
const OWNER = 'org.lope.overleaf.compiler-job'
const MANAGED = 'org.lope.overleaf.managed-by'
const MANAGER = 'ephemeral-docker-job-v1'
export class OwnershipApiFixture {
  readonly containers = new Map<string, Resource>()
  readonly volumes = new Map<string, Resource>()
  readonly failures = new Set<string>()
  readonly events: string[] = []
  listHold: Promise<void> | undefined
  volumeListHold: Promise<void> | undefined
  listCalls = 0
  concurrentLists = 0
  maxConcurrentLists = 0
  readonly server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const route = url.pathname.replace('/v1.47', '')
      const json = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const labels = (resource: Resource): Record<string, string> => ({
        [OWNER]: resource.identity,
        [MANAGED]: resource.drift ? 'foreign-after-inspect' : resource.manager,
      })
      if (route === '/containers/json' || route === '/volumes') {
        this.listCalls++
        this.concurrentLists++
        this.maxConcurrentLists = Math.max(
          this.maxConcurrentLists,
          this.concurrentLists
        )
        try {
          await this.listHold
          if (route === '/volumes') await this.volumeListHold
          if (this.failures.has('list')) {
            json(500, { message: 'list failure' })
            return
          }
          this.events.push(`filter:${url.searchParams.get('filters') ?? ''}`)
          // Return foreign records too: the implementation must not trust server-side filtering alone.
          if (route === '/containers/json')
            json(
              200,
              Array.from(this.containers, ([id, resource]) => ({
                Id: id,
                Names: [`/${resource.name}`],
                Labels: {
                  [OWNER]: resource.identity,
                  [MANAGED]: resource.manager,
                },
              }))
            )
          else
            json(200, {
              Volumes: Array.from(this.volumes, ([name, resource]) => ({
                Name: name,
                Labels: {
                  [OWNER]: resource.identity,
                  [MANAGED]: resource.manager,
                },
              })),
            })
        } finally {
          this.concurrentLists--
        }
        return
      }
      const parts = route.split('/')
      const kind = parts[1]
      const key = decodeURIComponent(parts[2] ?? '')
      const records = kind === 'containers' ? this.containers : this.volumes
      const record = Array.from(records).find(
        ([id, resource]) => id === key || resource.name === key
      )
      const resource = record?.[1]
      if (!resource) {
        json(404, { message: 'absent' })
        return
      }
      if (request.method === 'GET') {
        if (this.failures.has('inspect')) {
          json(500, { message: 'inspect failure' })
          return
        }
        json(
          200,
          kind === 'containers'
            ? {
                Id: key,
                Name: `/${resource.name}`,
                Config: { Labels: labels(resource) },
              }
            : { Name: resource.name, Labels: labels(resource) }
        )
      } else if (request.method === 'DELETE') {
        this.events.push(`remove:${kind}:${key}`)
        if (this.failures.has('remove')) {
          json(500, { message: 'remove failure' })
          return
        }
        records.delete(record?.[0] ?? key)
        response.writeHead(204).end()
      } else json(400, { message: 'unsupported fixture method' })
    })().catch((error: unknown) =>
      response.destroy(
        error instanceof Error ? error : new Error('fixture failure')
      )
    )
  })
  async open(): Promise<Docker> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    return this.client()
  }
  async client(): Promise<Docker> {
    const address = this.server.address()
    if (typeof address !== 'object' || address === null)
      throw new Error('not listening')
    return new Docker({
      host: '127.0.0.1',
      port: address.port,
      version: 'v1.47',
    })
  }
  addContainer(
    identity: string,
    manager = MANAGER,
    name = `lope-clsi-job-${identity}`
  ): Resource {
    const resource = { identity, manager, name, drift: false }
    this.containers.set(`container-${identity}`, resource)
    return resource
  }
  addVolume(
    identity: string,
    manager = MANAGER,
    name = `lope-clsi-job-${identity}`
  ): Resource {
    const resource = { identity, manager, name, drift: false }
    this.volumes.set(name, resource)
    return resource
  }
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
