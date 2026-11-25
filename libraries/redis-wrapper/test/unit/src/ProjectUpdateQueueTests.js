const assert = require('node:assert/strict')
const ProjectUpdateQueue = require('../../../ProjectUpdateQueue')

const projectId = 'synthetic-project'
const pendingProjectUpdates = ({ project_id: id }) =>
  `PendingProjectUpdates:{${id}}`

function fixture(replies, keyBuilder = pendingProjectUpdates) {
  const calls = []
  const queue = new ProjectUpdateQueue(
    {
      async eval(script, keyCount, ...args) {
        calls.push({ keyCount, args })
        assert.ok(replies.length > 0, 'unexpected EVAL')
        return replies.shift()
      },
    },
    keyBuilder
  )
  return { queue, calls }
}

describe('ProjectUpdateQueue', function () {
  it('uses the existing pending queue and one project hash tag for every action', async function () {
    const { queue, calls } = fixture([
      ['state', '8', null],
      ['fenced'],
      ['document_fenced'],
      ['enqueued', 1],
      ['batch_claimed', ['sibling op']],
      ['batch_replayed', ['sibling op']],
      ['acknowledged', '9'],
      ['committed'],
    ])
    assert.deepEqual(await queue.getBatchState(projectId), {
      generation: '8',
      activeBatchId: null,
    })
    assert.equal(
      await queue.fenceDocument(projectId, 'retired', 'op-id'),
      'fenced'
    )
    assert.deepEqual(await queue.enqueue(projectId, 'retired', 'target op'), {
      status: 'document_fenced',
    })
    assert.deepEqual(await queue.enqueue(projectId, 'sibling', 'sibling op'), {
      status: 'enqueued',
      length: 1,
    })
    assert.deepEqual(await queue.claimBatch(projectId, 'batch', '8'), {
      status: 'batch_claimed',
      entries: ['sibling op'],
    })
    assert.deepEqual(await queue.claimBatch(projectId, 'batch', '8'), {
      status: 'batch_replayed',
      entries: ['sibling op'],
    })
    assert.deepEqual(await queue.acknowledgeBatch(projectId, 'batch', '8'), {
      status: 'acknowledged',
      generation: '9',
    })
    assert.equal(
      await queue.resolveDocumentFence(projectId, 'retired', 'op-id', 'commit'),
      'committed'
    )

    const tag = `{${projectId}}`
    const keys = [
      `PendingProjectUpdates:${tag}`,
      `EditableRetirements:${tag}`,
      `PendingProjectUpdatesInFlight:${tag}`,
      `PendingProjectUpdatesGeneration:${tag}`,
    ]
    assert.ok(
      calls.every(
        ({ keyCount, args }) =>
          keyCount === keys.length &&
          args.slice(0, keyCount).every((key, index) => key === keys[index])
      )
    )
    assert.deepEqual(
      calls.map(({ args }) => args.slice(keys.length)),
      [
        ['state'],
        ['fence', 'retired', 'op-id'],
        ['enqueue', 'retired', 'target op'],
        ['enqueue', 'sibling', 'sibling op'],
        ['claim', 'batch', '8'],
        ['claim', 'batch', '8'],
        ['ack', 'batch', '8'],
        ['resolve', 'retired', 'op-id', 'commit'],
      ]
    )
  })

  it('reads and arms protection and keeps the legacy pop atomic', async function () {
    const { queue, calls } = fixture([
      ['legacy'],
      ['popped', 2, ['first', 'second']],
      ['guarded'],
      ['guarded'],
    ])
    assert.equal(await queue.getDrainMode(projectId), 'legacy')
    assert.deepEqual(await queue.popLegacyBatch(projectId), {
      status: 'popped',
      length: 2,
      entries: ['first', 'second'],
    })
    assert.equal(await queue.protectLegacyDrain(projectId), 'guarded')
    assert.deepEqual(await queue.popLegacyBatch(projectId), {
      status: 'guarded',
    })
    assert.deepEqual(
      calls.map(({ keyCount, args }) => args.slice(keyCount)),
      [['drain-mode'], ['legacy-pop'], ['protect-legacy-drain'], ['legacy-pop']]
    )
  })

  it('rejects unsupported Redis slots before executing a command', async function () {
    const { queue, calls } = fixture(
      [],
      () => 'PendingProjectUpdates:{different}'
    )
    await assert.rejects(queue.getBatchState(projectId), /project hash tag/)
    assert.equal(calls.length, 0)
  })

  it('fails closed when Redis replies with invalid results', async function () {
    const { queue } = fixture([
      ['batch_claimed', ['valid', 5]],
      ['acknowledged', 9],
      ['enqueued', -1],
      ['popped', 1, [9]],
    ])
    await assert.rejects(
      queue.claimBatch(projectId, 'batch', '8'),
      /queue response/
    )
    await assert.rejects(
      queue.acknowledgeBatch(projectId, 'batch', '8'),
      /queue response/
    )
    await assert.rejects(
      queue.enqueue(projectId, 'doc', 'op'),
      /queue response/
    )
    await assert.rejects(queue.popLegacyBatch(projectId), /queue response/)
  })
})
