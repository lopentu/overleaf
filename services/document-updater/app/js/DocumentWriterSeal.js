// @ts-check

// The exact order matches the slots declared in the Lua script.
const keyNames = /** @type {const} */ ([
  'documentWriterSeal',
  'documentLoadReservation',
  'docVersion',
  'projectKey',
  'docLines',
  'docHash',
  'ranges',
  'pathname',
  'projectHistoryId',
  'resolvedCommentIds',
  'docOps',
  'unflushedTime',
  'lastUpdatedAt',
  'lastUpdatedBy',
])

/** @typedef {{projectId: string, docId: string, operationId: string, version: number}} SealOwner */
/** @typedef {[lines: string, ranges: string | null, dirty: string | null, updatedAt: string | null, updatedBy: string | null]} RawFlushSnapshot */
/** @typedef {typeof keyNames[number]} DocumentKey */
/** @typedef {Record<DocumentKey, (args: {doc_id: string}) => string>} DocumentKeys */
/** @typedef {'begin-load' | 'check-load' | 'end-load' | 'put' | 'update' | 'seal' | 'evict' | 'release'} Command */
/** @typedef {{eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>}} RedisClient */
/** @typedef {DocumentKeys & Record<'documentApplicationReceipts', (args: {doc_id: string}) => string>} ReceiptKeys */
/** @typedef {{batchId: string, ordinal: number}} QueueApplicationIdentity */
/** @typedef {{previousVersion: number, version: number, historyEntries: string[]}} DocumentApplicationReceipt */
/** @typedef {DocumentApplicationReceipt & {
 *   lines: string, hash: string, ranges: string, timestamp: number,
 *   author: string, maxOps: number, opsTtl: number, documentOps: string[],
 * }} PreparedDocumentApplication */
/** @typedef {{status: 'applied' | 'replayed', receipt: DocumentApplicationReceipt} |
 *   {status: 'sealed' | 'version-mismatch'}} DocumentApplicationResult */

const replies = /** @type {const} */ ([
  'already-loaded',
  'conflict',
  'dirty',
  'evicted',
  'flushed',
  'invalid-arguments',
  'invalid-state',
  'load-in-progress',
  'missing',
  'no-reservation',
  'released',
  'reserved',
  'sealed',
  'snapshot-mismatch',
  'still-cached',
  'version-mismatch',
  'written',
])

/** @typedef {typeof replies[number]} Reply */

/**
 * @param {RedisClient} client
 * @param {DocumentKeys} documentKeys
 */
function createDocumentSealCommand(client, documentKeys) {
  /**
   * @param {string} docId
   * @param {Command} operation
   * @param {(string | number)[]} args
   * @returns {Promise<Reply>}
   */
  return async (docId, operation, ...args) => {
    const keys = keyNames.map(name => documentKeys[name]({ doc_id: docId }))
    const response = await client.eval(
      script,
      keys.length,
      ...keys,
      operation,
      ...args.map(String)
    )
    const reply = replies.find(reply => reply === response)
    if (!reply) throw new Error('Unexpected document writer guard reply')
    return reply
  }
}

/**
 * @param {string} projectId
 * @param {QueueApplicationIdentity} identity
 */
function receiptField(projectId, { batchId, ordinal }) {
  if (
    !projectId ||
    !batchId ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= 8
  ) {
    throw new Error('Invalid queued document application identity')
  }
  return JSON.stringify([projectId, batchId, ordinal])
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isHistoryEntries(value) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/**
 * @param {unknown} raw
 * @returns {DocumentApplicationReceipt}
 */
function readReceipt(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Invalid stored document application receipt')
  }
  /** @type {unknown} */
  let receipt
  try {
    receipt = JSON.parse(raw)
  } catch {
    throw new Error('Invalid stored document application receipt')
  }
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('previousVersion' in receipt) ||
    !isVersion(receipt.previousVersion) ||
    !('version' in receipt) ||
    !isVersion(receipt.version) ||
    receipt.version < receipt.previousVersion ||
    !('historyEntries' in receipt) ||
    !isHistoryEntries(receipt.historyEntries)
  ) {
    throw new Error('Invalid stored document application receipt')
  }
  const { previousVersion, version, historyEntries } = receipt
  return { previousVersion, version, historyEntries }
}

