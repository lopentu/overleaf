-- Kept together so each transition is a single EVAL on one project slot.
-- KEYS: pending list, retirement hash, in-flight list, drain generation.
local pending, retirements, batch, generationKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local action, subject, argument = ARGV[1], ARGV[2], ARGV[3]
local maxBatchSize = 8

local function docField(docId)
  return 'doc:' .. docId
end

local function opField(operationId)
  return 'op:' .. operationId
end

local function generation()
  return redis.call('GET', generationKey) or '0'
end

-- An absent generation is legacy. An explicit generation, even "0", is a
-- persistent guarded-mode marker. Also protect batches and fences created by
-- earlier revisions before the generation was first acknowledged.
local function guardedDrain()
  return redis.call('EXISTS', generationKey, batch, retirements) > 0
end

local function protectLegacyDrain()
  redis.call('SETNX', generationKey, '0')
end

local function hasUpdateForDocument(doc, payload)
  local decoded, update = pcall(cjson.decode, payload)
  return decoded and type(update) == 'table' and update.doc == doc
end

local function isFenced(doc)
  return redis.call('HGET', retirements, docField(doc))
end

local function nowMillis()
  local clock = redis.call('TIME')
  return tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end

if action == 'drain-mode' then
  return {guardedDrain() and 'guarded' or 'legacy'}
end

if action == 'protect-legacy-drain' then
  protectLegacyDrain()
  return {'guarded'}
end

if action == 'legacy-pop' then
  if guardedDrain() then
    return {'guarded'}
  end
  local length = redis.call('LLEN', pending)
  local entries = redis.call('LRANGE', pending, 0, maxBatchSize - 1)
  redis.call('LTRIM', pending, maxBatchSize, -1)
  return {'popped', length, entries}
end

if action == 'stage-dispatch' or action == 'admit-dispatch' or action == 'terminal-dispatch' then
  local ticket = KEYS[5]
  local staging = action == 'stage-dispatch'
  local deadline = staging and argument or subject
  if not ticket or not deadline or not string.match(deadline, '^[1-9]%d*$') or
    tonumber(deadline) > 9007199254740991 then
    return {'invalid_arguments'}
  end
  local stored = redis.call('GET', ticket)
  if staging then
    local now = nowMillis()
    if tonumber(deadline) <= now or tonumber(deadline) > now + 120000 then
      return {'expired'}
    end
    local payload = ARGV[4]
    if not subject or subject == '' or not payload or
      not hasUpdateForDocument(subject, payload) then
      return {'invalid_update'}
    end
    local value = 'prepared:' .. deadline .. ':' .. payload
    if stored then
      return {stored == value and 'staged' or 'ticket_conflict'}
    end
    redis.call('SET', ticket, value, 'PXAT', deadline)
    return {'staged'}
  end

  local phase, storedDeadline, payload
  if stored then
    phase, storedDeadline, payload = string.match(stored, '^([a-z_]+):(%d+):(.*)$')
    if not phase or storedDeadline ~= deadline then return {'ticket_conflict'} end
  end

  if action == 'terminal-dispatch' then
    if not stored and nowMillis() < tonumber(deadline) then return {'not_terminal'} end
    if stored and phase ~= 'admitted' and phase ~= 'document_fenced' then
      return {'not_terminal'}
    end
    return {redis.call('LLEN', pending) == 0 and redis.call('LLEN', batch) == 0
      and 'terminal' or 'not_terminal'}
  end

  if not stored then return {'missing'} end
  if phase == 'admitted' or phase == 'document_fenced' then
    protectLegacyDrain()
    return {phase}
  end
  if phase ~= 'prepared' then return {'ticket_conflict'} end
  local decoded, update = pcall(cjson.decode, payload)
  if not decoded or type(update) ~= 'table' or type(update.doc) ~= 'string' or
    update.doc == '' then
    return {'ticket_conflict'}
  end
  protectLegacyDrain()
  local outcome = 'document_fenced'
  if not isFenced(update.doc) then
    redis.call('RPUSH', pending, payload)
    outcome = 'admitted'
  end
  redis.call('SET', ticket, outcome .. ':' .. deadline .. ':', 'KEEPTTL')
  return {outcome}
