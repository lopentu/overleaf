// @ts-check

const assert = require('node:assert/strict')
const sinon = require('sinon')
const SandboxedModule = require('sandboxed-module')

const stream = 'pending-updates-stream:{pending-updates-list}'
const deadline = '1900000000000'

/** @param {string} id @param {string} project */
function marker(id, project) {
  return [
    id,
    [
      'project',
      project,
      'ticket',
      '931b4640-38f2-41e7-abdf-6db304b393c1',
      'deadline',
      deadline,
    ],
  ]
}

function createFixture() {
  const settings = {
    redis: {
      documentupdater: {
        key_schema: {
          /** @param {{project_id: string}} key */
          pendingProjectUpdates: ({ project_id: id }) =>
            `PendingProjectUpdates:{${id}}`,
        },
      },
    },
    documentupdater: {
      enableRetirementQueue: true,
      enableRetirementWriterSeal: true,
    },
    shuttingDown: false,
  }
  /** @type {Array<ReturnType<typeof marker>>} */
  const newMarkers = []
  /** @type {Array<unknown>} */
  const reclaimed = []
  const blpop = sinon.stub().callsFake((_key, _timeout, callback) => {
    settings.shuttingDown = true
    return callback(null, null)
  })
  const streamClient = {
    blpop,
    disconnect: sinon.stub(),
    call: sinon.stub().callsFake(async command => {
      switch (command) {
        case 'XGROUP':
          return 'OK'
        case 'XAUTOCLAIM':
          return reclaimed.shift() ?? ['0-0', []]
        case 'XREADGROUP': {
          const entry = newMarkers.shift()
          if (entry) return [[stream, [entry]]]
          settings.shuttingDown = true
          return null
        }
        case 'EVAL':
          return 'acknowledged'
        default:
          throw new Error('unexpected stream command')
      }
    }),
  }
  const queueClient = {
    blpop,
    disconnect: sinon.stub(),
    eval: sinon.stub().callsFake(async (...args) => {
      switch (args[7]) {
        case 'admit-dispatch':
          return ['admitted']
        case 'terminal-dispatch':
          return ['terminal']
        default:
          throw new Error('unexpected project queue command')
      }
    }),
  }
  const createClient = sinon.stub()
  createClient.onFirstCall().returns(queueClient)
  createClient.returns(streamClient)
  const processLegacy = sinon.stub().callsArg(1)
  const processGuarded = sinon.stub().resolves('acknowledged')
  const ensureHistoryDurable = sinon.stub().resolves('durable')
  const DispatchManager = SandboxedModule.require(
    '../../../../app/js/DispatchManager.js',
    {
      requires: {
        './UpdateManager': {
          processOutstandingUpdatesWithLock: processLegacy,
          promises: { processGuardedQueuedBatchWithLock: processGuarded },
        },
        '@overleaf/settings': settings,
        '@overleaf/redis-wrapper': { createClient },
      },
    }
  )

  return {
    settings,
    blpop,
    newMarkers,
    reclaimed,
    queueClient,
    streamClient,
    createClient,
    processLegacy,
    processGuarded,
    ensureHistoryDurable,
    DispatchManager,
    start: () =>
      DispatchManager.createAndStartDispatchers(1, ensureHistoryDurable),
  }
}

