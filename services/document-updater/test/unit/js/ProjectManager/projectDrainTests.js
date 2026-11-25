const { expect } = require('chai')
const sinon = require('sinon')
const SandboxedModule = require('sandboxed-module')

describe('ProjectManager project drain', function () {
  const projectId = 'project-id'
  const docId = 'doc-id'
  const projectLock = 'project-lock'

  beforeEach(function () {
    this.locked = false
    this.docs = []
    this.settings = { documentupdater: {} }
    this.getDocIds = sinon.stub().callsFake(async () => this.docs.slice())
    this.flushDoc = sinon.stub().callsFake(async () => {
      expect(this.locked).to.equal(false)
    })
    this.deleteDoc = sinon.stub().callsFake(async () => {
      expect(this.locked).to.equal(false)
    })
    this.flushHistory = sinon.stub().callsFake(async () => {
      expect(this.locked).to.equal(false)
    })
    this.ProjectManager = SandboxedModule.require(
      '../../../../app/js/ProjectManager.js',
      {
        requires: {
          '@overleaf/settings': this.settings,
          './RedisManager': {
            promises: { getDocIdsInProject: this.getDocIds },
          },
          './ProjectHistoryRedisManager': {},
          './DocumentManager': {
            promises: {
              flushDocIfLoadedWithLock: this.flushDoc,
              flushAndDeleteDocWithLock: this.deleteDoc,
            },
          },
          './HistoryManager': {
            promises: { flushProjectChanges: this.flushHistory },
          },
          './RealTimeRedisManager': {
            guardedProjectQueue: { getDrainMode: id => this.getDrainMode(id) },
          },
          './UpdateManager': {
            promises: {
              withGuardedProjectLock: (...args) =>
                this.withProjectLock(...args),
              processGuardedQueuedBatchUnderLock: (...args) =>
                this.drainWithLock(...args),
            },
          },
          './Metrics': {
            Timer: class {
              done() {}
            },
          },
        },
      }
    )
    this.getDrainMode = sinon.stub().resolves('guarded')
    this.drainWithLock = sinon.stub().resolves('empty')
    this.withProjectLock = sinon.spy(async (id, operation) => {
      expect(id).to.equal(projectId)
      expect(this.locked).to.equal(false)
      this.locked = true
      try {
        return await operation(projectLock)
      } finally {
        this.locked = false
      }
    })
    this.dependencies = {
      queue: { getDrainMode: this.getDrainMode },
      drainWithLock: this.drainWithLock,
      withProjectLock: this.withProjectLock,
    }
  })

  it('uses the runtime protected queue for an ordinary project flush entry', async function () {
    this.settings.documentupdater.enableRetirementQueue = true
    this.settings.documentupdater.enableRetirementWriterSeal = true
    this.drainWithLock.resolves('waiting-history')

    await expect(
      this.ProjectManager.promises.flushProjectWithLocks(projectId)
    ).to.be.rejectedWith('project updates have not drained')
    sinon.assert.calledOnce(this.withProjectLock)
    sinon.assert.notCalled(this.getDocIds)
    sinon.assert.notCalled(this.flushDoc)
  })

  it('drains cold-document updates before enumerating loaded documents for a guarded flush', async function () {
    this.drainWithLock.onFirstCall().callsFake(async (id, lock) => {
      expect([id, lock]).to.deep.equal([projectId, projectLock])
      expect(this.locked).to.equal(true)
      expect(this.getDocIds.called).to.equal(false)
      this.docs.push(docId)
      return 'acknowledged'
    })
    this.getDocIds.callsFake(async () => {
      expect(this.locked).to.equal(true)
      return this.docs.slice()
    })
    await this.ProjectManager.promises.flushProjectWithLocks(
      projectId,
      this.dependencies
    )
    expect(this.withProjectLock.callCount).to.equal(2)
    expect(this.drainWithLock.callCount).to.equal(2)
    expect(this.flushDoc.calledOnceWithExactly(projectId, docId)).to.equal(true)
  })

  it('rejects a guarded delete with pending history before accessing docs or the legacy history endpoint', async function () {
    const options = { skip_history_flush: false }
    this.drainWithLock.resolves('waiting-history')
    await expect(
      this.ProjectManager.promises.flushAndDeleteProjectWithLocks(
        projectId,
        options,
        this.dependencies
      )
    ).to.be.rejectedWith('project updates have not drained')
    expect(this.getDocIds.called).to.equal(false)
    expect(this.deleteDoc.called).to.equal(false)
    expect(this.flushHistory.called).to.equal(false)
  })

  it('flushes legacy history for a drained empty guarded cache after unlocking', function (done) {
    const options = { skip_history_flush: false }
    this.ProjectManager.flushAndDeleteProjectWithLocks(
      projectId,
      options,
      this.dependencies,
      error => {
        expect(error).to.equal(null)
        expect(
          this.drainWithLock.calledOnceWithExactly(projectId, projectLock)
        ).to.equal(true)
        expect(
          this.flushHistory.calledOnceWithExactly(projectId, options)
        ).to.equal(true)
        done()
      }
    )
  })

  it('preserves the empty legacy flush and delete when called without a guarded binding', async function () {
    await this.ProjectManager.promises.flushProjectWithLocks(projectId)
    await this.ProjectManager.promises.flushAndDeleteProjectWithLocks(
      projectId,
      {}
    )
    expect(this.withProjectLock.called).to.equal(false)
    expect(this.getDocIds.callCount).to.equal(2)
    expect(this.flushHistory.callCount).to.equal(1)
  })

  it('rechecks mode if the producer arms guarded mode during legacy enumeration', async function () {
    this.getDrainMode.onFirstCall().resolves('legacy')
    this.getDocIds.onFirstCall().resolves(['legacy-cache-entry'])
    this.getDocIds.onSecondCall().resolves([docId])

    await this.ProjectManager.promises.flushProjectWithLocks(
      projectId,
      this.dependencies
    )

    expect(this.getDocIds.callCount).to.equal(2)
    expect(
      this.drainWithLock.calledOnceWithExactly(projectId, projectLock)
    ).to.equal(true)
    expect(this.flushDoc.calledOnceWithExactly(projectId, docId)).to.equal(true)
  })

  it('bounds retries when no empty state has been observed', async function () {
    this.drainWithLock.resolves('acknowledged')

    await expect(
      this.ProjectManager.promises.flushProjectWithLocks(
        projectId,
        this.dependencies
      )
    ).to.be.rejectedWith('project updates have not drained')

    expect(this.drainWithLock.callCount).to.be.within(2, 16)
    expect(this.getDocIds.called).to.equal(false)
  })
})
