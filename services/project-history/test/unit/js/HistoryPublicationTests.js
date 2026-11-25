import { createHash } from 'node:crypto'
import { expect } from 'chai'
import sinon from 'sinon'
import { reconcilePublication } from '../../../app/js/HistoryPublication.js'

describe('reconcilePublication', function () {
  beforeEach(function () {
    this.lookup = sinon.stub().resolves({ status: 'pending' })
    this.enqueue = sinon.stub().resolves('buffered')
    this.dependencies = { lookup: this.lookup, enqueue: this.enqueue }
    this.request = {
      projectId: '123456789012345678901234',
      historyId: '234567890123456789012345',
      batchId: '12345678-1234-1234-1234-123456789012',
      ordinal: 2,
      historyEntries: [
        '{ "doc":"doc-a", "v":3, "op":[{"p":0,"i":"ä"}], "meta":{"pathname":"a.tex","ts":2,"doc_length":0} }',
        '{"doc":"doc-b","v":4,"op":[{"p":0,"i":"b"}],"meta":{"pathname":"b.tex","ts":3,"doc_length":0}}',
      ],
    }
    this.reconcile = () => reconcilePublication(this.dependencies, this.request)
  })

  it('returns pending after buffering exact source bytes for each entry', async function () {
    expect(await this.reconcile()).to.equal('pending')
    const { projectId, batchId, ordinal, historyEntries, historyId } =
      this.request
    const expected = historyEntries.map((source, entryOrdinal) => ({
      historyPublication: {
        historyId,
        batchId,
        ordinal,
        entryOrdinal,
        digest: createHash('sha256').update(source).digest('hex'),
      },
      source,
    }))

    expect(this.lookup.args).to.deep.equal(
      expected.map(({ historyPublication }) => [historyPublication])
    )
    sinon.assert.calledOnceWithExactly(this.enqueue, {
      projectId,
      batchId,
      ordinal,
      entries: expected.map(envelope => JSON.stringify(envelope)),
      requireExisting: false,
    })
  })

  it('does no history work if the document receipt has no history entries', async function () {
    this.request.historyEntries = []

    expect(await this.reconcile()).to.equal('durable')
    sinon.assert.notCalled(this.lookup)
    sinon.assert.notCalled(this.enqueue)
  })

  it('certifies durable only when every exact lookup is committed', async function () {
    this.lookup.resolves({ status: 'committed', historyVersion: 8 })

    expect(await this.reconcile()).to.equal('durable')
    sinon.assert.calledTwice(this.lookup)
    sinon.assert.notCalled(this.enqueue)
  })

  it('requires the original buffer receipt when only part of the work committed', async function () {
    this.lookup
      .onFirstCall()
      .resolves({ status: 'committed', historyVersion: 8 })
    this.enqueue.resolves('missing')

    await expect(this.reconcile()).to.be.rejectedWith('Partially committed')
    sinon.assert.calledWith(
      this.enqueue,
      sinon.match({ requireExisting: true })
    )
  })

  it('rejects a conflicting receipt before enqueueing', async function () {
    this.lookup.onSecondCall().resolves({ status: 'conflict' })

    await expect(this.reconcile()).to.be.rejectedWith('Conflicting')
    sinon.assert.notCalled(this.enqueue)
  })

  it('validates the stored entry before reading any history receipts', async function () {
    this.request.historyEntries[1] =
      '{"historyPublication": {}, "source": "wrong"}'

    await expect(this.reconcile()).to.be.rejectedWith(
      'Invalid queued history entry'
    )
    sinon.assert.notCalled(this.lookup)
    sinon.assert.notCalled(this.enqueue)
  })

  it('stays pending if the buffer write reply was lost', async function () {
    this.enqueue.resolves('unknown')

    expect(await this.reconcile()).to.equal('pending')
  })
})
