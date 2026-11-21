const assert = require('node:assert/strict')
const { join } = require('node:path')
const SandboxedModule = require('sandboxed-module')
const { StringFileData } = require('overleaf-editor-core')
const Errors = require('../../../app/js/Errors')

const noop = () => {}
const projectId = 'synthetic-project'
const docId = 'synthetic-doc'
const batchId = 'synthetic-batch'
const settings = {
  max_doc_length: 1024,
  documentupdater: { enableRetirementWriterSeal: true },
}
const metrics = {
  inc: noop,
  histogram: noop,
  Timer: class Timer {
    done() {}
  },
}
const Profiler = class Profiler {
  log() {
    return this
  }
  end() {}
}

function load(path, requires) {
  return SandboxedModule.require(join(__dirname, '../../../app/js', path), {
    globals: { structuredClone, performance, setTimeout, clearTimeout },
    requires: {
      './Errors': Errors,
      '@overleaf/settings': settings,
      ...requires,
    },
  })
}

function fixture(type, guardEnabled = true, ordinal = 2) {
  const processing = { identity: { batchId, ordinal } }
  const historyOT = type === 'history-ot'
  const initialVersion = 27
  const state = {
    version: initialVersion,
    lines: historyOT ? new StringFileData('x').toRaw() : ['x'],
    notifications: [],
    historyQueue: [],
    previousOps: [],
    loads: 0,
    writes: 0,
    disposition: '',
    beforeReply: async () => {},
    receipt: null,
    lockHeld: false,
  }
  const update = {
    doc: docId,
    v: initialVersion,
    meta: { source: 'connection', tc: true },
    op: historyOT ? [{ textOperation: [1, 'Y'] }] : [{ i: 'Y', p: 1 }],
  }
  const RedisManager = {
    promises: {
      async getQueuedUpdateReceipt(project, doc, identity) {
        assert.equal(project, projectId)
        assert.equal(doc, docId)
        assert.equal(identity.batchId, processing.identity.batchId)
        assert.equal(identity.ordinal, processing.identity.ordinal)
        return state.receipt
      },
      async updateDocument(
        project,
        doc,
        lines,
        version,
        appliedOps,
        ranges,
        meta,
        application
      ) {
        assert.ok(application, 'guarded apply must pass the receipt context')
        assert.equal(application.identity.batchId, processing.identity.batchId)
        assert.equal(application.identity.ordinal, processing.identity.ordinal)
        if (state.disposition === 'stale') state.version++
        if (application.previousVersion !== state.version)
          return { status: 'version-mismatch' }
        state.writes++
        state.lines = structuredClone(lines)
        state.version = version
        state.previousOps.push(...structuredClone(appliedOps))
        state.receipt = {
          previousVersion: application.previousVersion,
          version,
          historyEntries: structuredClone(application.historyEntries),
        }
        await state.beforeReply()
        if (state.disposition === 'lost-reply')
          throw new Error('synthetic lost EVAL reply')
        return { status: 'applied', receipt: state.receipt }
      },
      async getPreviousDocOps(doc, begin, end) {
        return structuredClone(
          state.previousOps.slice(begin - initialVersion, end - initialVersion)
        )
      },
      recordProjectNotificationTimestamp: async () => {},
    },
  }
  const RealTimeRedisManager = {
    sendData: data => state.notifications.push(structuredClone(data)),
  }
  const DocumentManager = {
    promises: {
      async getDoc() {
        state.loads++
        return {
          version: state.version,
          lines: structuredClone(state.lines),
          ranges: {},
          pathname: '/main.tex',
          projectHistoryId: 'synthetic-history',
          historyRangesSupport: false,
          type,
        }
      },
    },
  }
  const common = {
    '@overleaf/settings': {
      ...settings,
      documentupdater: { enableRetirementWriterSeal: guardEnabled },
    },
    './RedisManager': RedisManager,
    './RealTimeRedisManager': RealTimeRedisManager,
    './DocumentManager': DocumentManager,
    './Profiler': Profiler,
    './Metrics': metrics,
    './ProjectHistoryRedisManager': {
      promises: {
        async queueOps(...entries) {
          state.historyQueue.push(...entries)
        },
      },
    },
    './HistoryManager': { recordAndFlushHistoryOps: noop },
  }
  const historyManager = load('HistoryOTUpdateManager.js', common)
  const shareManager = load('ShareJsUpdateManager.js', {
    ...common,
    './sharejs/server/model': load('sharejs/server/model.js', {
      '../../Profiler': Profiler,
    }),
    './ShareJsDB': load('ShareJsDB.js', {
      '@overleaf/metrics': metrics,
      './RedisManager': {
        getPreviousDocOps(doc, start, end, callback) {
          RedisManager.promises
            .getPreviousDocOps(doc, start, end + 1)
            .then(ops => callback(null, ops), callback)
        },
      },
    }),
  })
  const updateManager = load('UpdateManager.js', {
    ...common,
    './ShareJsUpdateManager': shareManager,
    './HistoryOTUpdateManager': historyManager,
    './ProjectLockManager': {
      promises: {
        async getLock(project) {
          assert.equal(project, projectId)
          assert.equal(state.lockHeld, false)
          state.lockHeld = true
          return 'synthetic-lock'
        },
        async extendLock(project, lock) {
          assert.equal(project, projectId)
          assert.equal(lock, 'synthetic-lock')
          assert.equal(state.lockHeld, true)
        },
        async releaseLock(project, lock) {
          assert.equal(project, projectId)
          assert.equal(lock, 'synthetic-lock')
          assert.equal(state.lockHeld, true)
          state.lockHeld = false
        },
      },
    },
    './RangesManager': {
      applyUpdate(project, doc, ranges, appliedOps) {
        return {
          newRanges: ranges,
          historyUpdates: appliedOps.map(op => ({ ...op })),
          rangesWereCollapsed: false,
          removedChangeIds: [],
        }
      },
    },
    './SnapshotManager': {},
    './WebApiManager': {},
    './TrackedChangePreview': {},
  }).promises
  const manager = historyOT ? historyManager : updateManager
  return {
    state,
    update,
    initialVersion,
    apply: () => manager.applyUpdate(projectId, docId, update, processing),
    applyQueued: (raw = JSON.stringify(update)) =>
      updateManager.applyQueuedUpdate(projectId, raw, processing.identity),
    processQueuedBatch: dependencies =>
      updateManager.processGuardedQueuedBatchWithLock(projectId, dependencies),
    content: () => (historyOT ? state.lines.content : state.lines.join('\n')),
    simulateConcurrentEdit(source = 'coauthor') {
      const previous = {
        doc: docId,
        v: initialVersion,
        meta: { source },
        op: historyOT ? [{ textOperation: [1, 'Z'] }] : [{ i: 'Z', p: 1 }],
      }
      state.lines = historyOT ? new StringFileData('xZ').toRaw() : ['xZ']
      state.previousOps.push(previous)
      state.version++
    },
  }
}

