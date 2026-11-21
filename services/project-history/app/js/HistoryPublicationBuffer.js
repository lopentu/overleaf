// @ts-check

import { createHash } from 'node:crypto'

/** @import { BufferRequest, BufferResult } from './HistoryPublication.js' */

/**
 * @typedef {{ eval: (script: string, numberOfKeys: number, ...values: string[]) => Promise<unknown> }} ScriptClient
 * @typedef {{
 *   projectHistoryOps: (id: {project_id: string}) => string,
 *   projectHistoryFirstOpTimestamp: (id: {project_id: string}) => string,
 * }} KeySchema
 */

const mutateQueue = String.raw`
local queue, timestamp, pending, digestKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local action = ARGV[1]

local function allowedKeyType(key, expected)
  local kind = redis.call('TYPE', key).ok
  return kind == 'none' or kind == expected
end

if not allowedKeyType(queue, 'list') or
   not allowedKeyType(timestamp, 'string') or
   not allowedKeyType(pending, 'string') then
  return 'invalid-state'
end

local storedCount = redis.call('GET', pending)
if storedCount and not string.match(storedCount, '^%d+$') then
  return 'invalid-state'
end
local count = tonumber(storedCount or '0')
if not count or count < 0 or count % 1 ~= 0 or
   count > redis.call('LLEN', queue) then
  return 'invalid-state'
end

if action == 'enqueue' then
  if not allowedKeyType(digestKey, 'string') then return 'invalid-state' end
  local priorDigest = redis.call('GET', digestKey)
  if priorDigest then
    if priorDigest == ARGV[2] then return 'replayed' end
    return 'conflict'
  end
  if ARGV[4] == '1' then return 'missing' end

  redis.call('RPUSH', queue, unpack(ARGV, 5))
  redis.call('SETNX', timestamp, ARGV[3])
  redis.call('SET', pending, count + (#ARGV - 4))
  redis.call('SET', digestKey, ARGV[2])
  return 'buffered'
end

if action == 'remove-publication' then
  -- Pop only the exact oldest entry. Repeating a completed ACK cannot
  -- consume the next publication or decrement its count.
  if redis.call('LINDEX', queue, 0) ~= ARGV[2] then return 'removed' end
  if count == 0 then return 'invalid-state' end
  redis.call('LPOP', queue)
  if count == 1 then
    redis.call('DEL', pending)
    if redis.call('LLEN', queue) == 0 then redis.call('DEL', timestamp) end
  else
    redis.call('SET', pending, count - 1)
  end
  return 'removed'
end

if action == 'remove-legacy' or action == 'remove-resync' then
  for index = 2, #ARGV do
    redis.call('LREM', queue, 1, ARGV[index])
  end
  if action == 'remove-legacy' and count == 0 and #ARGV > 1 then
    redis.call('DEL', timestamp)
  end
  return 'removed'
end

if action == 'reset' then
  if count ~= 0 then return 'blocked-by-publication' end
  redis.call('DEL', queue, timestamp, pending)
  return 'reset'
end

if action == 'clear-timestamp' or action == 'clear-dangling-timestamp' then
  if count ~= 0 then return 0 end
  if action == 'clear-dangling-timestamp' and redis.call('EXISTS', queue) == 1 then
    return 0
  end
  return redis.call('DEL', timestamp)
end

return 'invalid-action'
`

/** @param {KeySchema} keys @param {string} projectId */
function getQueueKeys(keys, projectId) {
  const project = { project_id: projectId }
  return [
    keys.projectHistoryOps(project),
    keys.projectHistoryFirstOpTimestamp(project),
    `ProjectHistory:PendingPublications:{${projectId}}`,
  ]
}

/**
 * @param {ScriptClient} redis
 * @param {KeySchema} keys
 * @param {BufferRequest} request
 * @returns {Promise<BufferResult>}
 */
export async function enqueueHistoryPublication(redis, keys, request) {
  const { projectId, batchId, ordinal, entries, requireExisting } = request
  if (!/^[a-f0-9]{24}$/.test(projectId) || entries.length === 0) {
    throw new TypeError('Expected a project and queued history entries')
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex')

  let result
  try {
    result = await redis.eval(
      mutateQueue,
      4,
      ...getQueueKeys(keys, projectId),
      `ProjectHistory:Publication:{${projectId}}:${batchId}:${ordinal}`,
      'enqueue',
      digest,
      String(Date.now()),
      requireExisting ? '1' : '0',
      ...entries
    )
  } catch {
    // The write may already have succeeded if the reply was lost.
    return 'unknown'
  }
  if (
    result === 'buffered' ||
    result === 'replayed' ||
    result === 'conflict' ||
    result === 'missing' ||
    result === 'invalid-state'
  ) {
    return result
  }
  return 'unknown'
}

/**
 * @param {ScriptClient} redis
 * @param {KeySchema} keys
 * @param {string} projectId
 * @param {string[]} entries
 * @param {'legacy' | 'publication' | 'resync'} kind
 */
export async function removeHistoryQueueEntries(
  redis,
  keys,
  projectId,
  entries,
  kind
) {
  if (kind === 'publication' && entries.length !== 1) {
    throw new Error('Expected one history publication')
  }
  const result = await redis.eval(
    mutateQueue,
    3,
    ...getQueueKeys(keys, projectId),
    `remove-${kind}`,
    ...entries
  )
  if (result !== 'removed') throw new Error('Invalid project history queue')
}

/**
 * @param {ScriptClient} redis
 * @param {KeySchema} keys
 * @param {string} projectId
 */
export async function resetHistoryQueue(redis, keys, projectId) {
  const result = await redis.eval(
    mutateQueue,
    3,
    ...getQueueKeys(keys, projectId),
    'reset'
  )
  if (result === 'blocked-by-publication') {
    throw new Error('Cannot reset history queue with pending publications')
  }
  if (result !== 'reset') throw new Error('Invalid project history queue')
}

/**
 * @param {ScriptClient} redis
 * @param {KeySchema} keys
 * @param {string} projectId
 * @param {boolean} danglingOnly
 */
export async function clearHistoryQueueTimestamp(
  redis,
  keys,
  projectId,
  danglingOnly
) {
  const result = await redis.eval(
    mutateQueue,
    3,
    ...getQueueKeys(keys, projectId),
    danglingOnly ? 'clear-dangling-timestamp' : 'clear-timestamp'
  )
  if (result !== 0 && result !== 1) {
    throw new Error('Invalid project history queue')
  }
  return result
}
