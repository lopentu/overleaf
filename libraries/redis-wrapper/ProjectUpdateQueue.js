// @ts-check

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const script = readFileSync(join(__dirname, 'ProjectUpdateQueue.lua'), 'utf8')

/**
 * @typedef {{eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>}} ScriptClient
 * @typedef {(params: {project_id: string}) => string} PendingKeyBuilder
 * @typedef {{status: 'enqueued', length: number} |
 *   {status: 'document_fenced' | 'invalid_update'}} EnqueueResult
 * @typedef {{status: 'batch_claimed' | 'batch_replayed', entries: string[]} |
 *   {status: 'empty' | 'another_batch_in_flight' | 'stale_batch_generation'}} ClaimResult
 * @typedef {{status: 'acknowledged', generation: string} |
 *   {status: 'no_batch_in_flight' | 'another_batch_in_flight' | 'stale_batch_generation'}} AcknowledgeResult
 * @typedef {'legacy' | 'guarded'} DrainMode
 * @typedef {{status: 'popped', length: number, entries: string[]} |
 *   {status: 'guarded'}} LegacyPopResult
 * @typedef {{projectId: string, ticketId: string, deadline: number}} DispatchTicket
 */

/**
 * @template {string} T
 * @param {string} status
 * @param {readonly T[]} expected
 * @returns {T}
 */
function knownStatus(status, expected) {
  const recognised = expected.find(value => value === status)
  if (recognised === undefined) {
    throw new Error('Unexpected project update queue response')
  }
  return recognised
}

/**
 * @param {unknown} generation
 * @returns {generation is string}
 */
function isGeneration(generation) {
  return typeof generation === 'string' && /^(0|[1-9]\d*)$/.test(generation)
}

class ProjectUpdateQueue {
  /**
   * @param {ScriptClient} client
   * @param {PendingKeyBuilder} pendingProjectUpdates Existing service key builder.
   */
  constructor(client, pendingProjectUpdates) {
    this.client = client
    this.pendingProjectUpdates = pendingProjectUpdates
  }

