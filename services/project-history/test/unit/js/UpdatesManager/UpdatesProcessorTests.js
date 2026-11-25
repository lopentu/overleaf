import { createHash } from 'node:crypto'
import sinon from 'sinon'
import { expect } from 'chai'
import { strict as esmock } from 'esmock'
import * as Errors from '../../../../app/js/Errors.js'
import {
  getHistoryPublication,
  parseHistoryUpdate,
} from '../../../../app/js/HistoryPublicationEnvelope.js'

const taggedHistoryId = '59bfd450e3028c4d40a1e9aa'

function makeTaggedUpdate() {
  const source = JSON.stringify({
    doc: '59bfd450e3028c4d40a1e9ab',
    v: 1,
    op: [{ p: 0, i: 'a' }],
    meta: { ts: 1700000000000, pathname: '/main.tex', doc_length: 0 },
  })
  return parseHistoryUpdate(
    JSON.stringify({
      historyPublication: {
        historyId: taggedHistoryId,
        batchId: 'c7f6da2e-4df9-4d69-9728-0853a197db8a',
        ordinal: 0,
        entryOrdinal: 0,
        digest: createHash('sha256').update(source).digest('hex'),
      },
      source,
    })
  )
}

const MODULE_PATH = '../../../../app/js/UpdatesProcessor.js'

function makeSyncState({ ongoing = false } = {}) {
  return {
    stuckClearCount: 0,
    resyncDocContents: new Set(ongoing ? ['/main.tex'] : []),
    resyncProjectStructure: false,
    resyncPendingSince: new Date(),
    isSyncOngoing: () => ongoing,
  }
}

