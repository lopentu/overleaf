// @ts-check

import { createHash } from 'node:crypto'
import { z, zz } from '@overleaf/validation-tools'
import {
  isRetirementStructureUpdate,
  parseHistoryUpdate,
} from './HistoryPublicationEnvelope.js'

/** @typedef {import('./HistoryStoreManager.js').lookupActivationReceipt} ReceiptLookup */
/** @typedef {'buffered' | 'replayed' | 'conflict' | 'invalid-state' | 'missing' | 'unknown'} BufferResult */
/** @typedef {{ projectId: string, batchId: string, ordinal: number, entries: string[], requireExisting: boolean }} BufferRequest */
/** @typedef {{ lookup: ReceiptLookup, enqueue: (request: BufferRequest) => Promise<BufferResult> }} Dependencies */
/** @typedef {{ projectId: string, historyId: string, batchId: string, ordinal: number, historyEntries: readonly string[] }} PublicationRequest */

/** @typedef {{projectId: string, docId: string, operationId: string, version: number}} RetirementOwner */
/** @typedef {Dependencies & {
 *   getDocumentRetirement: (owner: RetirementOwner) => Promise<unknown>,
 *   getFreshHistoryId: (projectId: string) => Promise<unknown>,
 * }} RetirementDependencies */

const retirementDecision = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('committed'),
    retirement: z.object({
      projectId: zz.objectId(),
      docId: zz.objectId(),
      operationId: z.uuid(),
      version: z.number().int().nonnegative(),
      path: z.string(),
      userId: zz.objectId(),
      committedStructureVersion: z.number().int().positive(),
      deletedAt: z.iso.datetime(),
      replacement: z
        .object({
          sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
          fileId: zz.objectId(),
          hash: z.string().regex(/^[a-f0-9]{40}$/),
          name: z.string().min(1),
          created: z.iso.datetime(),
        })
        .optional(),
    }),
  }),
  z.object({
    status: z.enum(['prepared', 'aborted', 'missing', 'conflict', 'unknown']),
  }),
])

/**
 * @param {RetirementDependencies} dependencies
 * @param {RetirementOwner} owner
 * @returns {Promise<'pending'|'durable'>}
 */
export async function reconcileRetirementPublication(dependencies, owner) {
  const decision = retirementDecision.parse(
    await dependencies.getDocumentRetirement(owner)
  )
  if (decision.status !== 'committed') return 'pending'
  const { projectId, docId, operationId, version } = owner
  const committed = decision.retirement
  if (
    committed.projectId !== projectId ||
    committed.docId !== docId ||
    committed.operationId !== operationId ||
    committed.version !== version
  ) {
    throw new Error(
      'Committed retirement receipt does not match the requested document'
    )
  }
  const historyId = await dependencies.getFreshHistoryId(projectId)
  if (typeof historyId !== 'string' || !/^[a-f0-9]{24}$/.test(historyId)) {
    throw new Error('Committed retirement has no current project history')
  }

  const { path, committedStructureVersion, replacement } = committed
  const meta = {
    user_id: committed.userId,
    ts: new Date(committed.deletedAt).toISOString(),
  }
  const historyEntries = [
    JSON.stringify({
      doc: docId,
      pathname: path,
      new_pathname: '',
      version: `${committedStructureVersion}.0`,
      meta,
    }),
  ]
  if (replacement) {
    if (
      replacement.fileId === docId ||
      replacement.name !== path.split('/').at(-1)
    ) {
      throw new Error(
        'Committed retirement replacement does not match the requested document'
      )
    }
    historyEntries.push(
      JSON.stringify({
        file: replacement.fileId,
        pathname: path,
        hash: replacement.hash,
        version: `${committedStructureVersion}.1`,
        meta,
      })
    )
  }
  return await reconcileEntries(
    dependencies,
    {
      projectId,
      historyId,
      batchId: operationId,
      ordinal: 0,
      historyEntries,
    },
    true
  )
}

/**
 * Validate the editor-only entry point separately from the authoritative
 * retirement receipt path.
 *
 * @param {Dependencies} dependencies
 * @param {PublicationRequest} request
 */
export async function reconcilePublication(dependencies, request) {
  return await reconcileEntries(dependencies, request, false)
}

// A successful buffer write only makes the entry available to the worker.
/**
 * @param {Dependencies} dependencies
 * @param {PublicationRequest} request
 * @param {boolean} retirement
 * @returns {Promise<'pending' | 'durable'>}
 */
async function reconcileEntries(
  { lookup, enqueue },
  { projectId, historyId, batchId, ordinal, historyEntries },
  retirement
) {
  const envelopes = historyEntries.map((source, entryOrdinal) => {
    const publication = {
      historyId,
      batchId,
      ordinal,
      entryOrdinal,
      digest: createHash('sha256').update(source).digest('hex'),
    }
    const raw = JSON.stringify({ historyPublication: publication, source })
    try {
      const update = parseHistoryUpdate(raw)
      if (isRetirementStructureUpdate(update) !== retirement) {
        throw new Error('Unexpected history entry kind')
      }
    } catch {
      throw new TypeError('Invalid queued history entry')
    }
    return { publication, raw }
  })

  let committed = 0
  for (const envelope of envelopes) {
    const result = await lookup(envelope.publication)
    if (result.status === 'conflict') {
      throw new Error('Conflicting durable history receipt')
    }
    if (result.status === 'committed') committed++
  }
  if (committed === envelopes.length) return 'durable'

  const result = await enqueue({
    projectId,
    batchId,
    ordinal,
    entries: envelopes.map(envelope => envelope.raw),
    // Recreating the full buffer after a partial commit could replay a prefix.
    requireExisting: committed > 0,
  })
  if (result === 'missing') {
    throw new Error('Partially committed history has no buffer receipt')
  }
  if (result === 'conflict' || result === 'invalid-state') {
    throw new Error(`History publication buffer rejected the write (${result})`)
  }
  return 'pending'
}
