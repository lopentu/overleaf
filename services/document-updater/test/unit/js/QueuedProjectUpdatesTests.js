const assert = require('node:assert/strict')
const { processQueuedBatch } = require('../../../app/js/QueuedProjectUpdates')

const projectId = '507f1f77bcf86cd799439011'
const batchId = '82cc4329-668c-4e87-b093-1edf53799af7'
const first = '{"doc":"first"}'
const second = '{"doc":"second"}'
const receipt = { previousVersion: 3, version: 4, historyEntries: ['{}'] }

function fixture({ activeBatchId = batchId } = {}) {
  const events = []
  const saved = new Map()
  let durability = 'durable'
  const dependencies = {
    queue: {
      async getBatchState(project) {
        assert.equal(project, projectId)
        return { generation: '1', activeBatchId }
      },
      async claimBatch(project, id, generation) {
        assert.equal(project, projectId)
        assert.equal(generation, '1')
        if (activeBatchId) assert.equal(id, activeBatchId)
        else assert.match(id, /^[0-9a-f-]{36}$/)
        events.push(['claim', id])
        return {
          status: activeBatchId ? 'batch_replayed' : 'batch_claimed',
          entries: [first, second],
        }
      },
      async acknowledgeBatch(project, id, generation) {
        assert.equal(project, projectId)
        assert.equal(generation, '1')
        events.push(['acknowledge', id])
        return { status: 'acknowledged', generation: '2' }
      },
    },
    async apply(project, raw, identity) {
      assert.equal(project, projectId)
      events.push(['apply', raw, identity])
      const key = JSON.stringify(identity)
      if (!saved.has(key)) saved.set(key, receipt)
      return saved.get(key)
    },
    async ensureHistoryDurable(project, identity, applied) {
      assert.equal(project, projectId)
      assert.deepEqual(applied, receipt)
      events.push(['history', identity])
      return durability
    },
  }
  return {
    dependencies,
    process: (renewLock = async () => {}) =>
      processQueuedBatch(dependencies, projectId, renewLock),
    events,
    saved,
    setDurability: value => {
      durability = value
    },
  }
}

describe('QueuedProjectUpdates', function () {
  it('acknowledges a batch only after each edit has durable history', async function () {
    const { process, events } = fixture({ activeBatchId: null })
    assert.equal(await process(), 'acknowledged')
    const id = events[0][1]
    const edit0 = { batchId: id, ordinal: 0 }
    const edit1 = { batchId: id, ordinal: 1 }
    assert.deepEqual(events, [
      ['claim', id],
      ['apply', first, edit0],
      ['history', edit0],
      ['apply', second, edit1],
      ['history', edit1],
      ['acknowledge', id],
    ])
  })

  it('leaves a batch recoverable while history has only been buffered', async function () {
    const { process, events, saved, setDurability } = fixture()
    const identity = { batchId, ordinal: 0 }
    setDurability('pending')
    assert.equal(await process(), 'waiting-history')
    assert.deepEqual(events, [
      ['claim', batchId],
      ['apply', first, identity],
      ['history', identity],
    ])
    assert.equal(saved.size, 1)

    setDurability('durable')
    assert.equal(await process(), 'acknowledged')
    assert.deepEqual(events[4], ['apply', first, identity])
    assert.equal(saved.size, 2)
  })

  it('leaves applied work recoverable when its history check throws', async function () {
    const { dependencies, process, events } = fixture()
    dependencies.ensureHistoryDurable = async () => {
      throw new Error('history response was lost')
    }
    await assert.rejects(process(), {
      message: 'history response was lost',
    })
    assert.deepEqual(
      events.map(([kind]) => kind),
      ['claim', 'apply']
    )
  })

  it('will not apply updates when a stale claim loses to another worker', async function () {
    const { dependencies, process, events } = fixture()
    dependencies.queue.claimBatch = async () => ({
      status: 'stale_batch_generation',
    })
    assert.equal(await process(), 'reconcile')
    assert.deepEqual(events, [])
  })

  it('leaves recovery to the current lock holder when ownership is lost before ACK', async function () {
    const { events, process } = fixture()
    await assert.rejects(
      process(async () => {
        if (events.filter(([kind]) => kind === 'history').length === 2) {
          throw new Error('project lock expired')
        }
      }),
      { message: 'project lock expired' }
    )
    assert.deepEqual(
      events.map(([kind]) => kind),
      ['claim', 'apply', 'history', 'apply', 'history']
    )
  })
})