describe('UpdatesProcessor', function () {
  beforeEach(async function () {
    this.extendLock = sinon.stub().yields()
    this.BlobManager = {
      createBlobsForUpdates: sinon.stub(),
    }
    this.HistoryStoreManager = {
      getMostRecentVersion: sinon.stub(),
      sendChanges: sinon.stub().yields(null, { resyncNeeded: true }),
      lookupActivationReceipt: sinon.stub().resolves({ status: 'pending' }),
      appendGuardedChange: sinon
        .stub()
        .resolves({ status: 'committed', historyVersion: 9 }),
      promises: {
        getMostRecentVersion: sinon.stub().resolves({ version: 8 }),
      },
    }
    this.LockManager = {
      runWithLock: sinon.spy((key, runner, callback) =>
        runner(this.extendLock, callback)
      ),
    }
    this.RedisManager = {
      clearDanglingFirstOpTimestamp: sinon.stub().yields(),
      countUnprocessedUpdates: sinon.stub(),
    }
    this.UpdateCompressor = {
      compressRawUpdatesWithMetricsCb: sinon.stub(),
    }
    this.UpdateTranslator = {
      convertToChanges: sinon.stub(),
      isProjectStructureUpdate: sinon.stub(),
      isTextUpdate: sinon.stub(),
    }
    this.WebApiManager = {
      getHistoryId: sinon.stub(),
      getFreshHistoryId: sinon.stub(),
    }
    this.SyncManager = {
      expandSyncUpdates: sinon.stub(),
      setResyncState: sinon.stub().yields(),
      skipUpdatesDuringSync: sinon.stub(),
      promises: {
        getResyncState: sinon.stub().resolves(makeSyncState()),
      },
    }
    this.ErrorRecorder = {
      getLastFailure: sinon.stub(),
      record: sinon.stub().yields(null, { attempts: 1 }),
      clearError: sinon.stub().yields(),
    }
    this.RetryManager = {
      isFirstFailure: sinon.stub().returns(true),
      isHardFailure: sinon.stub().returns(false),
    }
    this.Profiler = {
      Profiler: class {
        log() {
          return this
        }

        wrap(label, cb) {
          return cb
        }

        getTimeDelta() {
          return 0
        }

        end() {
          return 0
        }
      },
    }
    this.Metrics = {
      gauge: sinon.stub(),
      inc: sinon.stub(),
      timing: sinon.stub(),
    }
    this.Settings = {
      documentupdater: { enableRetirementQueue: false },
      redis: {
        lock: {
          key_schema: {
            projectHistoryLock({ project_id: projectId }) {
              return `ProjectHistoryLock:${projectId}`
            },
          },
        },
      },
    }
    this.UpdatesProcessor = await esmock(MODULE_PATH, {
      '../../../../app/js/BlobManager.js': this.BlobManager,
      '../../../../app/js/HistoryStoreManager.js': this.HistoryStoreManager,
      '../../../../app/js/LockManager.js': this.LockManager,
      '../../../../app/js/RedisManager.js': this.RedisManager,
      '../../../../app/js/UpdateCompressor.js': this.UpdateCompressor,
      '../../../../app/js/UpdateTranslator.js': this.UpdateTranslator,
      '../../../../app/js/WebApiManager.js': this.WebApiManager,
      '../../../../app/js/SyncManager.js': this.SyncManager,
      '../../../../app/js/ErrorRecorder.js': this.ErrorRecorder,
      '../../../../app/js/Profiler.js': this.Profiler,
      '../../../../app/js/RetryManager.js': this.RetryManager,
      '../../../../app/js/Errors.js': Errors,
      '@overleaf/metrics': this.Metrics,
      '@overleaf/settings': this.Settings,
    })
    this.doc_id = 'doc-id-123'
    this.project_id = 'project-id-123'
    this.ol_project_id = 'ol-project-id-234'
    this.callback = sinon.stub()
    this.temporary = 'temp-mock'
  })

  describe('processUpdatesForProject', function () {
    beforeEach(function () {
      this.error = new Error('error')
      this.queueSize = 445
      this.UpdatesProcessor._mocks._countAndProcessUpdates = sinon
        .stub()
        .callsArgWith(3, this.error, { queueSize: this.queueSize })
    })

    describe('when there is no existing error', function () {
      beforeEach(function (done) {
        this.ErrorRecorder.getLastFailure.yields()
        this.UpdatesProcessor.processUpdatesForProject(this.project_id, err => {
          expect(err).to.equal(this.error)
          done()
        })
      })

      it('processes updates', function () {
        this.UpdatesProcessor._mocks._countAndProcessUpdates
          .calledWith(this.project_id)
          .should.equal(true)
      })

      it('records errors', function () {
        this.ErrorRecorder.record
          .calledWith(this.project_id, this.queueSize, this.error)
          .should.equal(true)
      })

      it('does not check the resync state', function () {
        this.SyncManager.promises.getResyncState.should.not.have.been.called
      })
    })
  })

  describe('_countAndProcessUpdates', function () {
    describe('when the queue is empty', function () {
      beforeEach(function (done) {
        this.RedisManager.countUnprocessedUpdates.yields(null, 0)
        this.UpdatesProcessor._mocks._countAndProcessUpdates(
          this.project_id,
          this.extendLock,
          1,
          (error, result) => {
            this.error = error
            this.result = result
            done()
          }
        )
      })

      it('reports the flush result as an object', function () {
        expect(this.error).to.not.exist
        expect(this.result).to.deep.equal({ queueSize: 0, resyncNeeded: false })
      })
    })
  })

  describe('processUpdatesForProjectUsingBisect', function () {
    describe('when the queue is empty', function () {
      beforeEach(function (done) {
        this.RedisManager.countUnprocessedUpdates.yields(null, 0)
        this.UpdatesProcessor.processUpdatesForProjectUsingBisect(
          this.project_id,
          this.UpdatesProcessor.REDIS_READ_BATCH_SIZE,
          done
        )
      })

      it('stops instead of processing the empty queue again', function () {
        expect(this.RedisManager.countUnprocessedUpdates.callCount).to.equal(1)
      })
    })
  })

  describe('checking the resync state after a flush', function () {
    beforeEach(function () {
      // the resync state is keyed by ObjectId, so this needs a real project id
      this.project_id = '507f1f77bcf86cd799439011'
      this.queueSize = 3
      this.ErrorRecorder.getLastFailure.yields()
      this.countAndProcessUpdates = sinon
        .stub()
        .callsArgWith(3, null, { queueSize: this.queueSize })
      this.UpdatesProcessor._mocks._countAndProcessUpdates =
        this.countAndProcessUpdates
      this.flush = projectId =>
        new Promise(resolve => {
          this.UpdatesProcessor.processUpdatesForProject(projectId, resolve)
        })
    })

    describe('when no resync is pending', function () {
      beforeEach(async function () {
        this.err = await this.flush(this.project_id)
      })

      it('succeeds', function () {
        expect(this.err).to.not.exist
        expect(this.countAndProcessUpdates.callCount).to.equal(1)
      })
    })

    describe('when a resync is still pending', function () {
      beforeEach(async function () {
        this.SyncManager.promises.getResyncState.resolves(
          makeSyncState({ ongoing: true })
        )
        this.err = await this.flush(this.project_id)
      })

      it('fails the flush with a sync ongoing error', function () {
        expect(this.err).to.be.instanceof(Errors.SyncOngoingError)
        expect(this.err.info).to.include({
          projectId: this.project_id,
          stuckClearCount: 0,
        })
      })

      it('records the error with the queue size', function () {
        this.ErrorRecorder.record.should.have.been.calledWith(
          this.project_id,
          this.queueSize
        )
      })
    })

    describe('when reading the resync state fails', function () {
      beforeEach(async function () {
        this.SyncManager.promises.getResyncState.rejects(
          new Error('mongo is down')
        )
        this.err = await this.flush(this.project_id)
      })

      it('fails the flush with that error', function () {
        expect(this.err.message).to.equal('mongo is down')
      })

      it('still records the error with the queue size', function () {
        this.ErrorRecorder.record.should.have.been.calledWith(
          this.project_id,
          this.queueSize
        )
      })
    })

    describe('flushResyncUpdates', function () {
      beforeEach(function (done) {
        this.SyncManager.promises.getResyncState.resolves(
          makeSyncState({ ongoing: true })
        )
        this.UpdatesProcessor.flushResyncUpdates(this.project_id, err => {
          this.err = err
          done()
        })
      })

      it('does not check the resync state', function () {
        expect(this.err).to.not.exist
        this.SyncManager.promises.getResyncState.should.not.have.been.called
      })
    })
  })

  describe('private history publications', function () {
    beforeEach(function () {
      this.guarded = makeTaggedUpdate()
      this.publication = getHistoryPublication(this.guarded)
      this.change = { historyPublication: { ...this.publication } }
      this.UpdateTranslator.convertToChanges.returns([
        { toStorageRaw: () => this.change },
      ])
      this.processGuarded = () =>
        new Promise((resolve, reject) => {
          this.UpdatesProcessor._processUpdates(
            this.project_id,
            taggedHistoryId,
            [this.guarded],
            this.extendLock,
            (error, result) => (error ? reject(error) : resolve(result))
          )
        })
    })

    it('requires the authoritative history to match the publication', function (done) {
      this.WebApiManager.getFreshHistoryId.resolves('59bfd450e3028c4d40a1e9ac')
      this.UpdatesProcessor._getHistoryId(
        this.project_id,
        [makeTaggedUpdate()],
        error => {
          expect(error?.message).to.equal(
            'private history publication does not match project history'
          )
          done()
        }
      )
    })

    it('keeps publications away from legacy outbound and skip paths', function (done) {
      this.SyncManager.skipUpdatesDuringSync.yields(null, [], null)
      this.UpdatesProcessor._processUpdates(
        this.project_id,
        taggedHistoryId,
        [makeTaggedUpdate()],
        this.extendLock,
        error => {
          expect(error?.message).to.equal(
            'private history publication transport is unavailable'
          )
          expect(this.SyncManager.skipUpdatesDuringSync.called).to.equal(false)
          expect(this.HistoryStoreManager.sendChanges.called).to.equal(false)
          done()
        }
      )
    })

    it('appends a pending publication using the guarded API and exact receipt identity', async function () {
      this.Settings.documentupdater.enableRetirementQueue = true

      expect(await this.processGuarded()).to.deep.equal({ resyncNeeded: false })
      sinon.assert.calledOnceWithExactly(
        this.HistoryStoreManager.lookupActivationReceipt,
        this.publication
      )
      sinon.assert.calledOnceWithExactly(
        this.HistoryStoreManager.appendGuardedChange,
        this.change,
        8
      )
      sinon.assert.calledOnce(this.extendLock)
      sinon.assert.notCalled(this.HistoryStoreManager.sendChanges)
    })

    it('recovers a prior append through its durable receipt', async function () {
      this.Settings.documentupdater.enableRetirementQueue = true
      this.HistoryStoreManager.lookupActivationReceipt.resolves({
        status: 'committed',
        historyVersion: 9,
      })
      this.SyncManager.promises.getResyncState.resolves(
        makeSyncState({ ongoing: true })
      )

      expect(await this.processGuarded()).to.deep.equal({ resyncNeeded: false })
      sinon.assert.notCalled(this.HistoryStoreManager.appendGuardedChange)
      sinon.assert.notCalled(
        this.HistoryStoreManager.promises.getMostRecentVersion
      )
    })

    it('does not treat the document watermark as a committed publication', async function () {
      this.Settings.documentupdater.enableRetirementQueue = true
      this.HistoryStoreManager.promises.getMostRecentVersion.resolves({
        version: 8,
        projectStructureAndDocVersions: {
          docs: { [this.guarded.doc]: { v: 1 } },
        },
      })

      await expect(this.processGuarded()).to.be.rejectedWith(
        'without the exact receipt'
      )
      sinon.assert.notCalled(this.HistoryStoreManager.appendGuardedChange)
    })

    it('retains a publication after an indeterminate append', async function () {
      this.Settings.documentupdater.enableRetirementQueue = true
      this.HistoryStoreManager.appendGuardedChange.resolves({
        status: 'pending',
      })

      await expect(this.processGuarded()).to.be.rejectedWith(
        'unresolved (pending)'
      )
      sinon.assert.notCalled(this.HistoryStoreManager.sendChanges)
    })
  })

  describe('_getHistoryId', function () {
    describe('projectHistoryId is not present', function () {
      beforeEach(function () {
        this.updates = [
          { p: 0, i: 'a' },
          { p: 1, i: 's' },
        ]
        this.WebApiManager.getHistoryId.yields(null)
      })

      it('returns null', function (done) {
        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          (error, projectHistoryId) => {
            expect(error).to.be.null
            expect(projectHistoryId).to.be.null
            done()
          }
        )
      })
    })

    describe('projectHistoryId is not present in updates', function () {
      beforeEach(function () {
        this.updates = [
          { p: 0, i: 'a' },
          { p: 1, i: 's' },
        ]
      })

      it('returns the id from web', function (done) {
        this.projectHistoryId = '1234'
        this.WebApiManager.getHistoryId.yields(null, this.projectHistoryId)

        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          (error, projectHistoryId) => {
            expect(error).to.be.null
            expect(projectHistoryId).equal(this.projectHistoryId)
            done()
          }
        )
      })

      it('returns errors from web', function (done) {
        this.error = new Error('oh no!')
        this.WebApiManager.getHistoryId.yields(this.error)

        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          error => {
            expect(error).to.equal(this.error)
            done()
          }
        )
      })
    })

    describe('projectHistoryId is present in some updates', function () {
      beforeEach(function () {
        this.projectHistoryId = '1234'
        this.updates = [
          { p: 0, i: 'a' },
          { p: 1, i: 's', projectHistoryId: this.projectHistoryId },
          { p: 2, i: 'd', projectHistoryId: this.projectHistoryId },
        ]
      })

      it('returns an error if the id is inconsistent between updates', function (done) {
        this.updates[1].projectHistoryId = 2345
        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          error => {
            expect(error.message).to.equal(
              'inconsistent project history id between updates'
            )
            done()
          }
        )
      })

      it('returns an error if the id is inconsistent between updates and web', function (done) {
        this.WebApiManager.getHistoryId.yields(null, 2345)
        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          error => {
            expect(error.message).to.equal(
              'inconsistent project history id between updates and web'
            )
            done()
          }
        )
      })

      it('returns the id if it is consistent between updates and web', function (done) {
        this.WebApiManager.getHistoryId.yields(null, this.projectHistoryId)
        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          (error, projectHistoryId) => {
            expect(error).to.be.null
            expect(projectHistoryId).equal(this.projectHistoryId)
            done()
          }
        )
      })

      it('returns the id if it is consistent between updates but unavaiable in web', function (done) {
        this.WebApiManager.getHistoryId.yields(new Error('oh no!'))
        this.UpdatesProcessor._getHistoryId(
          this.project_id,
          this.updates,
          (error, projectHistoryId) => {
            expect(error).to.be.null
            expect(projectHistoryId).equal(this.projectHistoryId)
            done()
          }
        )
      })
    })
  })

  describe('_processUpdates', function () {
    beforeEach(function () {
      this.mostRecentVersionInfo = { version: 1 }
      this.rawUpdates = ['raw updates']
      this.expandedUpdates = ['expanded updates']
      this.filteredUpdates = ['filtered updates']
      this.compressedUpdates = ['compressed updates']
      this.updatesWithBlobs = ['updates with blob']
      this.changes = [
        {
          toRaw() {
            return 'change'
          },
        },
      ]
      this.newSyncState = { resyncProjectStructure: false }

      this.extendLock = sinon.stub().yields()
      this.mostRecentChunk = 'fake-chunk'

      this.HistoryStoreManager.getMostRecentVersion.yields(
        null,
        this.mostRecentVersionInfo,
        null,
        '_lastChange',
        this.mostRecentChunk
      )
      this.SyncManager.skipUpdatesDuringSync.yields(
        null,
        this.filteredUpdates,
        this.newSyncState
      )
      this.SyncManager.expandSyncUpdates.callsArgWith(
        5,
        null,
        this.expandedUpdates
      )
      this.UpdateCompressor.compressRawUpdatesWithMetricsCb.yields(
        null,
        this.compressedUpdates
      )
      this.BlobManager.createBlobsForUpdates.callsArgWith(
        4,
        null,
        this.updatesWithBlobs
      )
      this.UpdateTranslator.convertToChanges.returns(this.changes)
    })

    describe('happy path', function () {
      beforeEach(function (done) {
        this.UpdatesProcessor._processUpdates(
          this.project_id,
          this.ol_project_id,
          this.rawUpdates,
          this.extendLock,
          (err, flushResponse) => {
            this.callback(err, flushResponse)
            done()
          }
        )
      })

      it('should get the latest version id', function () {
        this.HistoryStoreManager.getMostRecentVersion.should.have.been.calledWith(
          this.project_id,
          this.ol_project_id
        )
      })

      it('should skip updates when resyncing', function () {
        this.SyncManager.skipUpdatesDuringSync.should.have.been.calledWith(
          this.project_id,
          this.rawUpdates
        )
      })

      it('should expand sync updates', function () {
        this.SyncManager.expandSyncUpdates.should.have.been.calledWith(
          this.project_id,
          this.ol_project_id,
          this.mostRecentChunk,
          this.filteredUpdates,
          this.extendLock
        )
      })

      it('should compress updates', function () {
        this.UpdateCompressor.compressRawUpdatesWithMetricsCb.should.have.been.calledWith(
          this.expandedUpdates
        )
      })

      it('should create any blobs for the updates', function () {
        this.BlobManager.createBlobsForUpdates.should.have.been.calledWith(
          this.project_id,
          this.ol_project_id,
          this.compressedUpdates
        )
      })

      it('should convert the updates into a change requests', function () {
        this.UpdateTranslator.convertToChanges.should.have.been.calledWith(
          this.project_id,
          this.updatesWithBlobs
        )
      })

      it('should send the change request to the history store', function () {
        this.HistoryStoreManager.sendChanges.should.have.been.calledWith(
          this.project_id,
          this.ol_project_id,
          ['change']
        )
      })

      it('should set the sync state', function () {
        this.SyncManager.setResyncState.should.have.been.calledWith(
          this.project_id,
          this.newSyncState
        )
      })

      it('should call the callback with no error and flush response', function () {
        this.callback.should.have.been.calledWith(null, { resyncNeeded: true })
      })
    })

    describe('no updates', function () {
      beforeEach(function (done) {
        this.SyncManager.skipUpdatesDuringSync.yields(
          null,
          [],
          this.newSyncState
        )
        this.UpdatesProcessor._processUpdates(
          this.project_id,
          this.ol_project_id,
          this.rawUpdates,
          this.extendLock,
          (err, flushResponse) => {
            this.callback(err, flushResponse)
            done()
          }
        )
      })

      it('should not get the latest version id', function () {
        this.HistoryStoreManager.getMostRecentVersion.should.not.have.been.calledWith(
          this.project_id,
          this.ol_project_id
        )
      })

      it('should skip updates when resyncing', function () {
        this.SyncManager.skipUpdatesDuringSync.should.have.been.calledWith(
          this.project_id,
          this.rawUpdates
        )
      })

      it('should not expand sync updates', function () {
        this.SyncManager.expandSyncUpdates.should.not.have.been.called
      })

      it('should not compress updates', function () {
        this.UpdateCompressor.compressRawUpdatesWithMetricsCb.should.not.have
          .been.called
      })

      it('should not create any blobs for the updates', function () {
        this.BlobManager.createBlobsForUpdates.should.not.have.been.called
      })

      it('should not convert the updates into a change requests', function () {
        this.UpdateTranslator.convertToChanges.should.not.have.been.called
      })

      it('should not send the change request to the history store', function () {
        this.HistoryStoreManager.sendChanges.should.not.have.been.called
      })

      it('should set the sync state', function () {
        this.SyncManager.setResyncState.should.have.been.calledWith(
          this.project_id,
          this.newSyncState
        )
      })

      it('should call the callback with fake flush response', function () {
        this.callback.should.have.been.calledWith(null, { resyncNeeded: false })
      })
    })

    describe('with an error converting changes', function () {
      beforeEach(function (done) {
        this.err = new Error()
        this.UpdateTranslator.convertToChanges.throws(this.err)
        this.callback = sinon.stub()

        this.UpdatesProcessor._processUpdates(
          this.project_id,
          this.ol_project_id,
          this.rawUpdates,
          this.extendLock,
          err => {
            this.callback(err)
            done()
          }
        )
      })

      it('should call the callback with the error', function () {
        this.callback.should.have.been.calledWith(this.err)
      })
    })
  })

  describe('_skipAlreadyAppliedUpdates', function () {
    beforeEach(function () {
      this.UpdateTranslator.isProjectStructureUpdate.callsFake(
        update => update.version != null
      )
      this.UpdateTranslator.isTextUpdate.callsFake(update => update.v != null)
    })

    describe('with all doc ops in order', function () {
      beforeEach(function () {
        this.updates = [
          { doc: 'id', v: 1 },
          { doc: 'id', v: 2 },
          { doc: 'id', v: 3 },
          { doc: 'id', v: 4 },
        ]
        this.updatesToApply = this.UpdatesProcessor._skipAlreadyAppliedUpdates(
          this.project_id,
          this.updates,
          { docs: {} }
        )
      })

      it('should return the original updates', function () {
        expect(this.updatesToApply).to.eql(this.updates)
      })
    })

    describe('with all project ops in order', function () {
      beforeEach(function () {
        this.updates = [
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
        ]
        this.updatesToApply = this.UpdatesProcessor._skipAlreadyAppliedUpdates(
          this.project_id,
          this.updates,
          { docs: {} }
        )
      })

      it('should return the original updates', function () {
        expect(this.updatesToApply).to.eql(this.updates)
      })
    })

    describe('with all multiple doc and ops in order', function () {
      beforeEach(function () {
        this.updates = [
          { doc: 'id1', v: 1 },
          { doc: 'id1', v: 2 },
          { doc: 'id1', v: 3 },
          { doc: 'id1', v: 4 },
          { doc: 'id2', v: 1 },
          { doc: 'id2', v: 2 },
          { doc: 'id2', v: 3 },
          { doc: 'id2', v: 4 },
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
        ]
        this.updatesToApply = this.UpdatesProcessor._skipAlreadyAppliedUpdates(
          this.project_id,
          this.updates,
          { docs: {} }
        )
      })

      it('should return the original updates', function () {
        expect(this.updatesToApply).to.eql(this.updates)
      })
    })

    describe('with doc ops out of order', function () {
      beforeEach(function () {
        this.updates = [
          { doc: 'id', v: 1 },
          { doc: 'id', v: 2 },
          { doc: 'id', v: 4 },
          { doc: 'id', v: 3 },
        ]
      })

      it('should throw an exception', function () {
        expect(() => {
          this.UpdatesProcessor._skipAlreadyAppliedUpdates(
            this.project_id,
            this.updates,
            { docs: {} }
          )
        }).to.throw(Errors.OpsOutOfOrderError)
      })
    })

    describe('with project ops out of order', function () {
      beforeEach(function () {
        this.UpdateTranslator.isProjectStructureUpdate.callsFake(
          update => update.version != null
        )
        this.updates = [
          { version: 1 },
          { version: 2 },
          { version: 4 },
          { version: 3 },
        ]
      })

      it('should throw an exception', function () {
        expect(() => {
          this.UpdatesProcessor._skipAlreadyAppliedUpdates(
            this.project_id,
            this.updates,
            { docs: {} }
          )
        }).to.throw(Errors.OpsOutOfOrderError)
      })
    })
  })
})
