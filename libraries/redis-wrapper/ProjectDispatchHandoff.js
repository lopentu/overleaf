// @ts-check

/** @typedef {import('./ProjectUpdateQueue').DispatchTicket} DispatchTicket */
/** @typedef {DispatchTicket & {shard: number, markerId: string}} DispatchMarker */
/** @typedef {DispatchTicket & {shard: number, docId: string, payload: string}} Intake */
/** @typedef {{call(command: string, ...args: string[]): Promise<unknown>}} StreamClient */

const group = 'document-updater'
const streamID = /^\d+-\d+$/

// A marker is disposable only after the exact project ticket was checked.
// The single-stream script also refuses a marker with different binding fields.
const removeMarker = `
local entry = redis.call('XRANGE', KEYS[1], ARGV[2], ARGV[2], 'COUNT', 1)[1]
if not entry then return 'marker_missing' end
if #entry[2] ~= #ARGV - 2 then return 'marker_mismatch' end
for i, field in ipairs(entry[2]) do
  if field ~= ARGV[i + 2] then return 'marker_mismatch' end
end
if redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]) ~= 1 then return 'not_pending' end
redis.call('XDEL', KEYS[1], ARGV[2])
return 'acknowledged'
`

/** @param {DispatchTicket} ticket */
function fields(ticket) {
  return [
    'project',
    ticket.projectId,
    'ticket',
    ticket.ticketId,
    'deadline',
    String(ticket.deadline),
  ]
}

/** @param {number} shard @param {unknown} input @returns {DispatchMarker[]} */
function parseEntries(shard, input) {
  if (!Array.isArray(input)) throw new Error('Invalid dispatch stream entries')
  return input.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error('Invalid dispatch marker')
    }
    const [markerId, values] = entry
    if (
      typeof markerId !== 'string' ||
      !streamID.test(markerId) ||
      !Array.isArray(values) ||
      values.length !== 6
    ) {
      throw new Error('Invalid dispatch marker')
    }
    const [projectField, projectId, ticketField, ticketId, deadlineField, raw] =
      values
    const deadline = Number(raw)
    if (
      projectField !== 'project' ||
      typeof projectId !== 'string' ||
      !projectId ||
      /[{}]/.test(projectId) ||
      ticketField !== 'ticket' ||
      typeof ticketId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ticketId) ||
      deadlineField !== 'deadline' ||
      raw !== String(deadline) ||
      !Number.isSafeInteger(deadline) ||
      deadline <= 0
    ) {
      throw new Error('Invalid dispatch marker')
    }
    return { shard, markerId, projectId, ticketId, deadline }
  })
}

/** @param {number} value */
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

class ProjectDispatchHandoff {
  /**
   * Use a dedicated Redis client for blocking reads. Project queue operations
   * use their own client. Give producer and dispatcher the same shard count.
   * @param {StreamClient} streams
   * @param {import('./ProjectUpdateQueue')} projectQueue
   * @param {number} shardCount
   */
  constructor(streams, projectQueue, shardCount) {
    if (!nonnegativeInteger(shardCount) || shardCount === 0) {
      throw new Error('Invalid dispatch shard count')
    }
    this.streams = streams
    this.projectQueue = projectQueue
    this.shardCount = shardCount
  }

