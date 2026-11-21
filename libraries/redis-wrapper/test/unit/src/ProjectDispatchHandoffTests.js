// @ts-check

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const ProjectUpdateQueue = require('../../../ProjectUpdateQueue')
const ProjectDispatchHandoff = require('../../../ProjectDispatchHandoff')

const projectId = '507f1f77bcf86cd799439011'
const ticketId = '92788a13-507e-4311-b3fd-2fe27a554cf6'
const deadline = 1795221720000
const markerId = '1795221600000-0'
const stream = 'pending-updates-stream:{pending-updates-list-9}'
const pending = `PendingProjectUpdates:{${projectId}}`
const payload = JSON.stringify({ doc: 'doc', v: 1, op: [{ p: 0, i: 'text' }] })
const fields = [
  'project',
  projectId,
  'ticket',
  ticketId,
  'deadline',
  String(deadline),
]
const marker = { shard: 9, markerId, projectId, ticketId, deadline }

/**
 * @param {unknown[]} projectReplies
 * @param {unknown[]} streamReplies
 */
function fixture(projectReplies, streamReplies) {
  /** @type {{target: string, args: string[]}[]} */
  const calls = []
  const project = new ProjectUpdateQueue(
    {
      async eval(_script, count, ...args) {
        calls.push({ target: 'project', args: [String(count), ...args] })
        assert.ok(projectReplies.length, 'Unexpected project command')
        return projectReplies.shift()
      },
    },
    ({ project_id }) => `PendingProjectUpdates:{${project_id}}`
  )
  const handoff = new ProjectDispatchHandoff(
    {
      async call(command, ...args) {
        calls.push({ target: 'stream', args: [command, ...args] })
        assert.ok(streamReplies.length, 'Unexpected stream command')
        const reply = streamReplies.shift()
        if (reply instanceof Error) throw reply
        return reply
      },
    },
    project,
    10
  )
  return { handoff, calls }
}

describe('ProjectDispatchHandoff', function () {
  it('stages in the project slot before publishing a durable wake and admitting the edit', async function () {
    const { handoff, calls } = fixture([['staged'], ['admitted']], [markerId])
    const result = await handoff.enqueue({ ...marker, docId: 'doc', payload })
    assert.deepEqual(result, { status: 'admitted', marker })
    assert.deepEqual(
      calls.map(({ target }) => target),
      ['project', 'stream', 'project']
    )
    assert.deepEqual(calls[0].args.slice(0, 2), ['5', pending])
    assert.deepEqual(calls[0].args.slice(-5), [
      `PreparedDispatch:{${projectId}}:${ticketId}`,
      'stage-dispatch',
      'doc',
      String(deadline),
      payload,
    ])
    assert.deepEqual(calls[1].args, ['XADD', stream, '*', ...fields])
    assert.deepEqual(calls[2].args.slice(-2), [
      'admit-dispatch',
      String(deadline),
    ])
  })

  it('stops on an expired stage and never admits before a durable wake reply', async function () {
    const expired = fixture([['expired']], [])
    assert.deepEqual(
      await expired.handoff.enqueue({ ...marker, docId: 'doc', payload }),
      {
        status: 'expired',
      }
    )
    assert.equal(expired.calls.length, 1)

    const failure = new Error('synthetic wake response lost')
    const lost = fixture([['staged']], [failure])
    await assert.rejects(
      lost.handoff.enqueue({ ...marker, docId: 'doc', payload }),
      failure
    )
    assert.deepEqual(
      lost.calls.map(({ target }) => target),
      ['project', 'stream']
    )
  })

  it('uses the configured shard range and keeps legacy shard zero unnumbered', async function () {
    const { handoff, calls } = fixture(
      [],
      ['OK', new Error('BUSYGROUP Consumer Group name already exists')]
    )
    await handoff.openShard(0)
    await handoff.openShard(0)
    assert.deepEqual(calls[0].args, [
      'XGROUP',
      'CREATE',
      'pending-updates-stream:{pending-updates-list}',
      'document-updater',
      '0',
      'MKSTREAM',
    ])
    await assert.rejects(handoff.openShard(10), /dispatch shard/)
    assert.equal(calls.length, 2)
  })

  it('reclaims a pending marker without admitting or acknowledging it', async function () {
    const { handoff, calls } = fixture(
      [],
      [[[stream, [[markerId, fields]]]], ['0-0', [[markerId, fields]], []]]
    )
    assert.deepEqual(await handoff.read(9, 'worker-old'), [marker])
    assert.deepEqual(await handoff.reclaim(9, 'worker-new', 1500), {
      cursor: '0-0',
      markers: [marker],
    })
    assert.deepEqual(calls[1].args, [
      'XAUTOCLAIM',
      stream,
      'document-updater',
      'worker-new',
      '1500',
      '0-0',
      'COUNT',
      '1',
    ])
    assert.deepEqual(
      calls.map(({ target }) => target),
      ['stream', 'stream']
    )
  })

  it('reports a lost pending marker instead of treating a deleted record as complete', async function () {
    const { handoff, calls } = fixture([], [['0-0', [], [markerId]]])
    await assert.rejects(
      handoff.reclaim(9, 'worker', 1500),
      /pending dispatch marker/
    )
    assert.equal(calls.length, 1)
  })

  it('keeps the stream marker until the project queue proves terminal', async function () {
    const { handoff, calls } = fixture(
      [['not_terminal'], ['terminal']],
      ['acknowledged']
    )
    assert.equal(await handoff.acknowledgeTerminal(marker), 'not_terminal')
    assert.equal(calls.length, 1)
    assert.equal(await handoff.acknowledgeTerminal(marker), 'acknowledged')
    assert.deepEqual(calls[1].args.slice(-2), [
      'terminal-dispatch',
      String(deadline),
    ])
    assert.deepEqual(calls[2].args.slice(2), [
      '1',
      stream,
      'document-updater',
      markerId,
      ...fields,
    ])
  })

  it('rejects a malformed or mismatched marker without retiring other work', async function () {
    const { handoff } = fixture(
      [['terminal']],
      [
        [[stream, [[markerId, [...fields.slice(0, 4), 'deadline', '1e3']]]]],
        'marker_mismatch',
      ]
    )
    await assert.rejects(handoff.read(9, 'worker'), /dispatch marker/)
    await assert.rejects(handoff.acknowledgeTerminal(marker), /dispatch marker/)
  })
})