/**
 * @param {RedisClient} client
 * @param {ReceiptKeys} documentKeys
 */
function createDocumentReceiptCommands(client, documentKeys) {
  /**
   * @param {string} docId
   * @param {string[]} args
   */
  async function run(docId, ...args) {
    const keyParams = { doc_id: docId }
    const keys = [
      ...keyNames.map(name => documentKeys[name](keyParams)),
      documentKeys.documentApplicationReceipts(keyParams),
    ]
    return await client.eval(script, keys.length, ...keys, ...args)
  }

  return {
    /**
     * @param {string} projectId
     * @param {string} docId
     * @param {QueueApplicationIdentity} identity
     * @returns {Promise<DocumentApplicationReceipt | null>}
     */
    async getReceipt(projectId, docId, identity) {
      const reply = await run(
        docId,
        'get-receipt',
        receiptField(projectId, identity)
      )
      if (Array.isArray(reply)) {
        if (reply[0] === 'unrecorded') return null
        if (reply[0] === 'replayed') return readReceipt(reply[1])
      }
      throw new Error('Unexpected document application receipt reply')
    },

    /**
     * @param {string} projectId
     * @param {string} docId
     * @param {QueueApplicationIdentity} identity
     * @param {PreparedDocumentApplication} update
     * @returns {Promise<DocumentApplicationResult>}
     */
    async apply(projectId, docId, identity, update) {
      const { previousVersion, version, historyEntries } = update
      if (
        !isVersion(previousVersion) ||
        !isVersion(version) ||
        version - previousVersion !== update.documentOps.length ||
        !isHistoryEntries(historyEntries)
      ) {
        throw new Error('Invalid prepared document application')
      }
      const reply = await run(
        docId,
        'apply-queued',
        projectId,
        String(previousVersion),
        String(version),
        update.lines,
        update.hash,
        update.ranges,
        String(update.timestamp),
        update.author,
        String(update.maxOps),
        String(update.opsTtl),
        receiptField(projectId, identity),
        JSON.stringify({ previousVersion, version, historyEntries }),
        ...update.documentOps
      )
      if (Array.isArray(reply)) {
        const [status, receipt] = reply
        if (status === 'applied' || status === 'replayed') {
          return { status, receipt: readReceipt(receipt) }
        }
      } else if (reply === 'sealed' || reply === 'version-mismatch') {
        return { status: reply }
      }
      throw new Error('Unexpected document application receipt reply')
    },
  }
}

/**
 * @param {RedisClient} client
 * @param {DocumentKeys} documentKeys
 */
function createDocumentFlushCommands(client, documentKeys) {
  /** @param {SealOwner} owner @param {string} operation @param {string[]} args */
  async function run(owner, operation, ...args) {
    const keys = keyNames.map(name =>
      documentKeys[name]({ doc_id: owner.docId })
    )
    return await client.eval(
      script,
      keys.length,
      ...keys,
      operation,
      owner.projectId,
      owner.operationId,
      String(owner.version),
      ...args
    )
  }

  /** @param {unknown} response */
  function rejected(response) {
    const reply = replies.find(reply => reply === response)
    return new Error(
      reply
        ? `Document writer guard refused sealed flush: ${reply}`
        : 'Unexpected sealed document flush reply'
    )
  }

  return {
    /** @param {SealOwner} owner @returns {Promise<RawFlushSnapshot>} */
    async capture(owner) {
      const response = await run(owner, 'capture-flush')
      if (Array.isArray(response) && response[0] === 'flush-snapshot') {
        const snapshot = response[1]
        if (
          Array.isArray(snapshot) &&
          snapshot.length === 5 &&
          typeof snapshot[0] === 'string' &&
          snapshot.every(value => value === null || typeof value === 'string')
        ) {
          return /** @type {RawFlushSnapshot} */ (snapshot)
        }
      }
      throw rejected(response)
    },

    /** @param {SealOwner} owner @param {RawFlushSnapshot} snapshot */
    async complete(owner, snapshot) {
      // The presence flag distinguishes an absent cache key from an empty
      // string. The exact raw snapshot also covers same-version range writes.
      const args = snapshot.flatMap(value =>
        value === null ? ['0', ''] : ['1', value]
      )
      const response = await run(owner, 'complete-flush', ...args)
      if (response !== 'flushed') throw rejected(response)
    },
  }
}