  /** @param {number} shard */
  #key(shard) {
    if (!nonnegativeInteger(shard) || shard >= this.shardCount) {
      throw new Error('Invalid dispatch shard')
    }
    const legacy =
      shard === 0 ? 'pending-updates-list' : `pending-updates-list-${shard}`
    return `pending-updates-stream:{${legacy}}`
  }

  /** @param {number} shard */
  async openShard(shard) {
    const key = this.#key(shard)
    try {
      const result = await this.streams.call(
        'XGROUP',
        'CREATE',
        key,
        group,
        '0',
        'MKSTREAM'
      )
      if (result !== 'OK') throw new Error('Unexpected dispatch group reply')
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('BUSYGROUP ')
      ) {
        throw error
      }
    }
  }

  /** @param {Intake} input */
  async enqueue(input) {
    const { shard, projectId, ticketId, deadline, docId, payload } = input
    const ticket = { projectId, ticketId, deadline }
    const key = this.#key(shard)
    const status = await this.projectQueue.stageDispatch(ticket, docId, payload)
    if (status !== 'staged') return { status }
    const markerId = await this.streams.call(
      'XADD',
      key,
      '*',
      ...fields(ticket)
    )
    if (typeof markerId !== 'string' || !streamID.test(markerId)) {
      throw new Error('Unexpected dispatch marker ID')
    }
    const marker = { ...ticket, shard, markerId }
    return { status: await this.projectQueue.admitDispatch(marker), marker }
  }

  /**
   * @param {number} shard
   * @param {string} consumer
   * @param {number} [blockMs] Zero performs a nonblocking read.
   */
  async read(shard, consumer, blockMs = 0) {
    const key = this.#key(shard)
    if (!consumer || !nonnegativeInteger(blockMs))
      throw new Error('Invalid dispatch read')
    const blocking = blockMs === 0 ? [] : ['BLOCK', String(blockMs)]
    const result = await this.streams.call(
      'XREADGROUP',
      'GROUP',
      group,
      consumer,
      'COUNT',
      '1',
      ...blocking,
      'STREAMS',
      key,
      '>'
    )
    if (result === null) return []
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !Array.isArray(result[0]) ||
      result[0][0] !== key
    ) {
      throw new Error('Unexpected dispatch read reply')
    }
    return parseEntries(shard, result[0][1])
  }

  /**
   * @param {number} shard
   * @param {string} consumer
   * @param {number} minIdleMs
   * @param {string} [cursor]
   */
  async reclaim(shard, consumer, minIdleMs, cursor = '0-0') {
    const key = this.#key(shard)
    if (!consumer || !nonnegativeInteger(minIdleMs) || !streamID.test(cursor)) {
      throw new Error('Invalid dispatch reclaim')
    }
    const result = await this.streams.call(
      'XAUTOCLAIM',
      key,
      group,
      consumer,
      String(minIdleMs),
      cursor,
      'COUNT',
      '1'
    )
    if (
      !Array.isArray(result) ||
      typeof result[0] !== 'string' ||
      !streamID.test(result[0])
    ) {
      throw new Error('Unexpected dispatch reclaim reply')
    }
    // Redis 7 includes IDs of pending entries whose stream bodies disappeared.
    if (Array.isArray(result[2]) && result[2].length > 0) {
      throw new Error(
        'A pending dispatch marker was deleted before acknowledgement'
      )
    }
    return { cursor: result[0], markers: parseEntries(shard, result[1]) }
  }

  /** @param {DispatchMarker} marker */
  admit(marker) {
    return this.projectQueue.admitDispatch(marker)
  }

  /**
   * Call only after the project work finishes. The project-slot check refuses
   * the acknowledgement while any pending or in-flight batch exists.
   * @param {DispatchMarker} marker
   */
  async acknowledgeTerminal(marker) {
    const { shard, markerId, projectId, ticketId, deadline } = marker
    const ticket = { projectId, ticketId, deadline }
    const key = this.#key(shard)
    if (!streamID.test(markerId)) throw new Error('Invalid dispatch marker ID')
    const outcome = await this.projectQueue.checkDispatchTerminal(ticket)
    if (outcome === 'not_terminal') return outcome
    if (outcome !== 'terminal')
      throw new Error('Invalid dispatch marker ticket')
    const result = await this.streams.call(
      'EVAL',
      removeMarker,
      '1',
      key,
      group,
      markerId,
      ...fields(ticket)
    )
    if (
      result === 'acknowledged' ||
      result === 'marker_missing' ||
      result === 'not_pending'
    ) {
      return result
    }
    throw new Error('Unexpected dispatch marker removal reply')
  }
}

module.exports = ProjectDispatchHandoff