  /**
   * @param {string} projectId
   * @param {...string} args
   * @returns {Promise<[string, ...unknown[]]>}
   */
  async #run(projectId, ...args) {
    return this.#runWithKeys(projectId, args)
  }

  /**
   * @param {string} projectId
   * @param {string[]} args
   * @param {string} [ticketId]
   * @returns {Promise<[string, ...unknown[]]>}
   */
  async #runWithKeys(projectId, args, ticketId) {
    if (!projectId || projectId.includes('{') || projectId.includes('}')) {
      throw new Error('Invalid project hash tag')
    }
    const tag = `{${projectId}}`
    const pending = this.pendingProjectUpdates({ project_id: projectId })
    const firstBrace = pending.indexOf('{')
    if (firstBrace < 0 || !pending.startsWith(tag, firstBrace)) {
      throw new Error('Pending queue must use the project hash tag')
    }
    const keys = [
      pending,
      `EditableRetirements:${tag}`,
      `PendingProjectUpdatesInFlight:${tag}`,
      `PendingProjectUpdatesGeneration:${tag}`,
    ]
    if (ticketId !== undefined) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ticketId)) {
        throw new Error('Invalid dispatch ticket ID')
      }
      keys.push(`PreparedDispatch:${tag}:${ticketId}`)
    }
    if (new Set(keys).size !== keys.length) {
      throw new Error('Pending queue key collides with retirement state')
    }

    const reply = await this.client.eval(script, keys.length, ...keys, ...args)
    if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
      throw new Error('Unexpected project update queue response')
    }
    if (reply[0] === 'invalid_arguments' || reply[0] === 'invalid_outcome') {
      throw new Error('Invalid project update queue arguments')
    }
    return [reply[0], ...reply.slice(1)]
  }

  /**
   * @param {DispatchTicket} ticket
   * @param {string[]} args
   */
  #runDispatch(ticket, args) {
    if (!Number.isSafeInteger(ticket.deadline) || ticket.deadline <= 0) {
      throw new Error('Invalid dispatch ticket deadline')
    }
    return this.#runWithKeys(ticket.projectId, args, ticket.ticketId)
  }

  /**
   * @param {DispatchTicket} ticket
   * @param {string} docId
   * @param {string} payload
   */
  async stageDispatch(ticket, docId, payload) {
    const [status] = await this.#runDispatch(ticket, [
      'stage-dispatch',
      docId,
      String(ticket.deadline),
      payload,
    ])
    return knownStatus(status, [
      'staged',
      'expired',
      'invalid_update',
      'ticket_conflict',
    ])
  }

  /** @param {DispatchTicket} ticket */
  async admitDispatch(ticket) {
    const [status] = await this.#runDispatch(ticket, [
      'admit-dispatch',
      String(ticket.deadline),
    ])
    return knownStatus(status, [
      'admitted',
      'document_fenced',
      'missing',
      'ticket_conflict',
    ])
  }

  /** @param {DispatchTicket} ticket */
  async checkDispatchTerminal(ticket) {
    const [status] = await this.#runDispatch(ticket, [
      'terminal-dispatch',
      String(ticket.deadline),
    ])
    return knownStatus(status, ['terminal', 'not_terminal', 'ticket_conflict'])
  }

  /**
   * @param {string} projectId
   * @param {string} docId
   * @param {string} payload Serialized editor operation carrying docId.
   * @returns {Promise<EnqueueResult>}
   */
  async enqueue(projectId, docId, payload) {
    const [status, length] = await this.#run(
      projectId,
      'enqueue',
      docId,
      payload
    )
    if (
      status === 'enqueued' &&
      typeof length === 'number' &&
      Number.isSafeInteger(length) &&
      length > 0
    ) {
      return { status, length }
    }
    return {
      status: knownStatus(status, ['document_fenced', 'invalid_update']),
    }
  }

  /**
   * Inspect the project's persistent queue mode without changing it.
   * @param {string} projectId
   * @returns {Promise<DrainMode>}
   */
  async getDrainMode(projectId) {
    const [status] = await this.#run(projectId, 'drain-mode')
    return knownStatus(status, /** @type {const} */ (['legacy', 'guarded']))
  }

  /**
   * Permanently refuse patched legacy drains for this project.
   * @param {string} projectId
   * @returns {Promise<'guarded'>}
   */
  async protectLegacyDrain(projectId) {
    const [status] = await this.#run(projectId, 'protect-legacy-drain')
    return knownStatus(status, /** @type {const} */ (['guarded']))
  }

  /**
   * Check protection and pop at most eight legacy entries in one EVAL.
   * @param {string} projectId
   * @returns {Promise<LegacyPopResult>}
   */
  async popLegacyBatch(projectId) {
    const [status, length, entries] = await this.#run(projectId, 'legacy-pop')
    if (status === 'guarded') return { status }
    if (
      status !== 'popped' ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Array.isArray(entries) ||
      !entries.every(entry => typeof entry === 'string')
    ) {
      throw new Error('Unexpected project update queue response')
    }
    return { status, length, entries }
  }

  /**
   * @param {string} projectId
   * @returns {Promise<{generation: string, activeBatchId: string | null}>}
   */
  async getBatchState(projectId) {
    const [status, generation, activeBatchId] = await this.#run(
      projectId,
      'state'
    )
    if (
      status !== 'state' ||
      !isGeneration(generation) ||
      (activeBatchId !== null && typeof activeBatchId !== 'string')
    ) {
      throw new Error('Unexpected project update queue response')
    }
    return { generation, activeBatchId }
  }

  /**
   * @param {string} projectId
   * @param {string} batchId Unique claimant identity for this generation.
   * @param {string} generation
   * @returns {Promise<ClaimResult>}
   */
  async claimBatch(projectId, batchId, generation) {
    const [status, entries] = await this.#run(
      projectId,
      'claim',
      batchId,
      generation
    )
    if (status === 'batch_claimed' || status === 'batch_replayed') {
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        !entries.every(entry => typeof entry === 'string')
      ) {
        throw new Error('Unexpected project update queue response')
      }
      return { status, entries }
    }
    return {
      status: knownStatus(status, [
        'empty',
        'another_batch_in_flight',
        'stale_batch_generation',
      ]),
    }
  }

  /**
   * @param {string} projectId
   * @param {string} batchId
   * @param {string} generation
   * @returns {Promise<AcknowledgeResult>}
   */
  async acknowledgeBatch(projectId, batchId, generation) {
    const [status, nextGeneration] = await this.#run(
      projectId,
      'ack',
      batchId,
      generation
    )
    if (status === 'acknowledged' && isGeneration(nextGeneration)) {
      return { status, generation: nextGeneration }
    }
    return {
      status: knownStatus(status, [
        'no_batch_in_flight',
        'another_batch_in_flight',
        'stale_batch_generation',
      ]),
    }
  }

  /**
   * @param {string} projectId
   * @param {string} docId
   * @param {string} operationId
   */
  async fenceDocument(projectId, docId, operationId) {
    const [status] = await this.#run(projectId, 'fence', docId, operationId)
    return knownStatus(status, [
      'fenced',
      'already_fenced',
      'already_aborted',
      'already_committed',
      'document_fenced',
      'not_drained',
      'operation_id_reused',
      'state_mismatch',
    ])
  }

  /**
   * @param {string} projectId
   * @param {string} docId
   * @param {string} operationId
   * @param {'commit' | 'abort'} outcome Durable Web decision.
   */
  async resolveDocumentFence(projectId, docId, operationId, outcome) {
    const [status] = await this.#run(
      projectId,
      'resolve',
      docId,
      operationId,
      outcome
    )
    return knownStatus(status, [
      'committed',
      'aborted',
      'already_aborted',
      'already_committed',
      'operation_id_reused',
      'state_mismatch',
      'stale_operation',
    ])
  }
}

module.exports = ProjectUpdateQueue