const script = String.raw`
-- Candidate only. All KEYS are on the existing DocumentUpdater {docId} slot.
local sealKey, loader, version, project, lines, digest, ranges, path, history,
  resolved, ops, dirty, updatedAt, updatedBy = unpack(KEYS)
local command = ARGV[1]
local queued = command == 'apply-queued'
local withReceipts = queued or command == 'get-receipt'
local receipts = KEYS[15]

local function integer(value)
  return value and string.match(value, '^%d+$') and
    tonumber(value) <= 9007199254740991
end

local function sharedType(key, expected)
  local actual = redis.call('TYPE', key).ok
  return actual == 'none' or actual == expected
end

if #KEYS ~= (withReceipts and 15 or 14) then return 'invalid-arguments' end

if command == 'get-receipt' then
  if #ARGV ~= 2 or ARGV[2] == '' then return 'invalid-arguments' end
  if not sharedType(receipts, 'hash') then return 'invalid-state' end
  local receipt = redis.call('HGET', receipts, ARGV[2])
  if receipt then return {'replayed', receipt} end
  return {'unrecorded'}
end

if command == 'begin-load' or command == 'check-load' or command == 'end-load' then
  if #ARGV ~= 2 or ARGV[2] == '' then return 'invalid-arguments' end
  if not sharedType(loader, 'string') then return 'invalid-state' end
  local reservedBy = redis.call('GET', loader)
  if command == 'end-load' then
    if reservedBy ~= ARGV[2] then return 'missing' end
    redis.call('DEL', loader)
    return 'released'
  end
  if redis.call('EXISTS', sealKey) == 1 then return 'sealed' end
  if command == 'check-load' then
    return reservedBy == ARGV[2] and 'reserved' or 'no-reservation'
  end
  if reservedBy then
    if reservedBy == ARGV[2] then return 'reserved' end
    return 'load-in-progress'
  end
  if redis.call('EXISTS', version, lines) ~= 0 then return 'already-loaded' end
  redis.call('SET', loader, ARGV[2])
  return 'reserved'
end

if command == 'put' then
  -- Reserve before the persistence GET and hold through cross-slot bookkeeping.
  if #ARGV < 10 or not integer(ARGV[4]) or
    (ARGV[10] ~= '0' and ARGV[10] ~= '1') then
    return 'invalid-arguments'
  end
  if redis.call('EXISTS', sealKey) == 1 then return 'sealed' end
  if not sharedType(loader, 'string') then return 'invalid-state' end
  if redis.call('GET', loader) ~= ARGV[2] then return 'no-reservation' end
  if redis.call('EXISTS', version, lines) ~= 0 then return 'already-loaded' end
  redis.call('MSET', version, ARGV[4], project, ARGV[3], lines, ARGV[5],
    digest, ARGV[6], ranges, ARGV[7], path, ARGV[8], history, ARGV[9])
  if ARGV[10] == '1' then
    redis.call('DEL', resolved)
    for index = 11, #ARGV do redis.call('SADD', resolved, ARGV[index]) end
  end
  return 'written'
end

if command == 'update' or queued then
  local opOffset = queued and 13 or 11
  if queued then
    if #ARGV < opOffset or ARGV[12] == '' or ARGV[13] == '' then
      return 'invalid-arguments'
    end
    if not sharedType(receipts, 'hash') then return 'invalid-state' end
    local receipt = redis.call('HGET', receipts, ARGV[12])
    if receipt then return {'replayed', receipt} end
  end
  -- Keep the old-version comparison in the same script as every cache write.
  if #ARGV < opOffset or not integer(ARGV[3]) or not integer(ARGV[4]) or
    not integer(ARGV[10]) or tonumber(ARGV[10]) < 1 or
    not integer(ARGV[11]) or tonumber(ARGV[11]) < 1 or
    tonumber(ARGV[4]) ~= tonumber(ARGV[3]) + (#ARGV - opOffset) then
    return 'invalid-arguments'
  end
  if redis.call('EXISTS', sealKey) == 1 then return 'sealed' end
  if not sharedType(version, 'string') or not sharedType(project, 'string') or
    not sharedType(ops, 'list') then return 'invalid-state' end
  if redis.call('GET', version) ~= ARGV[3] or
    redis.call('GET', project) ~= ARGV[2] or redis.call('EXISTS', lines) ~= 1 then
    return 'version-mismatch'
  end
  -- Queued browser duplicates may have no document operations. Record their
  -- receipt without changing the snapshot or write timestamps.
  if not queued or #ARGV > opOffset then
    redis.call('MSET', version, ARGV[4], lines, ARGV[5], digest, ARGV[6],
      ranges, ARGV[7], updatedAt, ARGV[8], updatedBy, ARGV[9])
    redis.call('LTRIM', ops, -tonumber(ARGV[10]), -1)
    for index = opOffset + 1, #ARGV do redis.call('RPUSH', ops, ARGV[index]) end
    if #ARGV > opOffset then redis.call('EXPIRE', ops, ARGV[11]) end
    redis.call('SET', dirty, ARGV[8], 'NX')
  end
  if queued then
    redis.call('HSET', receipts, ARGV[12], ARGV[13])
    return {'applied', ARGV[13]}
  end
  return 'written'
end

local isFlush = command == 'capture-flush' or command == 'complete-flush'
if command == 'seal' or command == 'evict' or command == 'release' or isFlush then
  local expectedArguments = command == 'complete-flush' and 14 or 4
  if #ARGV ~= expectedArguments or ARGV[2] == '' or ARGV[3] == '' or not integer(ARGV[4]) then
    return 'invalid-arguments'
  end
  if not sharedType(sealKey, 'string') or not sharedType(loader, 'string') or
    not sharedType(version, 'string') or not sharedType(project, 'string') then
    return 'invalid-state'
  end
  local owner = cjson.encode({ ARGV[2], ARGV[3], ARGV[4] })
  local sealedBy = redis.call('GET', sealKey)
  if sealedBy and sealedBy ~= owner then return 'conflict' end

  if command == 'seal' then
    if sealedBy then return 'sealed' end
    if redis.call('EXISTS', loader) ~= 0 then return 'load-in-progress' end
    if redis.call('GET', version) ~= ARGV[4] or
      redis.call('GET', project) ~= ARGV[2] or redis.call('EXISTS', lines) ~= 1 then
      return 'version-mismatch'
    end
    redis.call('SET', sealKey, owner)
    return 'sealed'
  end
  if not sealedBy then return 'missing' end

  if isFlush then
    local fields = { lines, ranges, dirty, updatedAt, updatedBy }
    for _, key in ipairs(fields) do
      if not sharedType(key, 'string') then return 'invalid-state' end
    end
    local snapshot = redis.call('MGET', unpack(fields))
    if not snapshot[1] or redis.call('GET', version) ~= ARGV[4] or
      redis.call('GET', project) ~= ARGV[2] then
      return 'version-mismatch'
    end
    if command == 'capture-flush' then return {'flush-snapshot', snapshot} end

    for index = 1, #fields do
      local present, expected = ARGV[2 * index + 3], ARGV[2 * index + 4]
      if present == '0' then
        expected = false
      elseif present ~= '1' then
        return 'invalid-arguments'
      end
      if snapshot[index] ~= expected then return 'snapshot-mismatch' end
    end
    redis.call('DEL', dirty)
    return 'flushed'
  end

  if command == 'evict' then
    if redis.call('EXISTS', version, lines, project) == 0 then return 'evicted' end
    if redis.call('GET', version) ~= ARGV[4] or redis.call('GET', project) ~= ARGV[2] then
      return 'version-mismatch'
    end
    if redis.call('EXISTS', dirty) ~= 0 then return 'dirty' end
    -- Preserve the existing separately expiring op history.
    redis.call('DEL', version, project, lines, digest, ranges, path, history,
      resolved, dirty, updatedAt, updatedBy)
    return 'evicted'
  end

  -- Caller must also confirm durable Web tree removal before successful release.
  if redis.call('EXISTS', version, lines, project) ~= 0 then return 'still-cached' end
  redis.call('DEL', sealKey)
  return 'released'
end

return 'invalid-arguments'
`

module.exports = {
  createDocumentSealCommand,
  createDocumentReceiptCommands,
  createDocumentFlushCommands,
}