for (const type of ['sharejs-text-ot', 'history-ot']) {
  describe(`guarded ${type} application`, function () {
    it('recovers a lost write reply without loading, rewriting, or notifying twice', async function () {
      const { state, update, applyQueued, content, initialVersion } =
        fixture(type)
      const original = structuredClone(update)
      state.disposition = 'lost-reply'
      await assert.rejects(applyQueued(), /lost EVAL reply/)

      assert.equal(content(), 'xY')
      assert.equal(state.version, initialVersion + 1)
      assert.equal(state.writes, 1)
      assert.deepEqual(state.notifications, [])
      assert.deepEqual(state.historyQueue, [])

      const receipt = await applyQueued()
      assert.deepEqual(receipt, state.receipt)
      assert.equal(receipt.previousVersion, initialVersion)
      assert.equal(receipt.historyEntries.length, 1)
      assert.equal(
        JSON.parse(receipt.historyEntries[0]).meta.pathname,
        '/main.tex'
      )
      assert.equal(state.loads, 1)
      assert.equal(state.writes, 1)
      assert.deepEqual(update, original)
      assert.deepEqual(state.notifications, [])
    })

    it('reuses its OT receipt after releasing the lock while history is pending', async function () {
      const { state, update, processQueuedBatch } = fixture(type, true, 0)
      let durable = false
      let acknowledgements = 0
      const dependencies = {
        queue: {
          async getBatchState() {
            assert.equal(state.lockHeld, true)
            return { generation: '1', activeBatchId: batchId }
          },
          async claimBatch() {
            return {
              status: 'batch_replayed',
              entries: [JSON.stringify(update)],
            }
          },
          async acknowledgeBatch() {
            assert.equal(durable, true)
            acknowledgements++
            return { status: 'acknowledged', generation: '2' }
          },
        },
        async ensureHistoryDurable(project, identity, receipt) {
          assert.equal(project, projectId)
          assert.equal(state.lockHeld, true)
          assert.equal(identity.batchId, batchId)
          assert.equal(identity.ordinal, 0)
          assert.deepEqual(receipt, state.receipt)
          return durable ? 'durable' : 'pending'
        },
      }

      assert.equal(await processQueuedBatch(dependencies), 'waiting-history')
      assert.equal(state.lockHeld, false)
      assert.equal(acknowledgements, 0)
      assert.equal(state.writes, 1)

      durable = true
      assert.equal(await processQueuedBatch(dependencies), 'acknowledged')
      assert.equal(state.lockHeld, false)
      assert.equal(acknowledgements, 1)
      assert.equal(state.writes, 1)
    })

    it('rejects malformed queued wire data before loading the document', async function () {
      const { state, applyQueued } = fixture(type)
      await assert.rejects(applyQueued('{"doc":7,"op":[],"v":1}'), {
        message: 'invalid queued editor update',
      })
      assert.equal(state.loads, 0)
      assert.equal(state.writes, 0)
    })

    it('publishes success only after the guarded write and stores the actual applied base in history', async function () {
      const fixtureState = fixture(type)
      const { state, update, apply, initialVersion } = fixtureState
      fixtureState.simulateConcurrentEdit()
      const writeStarted = Promise.withResolvers()
      const allowReply = Promise.withResolvers()
      state.beforeReply = async () => {
        writeStarted.resolve()
        await allowReply.promise
      }
      const applying = apply()
      await Promise.race([writeStarted.promise, applying])
      assert.deepEqual(state.notifications, [])
      allowReply.resolve()
      const receipt = await applying
      assert.equal(receipt.previousVersion, initialVersion + 1)
      const historyEvent = JSON.parse(receipt.historyEntries[0])
      assert.equal(historyEvent.v, initialVersion + 1)
      assert.equal(state.notifications.length, 1)
      const [notice] = state.notifications
      assert.ok(notice.op)
      assert.equal(
        notice.op.v,
        type === 'history-ot' ? initialVersion : initialVersion + 1
      )
      assert.equal(update.v, initialVersion)
      if (type === 'sharejs-text-ot') {
        assert.equal(notice.op.meta.tc, true)
        assert.equal(historyEvent.meta.tc, undefined)
      }
      assert.deepEqual(await apply(), receipt)
      assert.equal(state.notifications.length, 1)
      assert.deepEqual(state.historyQueue, [])
    })

    it('does not notify or store a receipt for a document CAS conflict', async function () {
      const { state, apply, content } = fixture(type)
      state.disposition = 'stale'
      await assert.rejects(apply(), Errors.DocumentVersionMismatchError)
      assert.equal(content(), 'x')
      assert.equal(state.writes, 0)
      assert.equal(state.receipt, null)
      assert.deepEqual(state.notifications, [])
      assert.deepEqual(state.historyQueue, [])
    })

    it('records an already applied browser retry as a no-op with one acknowledgement', async function () {
      const { state, update, simulateConcurrentEdit, apply, initialVersion } =
        fixture(type)
      simulateConcurrentEdit('connection')
      update.dupIfSource = ['connection']
      const receipt = await apply()

      assert.deepEqual(receipt, {
        previousVersion: initialVersion + 1,
        version: initialVersion + 1,
        historyEntries: [],
      })
      assert.equal(state.previousOps.length, 1)
      assert.ok(state.notifications[0].op.dup)
      assert.deepEqual(await apply(), receipt)
      assert.equal(state.notifications.length, 1)
    })

    it('refuses a guarded caller before loading while the writer seal is disabled', async function () {
      const { apply, state } = fixture(type, false)
      await assert.rejects(apply(), /require the writer seal/)
      assert.equal(state.loads, 0)
      assert.equal(state.writes, 0)
      assert.deepEqual(state.notifications, [])
    })
  })
}
