const assert = require('node:assert/strict')
const { expect } = require('chai')
const sinon = require('sinon')
const SandboxedModule = require('sandboxed-module')

const owner = {
  projectId: '59bfd450e3028c4d40a1e9aa',
  docId: '59bfd450e3028c4d40a1e9ab',
  operationId: 'c7f6da2e-4df9-4d69-9728-0853a197db8a',
  version: 42,
}

describe('sealed document flush', function () {
  beforeEach(function () {
    const defaults = require('../../../../config/settings.defaults')
    const settings = {
      ...defaults,
      documentupdater: {
        ...defaults.documentupdater,
        enableRetirementWriterSeal: true,
      },
    }
    this.keys = settings.redis.documentupdater.key_schema
    this.eval = sinon.stub()
    const RedisManager = SandboxedModule.require(
      '../../../../app/js/RedisManager',
      {
        requires: {
          '@overleaf/settings': settings,
          '@overleaf/redis-wrapper': {
            createClient: () => ({ eval: this.eval }),
          },
        },
      }
    )
    this.setDoc = sinon.stub().resolves({ rev: 7 })
    this.DocumentManager = SandboxedModule.require(
      '../../../../app/js/DocumentManager',
      {
        requires: {
          './RedisManager': RedisManager,
          './PersistenceManager': { promises: { setDoc: this.setDoc } },
          './ProjectHistoryRedisManager': {},
          './HistoryManager': {},
        },
      }
    )
  })

  it('flushes the captured revision before clearing its exact dirty state', async function () {
    const raw = ['["one","two"]', '', '90', '125', 'last-author']
    this.eval.onCall(0).resolves(['flush-snapshot', raw])
    this.eval.onCall(1).resolves('flushed')
    this.setDoc.callsFake(async (...args) => {
      assert.equal(this.eval.callCount, 1)
      expect(args).to.deep.equal([
        owner.projectId,
        owner.docId,
        ['one', 'two'],
        owner.version,
        {},
        '125',
        'last-author',
      ])
      return { rev: 7 }
    })

    expect(
      await this.DocumentManager.promises.flushSealedDocument(owner)
    ).to.deep.equal({ version: 42, rev: 7 })
    const calls = this.eval.getCalls().map(({ args }) => {
      const [, count, ...command] = args
      const keys = command.slice(0, count)
      assert.equal(count, 14)
      assert.ok(keys.every(key => key.includes(`{${owner.docId}}`)))
      return command.slice(count)
    })
    assert.deepEqual(calls[0], [
      'capture-flush',
      owner.projectId,
      owner.operationId,
      '42',
    ])
    assert.deepEqual(calls[1], [
      'complete-flush',
      owner.projectId,
      owner.operationId,
      '42',
      ...raw.flatMap(value => ['1', value]),
    ])
  })

  it('keeps the original seal owner across asynchronous persistence', async function () {
    const requestedOwner = { ...owner }
    this.eval.onCall(0).callsFake(async () => {
      requestedOwner.version++
      return ['flush-snapshot', ['["one"]', null, '90', null, null]]
    })
    this.eval.onCall(1).resolves('flushed')
    expect(
      await this.DocumentManager.promises.flushSealedDocument(requestedOwner)
    ).to.deep.equal({ version: 42, rev: 7 })
    assert.equal(this.setDoc.firstCall.args[3], 42)
  })

  it('refuses persistence when the exact seal owner does not match', async function () {
    this.eval.resolves('conflict')
    await assert.rejects(
      () => this.DocumentManager.promises.flushSealedDocument(owner),
      /conflict/
    )
    assert.equal(this.setDoc.called, false)
  })

  it('leaves the dirty state unacknowledged after a failed persistence request', async function () {
    this.eval
      .onCall(0)
      .resolves(['flush-snapshot', ['["one"]', '', '90', null, null]])
    this.setDoc.rejects(new Error('persistence request failed'))

    await assert.rejects(
      () => this.DocumentManager.promises.flushSealedDocument(owner),
      /persistence request failed/
    )
    assert.equal(this.eval.callCount, 1)
  })

  it('rejects a success response without a docstore revision before clearing dirty', async function () {
    this.eval
      .onCall(0)
      .resolves(['flush-snapshot', ['["one"]', '', '90', null, null]])
    this.setDoc.resolves({ modified: true })

    await assert.rejects(
      () => this.DocumentManager.promises.flushSealedDocument(owner),
      /persistence response/
    )
    assert.equal(this.eval.callCount, 1)
  })

  it('retries a native HistoryOT snapshot with identical persisted ranges after a lost reply', async function () {
    const rawFile = JSON.stringify({
      content: 'one two three',
      trackedChanges: [
        {
          range: { pos: 4, length: 4 },
          tracking: {
            type: 'delete',
            userId: '59bfd450e3028c4d40a1e9ac',
            ts: '2025-01-01T00:00:00.000Z',
          },
        },
      ],
    })
    this.eval
      .onCall(0)
      .resolves(['flush-snapshot', [rawFile, null, '90', null, null]])
    this.eval.onCall(1).rejects(new Error('reply lost'))
    this.eval
      .onCall(2)
      .resolves(['flush-snapshot', [rawFile, null, null, null, null]])
    this.eval.onCall(3).resolves('flushed')

    await assert.rejects(
      () => this.DocumentManager.promises.flushSealedDocument(owner),
      /reply lost/
    )
    expect(
      await this.DocumentManager.promises.flushSealedDocument(owner)
    ).to.deep.equal({ version: 42, rev: 7 })
    expect(this.setDoc.firstCall.args).to.deep.equal(
      this.setDoc.secondCall.args
    )
    const [, , lines, version, ranges] = this.setDoc.firstCall.args
    expect(lines).to.deep.equal(['one three'])
    assert.equal(version, 42)
    expect(ranges.changes[0].op).to.deep.equal({ d: 'two ', p: 4 })
    assert.match(ranges.changes[0].id, /^[a-f0-9]{24}$/)
  })

  it('reports a same-version snapshot change as a failed flush', async function () {
    this.eval
      .onCall(0)
      .resolves(['flush-snapshot', ['["one"]', '', '90', null, null]])
    this.eval.onCall(1).resolves('snapshot-mismatch')

    await assert.rejects(
      () => this.DocumentManager.promises.flushSealedDocument(owner),
      /snapshot-mismatch/
    )
    assert.equal(this.setDoc.callCount, 1)
  })
})