describe('guarded document-updater dispatch entry', function () {
  it('processes a new marker with durable history proof before acknowledging it', async function () {
    const fixture = createFixture()
    fixture.newMarkers.push(marker('42-0', 'project-a'))

    await fixture.start()

    sinon.assert.notCalled(fixture.blpop)
    sinon.assert.notCalled(fixture.processLegacy)
    sinon.assert.calledOnce(fixture.processGuarded)
    const processCall = fixture.processGuarded.firstCall
    assert.equal(processCall.args[0], 'project-a')
    assert.equal(
      processCall.args[1].ensureHistoryDurable,
      fixture.ensureHistoryDurable
    )
    const [group, reclaim, read, remove] = fixture.streamClient.call.getCalls()
    assert.deepEqual(group.args, [
      'XGROUP',
      'CREATE',
      stream,
      'document-updater',
      '0',
      'MKSTREAM',
    ])
    assert.equal(reclaim.args[0], 'XAUTOCLAIM')
    assert.equal(read.args[0], 'XREADGROUP')
    assert.equal(
      fixture.queueClient.eval.firstCall.args[2],
      'PendingProjectUpdates:{project-a}'
    )
    assert.equal(fixture.queueClient.eval.firstCall.args[7], 'admit-dispatch')
    assert.equal(
      fixture.queueClient.eval.secondCall.args[7],
      'terminal-dispatch'
    )
    assert.ok(processCall.calledBefore(fixture.queueClient.eval.secondCall))
    assert.ok(fixture.queueClient.eval.secondCall.calledBefore(remove))
    assert.deepEqual(remove.args.slice(2, 6), [
      '1',
      stream,
      'document-updater',
      '42-0',
    ])
    sinon.assert.calledOnce(fixture.streamClient.disconnect)
    sinon.assert.calledOnce(fixture.queueClient.disconnect)
  })

  it('reclaims with the Redis cursor and processes an expired admitted marker that has no receipt', async function () {
    const fixture = createFixture()
    fixture.reclaimed.push(['17-0', [marker('12-0', 'project-a')]])
    fixture.newMarkers.push(marker('42-0', 'project-b'))
    fixture.queueClient.eval.onFirstCall().resolves(['missing'])

    await fixture.start()

    assert.deepEqual(
      fixture.processGuarded.getCalls().map(call => call.args[0]),
      ['project-a', 'project-b']
    )
    const claims = fixture.streamClient.call
      .getCalls()
      .filter(call => call.args[0] === 'XAUTOCLAIM')
    assert.equal(claims[0].args[5], '0-0')
    assert.equal(claims[1].args[5], '17-0')
    assert.ok(Number(claims[0].args[4]) > 0)
    const removals = fixture.streamClient.call
      .getCalls()
      .filter(call => call.args[0] === 'EVAL')
    assert.deepEqual(
      removals.map(call => call.args[5]),
      ['12-0', '42-0']
    )
  })

  for (const status of ['waiting-history', 'reconcile']) {
    it(`leaves the marker pending when the guarded batch returns ${status}`, async function () {
      const fixture = createFixture()
      fixture.newMarkers.push(marker('42-0', 'project-a'))
      fixture.processGuarded.resolves(status)

      await fixture.start()

      sinon.assert.calledOnce(fixture.processGuarded)
      sinon.assert.calledOnce(fixture.queueClient.eval)
      assert.ok(!fixture.streamClient.call.calledWith('EVAL'))
    })
  }

  it('leaves a marker pending while another project batch is still in flight', async function () {
    const fixture = createFixture()
    fixture.newMarkers.push(marker('42-0', 'project-a'))
    fixture.queueClient.eval.onSecondCall().resolves(['not_terminal'])

    await fixture.start()

    sinon.assert.calledOnce(fixture.processGuarded)
    sinon.assert.calledTwice(fixture.queueClient.eval)
    assert.ok(!fixture.streamClient.call.calledWith('EVAL'))
  })

  it('keeps a failing project marker pending and serves an independent project', async function () {
    const fixture = createFixture()
    fixture.newMarkers.push(
      marker('42-0', 'project-a'),
      marker('43-0', 'project-b')
    )
    fixture.processGuarded
      .onFirstCall()
      .rejects(new Error('synthetic precise editor content'))

    await fixture.start()

    assert.deepEqual(
      fixture.processGuarded.getCalls().map(call => call.args[0]),
      ['project-a', 'project-b']
    )
    const removals = fixture.streamClient.call
      .getCalls()
      .filter(call => call.args[0] === 'EVAL')
    assert.deepEqual(
      removals.map(call => call.args[5]),
      ['43-0']
    )
    sinon.assert.calledOnce(this.logger.error)
    assert.equal(this.logger.error.firstCall.args[0].projectId, 'project-a')
    assert.ok(
      !JSON.stringify(this.logger.error.firstCall.args).includes(
        'synthetic precise editor content'
      )
    )
  })

  it('continues to fresh work after a malformed pending stream entry', async function () {
    const fixture = createFixture()
    fixture.reclaimed.push(['17-0', [['12-0', ['project', 'project-a']]]])
    fixture.newMarkers.push(marker('42-0', 'project-b'))

    await fixture.start()

    sinon.assert.calledOnce(fixture.processGuarded)
    assert.equal(fixture.processGuarded.firstCall.args[0], 'project-b')
    const removals = fixture.streamClient.call
      .getCalls()
      .filter(call => call.args[0] === 'EVAL')
    assert.deepEqual(
      removals.map(call => call.args[5]),
      ['42-0']
    )
    sinon.assert.calledOnce(this.logger.error)
  })

  it('fails at startup with the feature flag on and no durable proof callback', function () {
    const fixture = createFixture()

    assert.throws(
      () => fixture.DispatchManager.createAndStartDispatchers(1),
      /durable history/
    )
    sinon.assert.notCalled(fixture.createClient)
  })

  it('retains ordinary BLPOP at startup when the stream flag is off', function () {
    const fixture = createFixture()
    fixture.settings.documentupdater.enableRetirementQueue = false

    fixture.DispatchManager.createAndStartDispatchers(1)

    sinon.assert.calledOnceWithExactly(
      fixture.blpop,
      'pending-updates-list',
      0,
      sinon.match.func
    )
    sinon.assert.notCalled(fixture.streamClient.call)
    sinon.assert.notCalled(fixture.processGuarded)
  })
})
