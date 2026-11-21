import { createHash } from 'node:crypto'
import { expect } from 'chai'
import sinon from 'sinon'
import { strict as esmock } from 'esmock'
import { compressRawUpdates } from '../../../../app/js/UpdateCompressor.js'
import { convertToChanges } from '../../../../app/js/UpdateTranslator.js'

const historyId = '59bfd450e3028c4d40a1e9aa'
const docId = '59bfd450e3028c4d40a1e9ab'
const editTime = 1700000000000

function editorUpdate(op, version, docLength) {
  return {
    doc: docId,
    v: version,
    op,
    meta: {
      ts: editTime,
      pathname: '/main.tex',
      ...(docLength === undefined ? {} : { doc_length: docLength }),
    },
  }
}

function publicationEnvelope(source, ordinal = 0) {
  return {
    historyPublication: {
      historyId,
      batchId: 'c7f6da2e-4df9-4d69-9728-0853a197db8a',
      ordinal,
      entryOrdinal: 0,
      digest: createHash('sha256').update(source, 'utf8').digest('hex'),
    },
    source,
  }
}

const MODULE_PATH = '../../../../app/js/RedisManager.js'

describe('RedisManager', function () {
  beforeEach(async function () {
    this.rclient = new FakeRedis()
    this.RedisWrapper = {
      createClient: sinon.stub().returns(this.rclient),
    }
    this.Settings = {
      redis: {
        project_history: {
          key_schema: {
            projectHistoryOps({ project_id: projectId }) {
              return `Project:HistoryOps:{${projectId}}`
            },
            projectHistoryFirstOpTimestamp({ project_id: projectId }) {
              return `ProjectHistory:FirstOpTimestamp:{${projectId}}`
            },
          },
        },
      },
    }

    this.Metrics = {
      timing: sinon.stub(),
      summary: sinon.stub(),
      globalGauge: sinon.stub(),
    }
    this.RedisManager = await esmock(MODULE_PATH, {
      '@overleaf/redis-wrapper': this.RedisWrapper,
      '@overleaf/settings': this.Settings,
      '@overleaf/metrics': this.Metrics,
    })

    this.projectId = '59bfd450e3028c4d40a1e9ad'
    this.batchSize = 100
    this.historyOpsKey = `Project:HistoryOps:{${this.projectId}}`
    this.firstOpTimestampKey = `ProjectHistory:FirstOpTimestamp:{${this.projectId}}`
    this.pendingPublicationsKey = `ProjectHistory:PendingPublications:{${this.projectId}}`

    this.updates = [
      { v: 42, op: ['a', 'b', 'c', 'd'] },
      { v: 45, op: ['e', 'f', 'g', 'h'] },
    ]
    this.extraUpdates = [{ v: 100, op: ['i', 'j', 'k'] }]
    this.rawUpdates = this.updates.map(update => JSON.stringify(update))
    this.extraRawUpdates = this.extraUpdates.map(update =>
      JSON.stringify(update)
    )
  })

  describe('getRawUpdatesBatch', function () {
    it('gets a small number of updates in one batch', async function () {
      const updates = makeUpdates(2)
      const rawUpdates = makeRawUpdates(updates)
      this.rclient.setList(this.historyOpsKey, rawUpdates)
      const result = await this.RedisManager.promises.getRawUpdatesBatch(
        this.projectId,
        100
      )
      expect(result).to.deep.equal({ rawUpdates, hasMore: false })
    })

    it('gets a larger number of updates in several batches', async function () {
      const updates = makeUpdates(
        this.RedisManager.RAW_UPDATES_BATCH_SIZE * 2 + 12
      )
      const rawUpdates = makeRawUpdates(updates)
      this.rclient.setList(this.historyOpsKey, rawUpdates)
      const result = await this.RedisManager.promises.getRawUpdatesBatch(
        this.projectId,
        5000
      )
      expect(result).to.deep.equal({ rawUpdates, hasMore: false })
    })

    it("doesn't return more than the number of updates requested", async function () {
      const updates = makeUpdates(100)
      const rawUpdates = makeRawUpdates(updates)
      this.rclient.setList(this.historyOpsKey, rawUpdates)
      const result = await this.RedisManager.promises.getRawUpdatesBatch(
        this.projectId,
        75
      )
      expect(result).to.deep.equal({
        rawUpdates: rawUpdates.slice(0, 75),
        hasMore: true,
      })
    })
  })

  describe('parseDocUpdates', function () {
    it('should return the parsed ops', function () {
      const updates = makeUpdates(12)
      const rawUpdates = makeRawUpdates(updates)
      this.RedisManager.parseDocUpdates(rawUpdates).should.deep.equal(updates)
    })
  })

  describe('private history publication', function () {
    it('preserves one receipt per ShareJS and History OT entry through translation', async function () {
      const before = editorUpdate([{ p: 0, i: 'A' }], 1, 0)
      const shareJs = editorUpdate(
        [
          { p: 1, i: 'é' },
          { p: 2, i: 'C' },
        ],
        2,
        1
      )
      const after = editorUpdate([{ p: 3, i: 'D' }], 3, 3)
      const historyOT = editorUpdate([{ textOperation: [4, 'E'] }], 4)
      const shareJsEnvelope = publicationEnvelope(
        JSON.stringify(shareJs, null, 2)
      )
      const historyOTEnvelope = publicationEnvelope(
        JSON.stringify(historyOT),
        1
      )
      this.rclient.setList(this.historyOpsKey, [
        JSON.stringify(before),
        JSON.stringify(shareJsEnvelope),
        JSON.stringify(after),
        JSON.stringify(historyOTEnvelope),
      ])
      this.rclient.data.set(this.pendingPublicationsKey, '2')

      const changes = []
      const batchSizes = []
      await this.RedisManager.promises.getUpdatesInBatches(
        this.projectId,
        this.batchSize,
        async updates => {
          batchSizes.push(updates.length)
          changes.push(
            ...convertToChanges(
              this.projectId,
              compressRawUpdates(updates).map(update => ({ update }))
            )
          )
        }
      )

      expect(batchSizes).to.deep.equal([1, 1, 1, 1])
      expect(
        changes.map(change => change.getHistoryPublication())
      ).to.deep.equal([
        undefined,
        shareJsEnvelope.historyPublication,
        undefined,
        historyOTEnvelope.historyPublication,
      ])
      expect(changes.map(change => change.toRaw().operations)).to.deep.equal([
        [{ pathname: 'main.tex', textOperation: ['A'] }],
        [{ pathname: 'main.tex', textOperation: [1, 'éC'] }],
        [{ pathname: 'main.tex', textOperation: [3, 'D'] }],
        [{ pathname: 'main.tex', textOperation: [4, 'E'] }],
      ])
      expect(changes[1].toRaw()).not.to.have.property('historyPublication')
      expect(changes[1].toStorageRaw().historyPublication).to.deep.equal(
        shareJsEnvelope.historyPublication
      )
    })

    it('removes a legacy prefix but leaves a failed publication and its tail queued', async function () {
      const before = JSON.stringify(editorUpdate([{ p: 0, i: 'A' }], 1, 0))
      const publication = JSON.stringify(
        publicationEnvelope(
          JSON.stringify(editorUpdate([{ p: 1, i: 'B' }], 2, 1))
        )
      )
      const after = JSON.stringify(editorUpdate([{ p: 2, i: 'C' }], 3, 2))
      this.rclient.setList(this.historyOpsKey, [before, publication, after])
      this.rclient.data.set(this.pendingPublicationsKey, '1')
      const seen = []

      await expect(
        this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          this.batchSize,
          async updates => {
            seen.push(updates.map(update => update.v))
            if (updates.some(update => update.v === 2))
              throw new Error('pending')
          }
        )
      ).to.be.rejectedWith('pending')

      expect(seen).to.deep.equal([[1], [2]])
      expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([
        publication,
        after,
      ])
    })

    it('retains the timestamp and blocks destructive reset until the publication completes', async function () {
      const older = JSON.stringify(editorUpdate([{ p: 0, i: 'A' }], 1, 0))
      const envelope = publicationEnvelope(
        JSON.stringify(editorUpdate([{ p: 1, i: 'B' }], 2, 1))
      )
      const raw = JSON.stringify(envelope)
      this.rclient.setList(this.historyOpsKey, [older])
      const request = {
        projectId: this.projectId,
        batchId: envelope.historyPublication.batchId,
        ordinal: envelope.historyPublication.ordinal,
        entries: [raw],
        requireExisting: false,
      }

      expect(
        await this.RedisManager.bufferHistoryPublication(request)
      ).to.equal('buffered')
      expect(
        await this.RedisManager.bufferHistoryPublication(request)
      ).to.equal('replayed')
      await this.RedisManager.promises.getUpdatesInBatches(
        this.projectId,
        1,
        async () => {}
      )
      await this.RedisManager.promises.clearFirstOpTimestamp(this.projectId)
      await this.RedisManager.promises.clearDanglingFirstOpTimestamp(
        this.projectId
      )
      await expect(
        this.RedisManager.promises.destroyDocUpdatesQueue(this.projectId)
      ).to.be.rejectedWith(
        'Cannot reset history queue with pending publications'
      )
      expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([raw])
      expect(this.rclient.data.has(this.firstOpTimestampKey)).to.equal(true)

      await this.RedisManager.promises.getUpdatesInBatches(
        this.projectId,
        1,
        async () => {}
      )
      await this.RedisManager.promises.destroyDocUpdatesQueue(this.projectId)
      expect(this.rclient.data.has(this.historyOpsKey)).to.equal(false)
      expect(this.rclient.data.has(this.firstOpTimestampKey)).to.equal(false)
      expect(this.rclient.data.has(this.pendingPublicationsKey)).to.equal(false)
    })

    it('rejects changed source bytes and leaves the original queue entry intact', async function () {
      const source = JSON.stringify(editorUpdate([{ p: 0, i: 'A' }], 1, 0))
      const envelope = publicationEnvelope(source)
      const raw = JSON.stringify({ ...envelope, source: source + ' ' })
      this.rclient.setList(this.historyOpsKey, [raw])
      const processed = []

      await expect(
        this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          this.batchSize,
          async updates => {
            processed.push(...updates)
          }
        )
      ).to.be.rejectedWith('invalid private history publication')
      expect(processed).to.deep.equal([])
      expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([raw])
    })

    it('rejects a source which declares a different history', function () {
      const source = JSON.stringify({
        ...editorUpdate([{ p: 0, i: 'A' }], 1, 0),
        projectHistoryId: '59bfd450e3028c4d40a1e9ac',
      })
      const raw = JSON.stringify(publicationEnvelope(source))

      expect(() => this.RedisManager.parseDocUpdates([raw])).to.throw(
        'invalid private history publication'
      )
    })

    it('rejects nested envelopes and tagged structure events', function () {
      const source = JSON.stringify(editorUpdate([{ p: 0, i: 'A' }], 1, 0))
      for (const invalid of [
        publicationEnvelope(JSON.stringify(publicationEnvelope(source))),
        publicationEnvelope(
          JSON.stringify({ ...JSON.parse(source), new_pathname: 'renamed.tex' })
        ),
      ]) {
        expect(() =>
          this.RedisManager.parseDocUpdates([JSON.stringify(invalid)])
        ).to.throw('invalid private history publication')
      }
    })
  })

  describe('getUpdatesInBatches', function () {
    beforeEach(function () {
      this.runner = sinon.stub().resolves()
    })

    describe('single batch smaller than batch size', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(2)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          3,
          this.runner
        )
      })

      it('calls the runner once', function () {
        this.runner.callCount.should.equal(1)
      })

      it('calls the runner with the updates', function () {
        this.runner.should.have.been.calledWith(this.updates)
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })

      it('deletes the first op timestamp', function () {
        expect(this.rclient.del).to.have.been.calledWith(
          this.firstOpTimestampKey
        )
      })
    })

    describe('single batch at batch size', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(123)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner once', function () {
        this.runner.callCount.should.equal(1)
      })

      it('calls the runner with the updates', function () {
        this.runner.should.have.been.calledWith(this.updates)
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })

      it('deletes the first op timestamp', function () {
        expect(this.rclient.del).to.have.been.calledWith(
          this.firstOpTimestampKey
        )
      })
    })

    describe('single batch exceeding size limit on updates', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(2, [
          'x'.repeat(this.RedisManager.RAW_UPDATE_SIZE_THRESHOLD),
        ])
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the first update', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, 1))
      })

      it('calls the runner with the second update', function () {
        this.runner
          .getCall(1)
          .should.have.been.calledWith(this.updates.slice(1))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('two batches with first update below and second update above the size limit on updates', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(2, [
          'x'.repeat(this.RedisManager.RAW_UPDATE_SIZE_THRESHOLD / 2),
        ])
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the first update', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, 1))
      })

      it('calls the runner with the second update', function () {
        this.runner
          .getCall(1)
          .should.have.been.calledWith(this.updates.slice(1))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('single batch exceeding op count limit on updates', function () {
      beforeEach(async function () {
        const ops = Array(this.RedisManager.MAX_UPDATE_OP_LENGTH + 1).fill('op')
        this.updates = makeUpdates(2, { op: ops })
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the first update', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, 1))
      })

      it('calls the runner with the second update', function () {
        this.runner
          .getCall(1)
          .should.have.been.calledWith(this.updates.slice(1))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('single batch exceeding doc content count', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(
          this.RedisManager.MAX_NEW_DOC_CONTENT_COUNT + 3,
          { resyncDocContent: 123 }
        )
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the first batch of updates', function () {
        this.runner.should.have.been.calledWith(
          this.updates.slice(0, this.RedisManager.MAX_NEW_DOC_CONTENT_COUNT)
        )
      })

      it('calls the runner with the second batch of updates', function () {
        this.runner.should.have.been.calledWith(
          this.updates.slice(this.RedisManager.MAX_NEW_DOC_CONTENT_COUNT)
        )
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('two batches with first update below and second update above the ops length limit on updates', function () {
      beforeEach(async function () {
        // set the threshold below the size of the first update
        this.updates = makeUpdates(2, { op: ['op1', 'op2'] })
        this.updates[1].op = Array(
          this.RedisManager.MAX_UPDATE_OP_LENGTH + 2
        ).fill('op')
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          123,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the first update', function () {
        this.runner.should.have.been.calledWith(this.updates.slice(0, 1))
      })

      it('calls the runner with the second update', function () {
        this.runner.should.have.been.calledWith(this.updates.slice(1))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('two batches, one partial', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(15)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          10,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the updates', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, 10))
        this.runner
          .getCall(1)
          .should.have.been.calledWith(this.updates.slice(10))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('two full batches', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(20)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          10,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(2)
      })

      it('calls the runner with the updates', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, 10))
        this.runner
          .getCall(1)
          .should.have.been.calledWith(this.updates.slice(10))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('three full bathches, bigger than the Redis read batch size', function () {
      beforeEach(async function () {
        this.batchSize = this.RedisManager.RAW_UPDATES_BATCH_SIZE * 2
        this.updates = makeUpdates(this.batchSize * 3)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        await this.RedisManager.promises.getUpdatesInBatches(
          this.projectId,
          this.batchSize,
          this.runner
        )
      })

      it('calls the runner twice', function () {
        this.runner.callCount.should.equal(3)
      })

      it('calls the runner with the updates', function () {
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, this.batchSize))
        this.runner
          .getCall(1)
          .should.have.been.calledWith(
            this.updates.slice(this.batchSize, this.batchSize * 2)
          )
        this.runner
          .getCall(2)
          .should.have.been.calledWith(this.updates.slice(this.batchSize * 2))
      })

      it('deletes the applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal([])
      })
    })

    describe('error when first reading updates', function () {
      beforeEach(async function () {
        this.updates = makeUpdates(10)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        this.rclient.throwErrorOnLrangeCall(0)
        await expect(
          this.RedisManager.promises.getUpdatesInBatches(
            this.projectId,
            2,
            this.runner
          )
        ).to.be.rejected
      })

      it('does not delete any updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal(
          this.rawUpdates
        )
      })
    })

    describe('error when reading updates for a second batch', function () {
      beforeEach(async function () {
        this.batchSize = this.RedisManager.RAW_UPDATES_BATCH_SIZE - 1
        this.updates = makeUpdates(this.RedisManager.RAW_UPDATES_BATCH_SIZE * 2)
        this.rawUpdates = makeRawUpdates(this.updates)
        this.rclient.setList(this.historyOpsKey, this.rawUpdates)
        this.rclient.throwErrorOnLrangeCall(1)
        await expect(
          this.RedisManager.promises.getUpdatesInBatches(
            this.projectId,
            this.batchSize,
            this.runner
          )
        ).to.be.rejected
      })

      it('calls the runner with the first batch of updates', function () {
        this.runner.should.have.been.calledOnce
        this.runner
          .getCall(0)
          .should.have.been.calledWith(this.updates.slice(0, this.batchSize))
      })

      it('deletes only the first batch of applied updates', function () {
        expect(this.rclient.getList(this.historyOpsKey)).to.deep.equal(
          this.rawUpdates.slice(this.batchSize)
        )
      })
    })
  })
})

class FakeRedis {
  constructor() {
    this.data = new Map()
    this.del = sinon.spy((...keys) => {
      let removed = 0
      for (const key of keys) if (this.data.delete(key)) removed++
      return removed
    })
    this.lrangeCallCount = -1
  }

  setList(key, list) {
    this.data.set(key, list)
  }

  getList(key) {
    return this.data.get(key)
  }

  throwErrorOnLrangeCall(callNum) {
    this.lrangeCallThrowingError = callNum
  }

  async lrange(key, start, stop) {
    this.lrangeCallCount += 1
    if (
      this.lrangeCallThrowingError != null &&
      this.lrangeCallThrowingError === this.lrangeCallCount
    ) {
      throw new Error('LRANGE failed!')
    }
    const list = this.data.get(key) ?? []
    return list.slice(start, stop + 1)
  }

  async eval(_script, keyCount, ...values) {
    const [queue, timestamp, marker, digestKey] = values.slice(0, keyCount)
    const [action, ...args] = values.slice(keyCount)
    expect(
      new Set(values.slice(0, keyCount).map(key => key.match(/\{[^}]+\}/)[0]))
        .size
    ).to.equal(1)
    const count = Number(this.data.get(marker) ?? '0')

    if (action === 'enqueue') {
      const [digest, time, requireExisting, ...entries] = args
      const prior = this.data.get(digestKey)
      if (prior) return prior === digest ? 'replayed' : 'conflict'
      if (requireExisting === '1') return 'missing'
      this.setList(queue, [...(this.getList(queue) ?? []), ...entries])
      if (!this.data.has(timestamp)) this.data.set(timestamp, time)
      this.data.set(marker, String(count + entries.length))
      this.data.set(digestKey, digest)
      return 'buffered'
    }

    if (action === 'reset') {
      if (count !== 0) return 'blocked-by-publication'
      this.del(queue, timestamp, marker)
      return 'reset'
    }
    if (action === 'clear-timestamp' || action === 'clear-dangling-timestamp') {
      if (
        count !== 0 ||
        (action === 'clear-dangling-timestamp' && this.data.has(queue))
      )
        return 0
      return this.del(timestamp)
    }

    if (action === 'remove-publication') {
      if (this.getList(queue)?.[0] !== args[0]) return 'removed'
      if (count === 0) return 'invalid-state'
      const removed = await this.lrem(queue, 1, args[0])
      if (removed && count === 1) {
        this.del(marker)
        if (this.getList(queue).length === 0) this.del(timestamp)
      } else if (removed && count > 1) {
        this.data.set(marker, String(count - 1))
      }
      return 'removed'
    }

    if (action === 'remove-resync' || action === 'remove-legacy') {
      for (const raw of args) await this.lrem(queue, 1, raw)
      if (action === 'remove-legacy' && count === 0 && args.length > 0)
        this.del(timestamp)
      return 'removed'
    }
    throw new Error('Unexpected Redis mutation')
  }

  async lrem(key, count, elementToRemove) {
    expect(count).to.be.greaterThan(0)
    const original = this.data.get(key) ?? []
    const filtered = original.filter(element => {
      if (count > 0 && element === elementToRemove) {
        count--
        return false
      }
      return true
    })
    this.data.set(key, filtered)
    return original.length - filtered.length
  }
}

function makeUpdates(updateCount, extraFields = {}) {
  const updates = []
  for (let i = 0; i < updateCount; i++) {
    updates.push({ v: i, ...extraFields })
  }
  return updates
}

function makeRawUpdates(updates) {
  return updates.map(JSON.stringify)
}