end

if action == 'state' then
  return {'state', generation(), redis.call('LINDEX', batch, 0)}
end

if not subject or subject == '' or not argument or argument == '' then
  return {'invalid_arguments'}
end

if action == 'enqueue' then
  if not hasUpdateForDocument(subject, argument) then
    return {'invalid_update'}
  end
  if isFenced(subject) then
    return {'document_fenced'}
  end
  protectLegacyDrain()
  return {'enqueued', redis.call('RPUSH', pending, argument)}
end

if action == 'claim' or action == 'ack' then
  -- The generation changes on acknowledgement. A claimant replaying an old
  -- request cannot remove the next batch, even after the previous list is gone.
  if argument ~= generation() then
    return {'stale_batch_generation'}
  end
  local active = redis.call('LINDEX', batch, 0)
  if active and active ~= subject then
    return {'another_batch_in_flight'}
  end
  if action == 'claim' then
    if active then
      protectLegacyDrain()
      return {'batch_replayed', redis.call('LRANGE', batch, 1, -1)}
    end
    local entries = redis.call('LRANGE', pending, 0, maxBatchSize - 1)
    if #entries == 0 then
      return {'empty'}
    end
    protectLegacyDrain()
    redis.call('RPUSH', batch, subject, unpack(entries))
    redis.call('LTRIM', pending, #entries, -1)
    return {'batch_claimed', entries}
  end
  if not active then
    return {'no_batch_in_flight'}
  end
  redis.call('INCR', generationKey)
  redis.call('DEL', batch)
  return {'acknowledged', generation()}
end

if action ~= 'fence' and action ~= 'resolve' then
  return {'invalid_action'}
end

local doc, operation = subject, argument
local docKey, operationKey = docField(doc), opField(operation)
local owner = redis.call('HGET', retirements, docKey)
local status = redis.call('HGET', retirements, operationKey)
local pendingStatus = 'pending:' .. doc
local committedStatus = 'committed:' .. doc
local abortedStatus = 'aborted:' .. doc

-- Reconcile prior effects before inspecting the queue. The queue can receive
-- sibling edits while a response is missing. A retry must recover the actual
-- transition, even after other work has arrived.
if status == abortedStatus then
  return {'already_aborted'}
end
if status == committedStatus then
  return {'already_committed'}
end
if status and status ~= pendingStatus then
  return {'operation_id_reused'}
end
if owner ~= operation and status == pendingStatus then
  return {'state_mismatch'}
end

if action == 'fence' then
  if owner == operation and status == pendingStatus then
    protectLegacyDrain()
    return {'already_fenced'}
  end
  if owner then
    return {'document_fenced'}
  end
  if redis.call('LLEN', pending) ~= 0 or redis.call('LLEN', batch) ~= 0 then
    return {'not_drained'}
  end
  protectLegacyDrain()
  redis.call('HSET', retirements, docKey, operation, operationKey, pendingStatus)
  return {'fenced'}
end

-- The caller supplies a resolution only from the durable Web decision.
-- Resolving an unknown ID must leave any current document fence intact.
if owner ~= operation or status ~= pendingStatus then
  return {'stale_operation'}
end
local outcome = ARGV[4]
if outcome == 'commit' then
  protectLegacyDrain()
  redis.call('HSET', retirements, operationKey, committedStatus)
  return {'committed'}
elseif outcome == 'abort' then
  protectLegacyDrain()
  redis.call('HSET', retirements, operationKey, abortedStatus)
  redis.call('HDEL', retirements, docKey)
  return {'aborted'}
end
return {'invalid_outcome'}
