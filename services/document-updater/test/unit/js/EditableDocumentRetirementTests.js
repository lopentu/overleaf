const { expect } = require('chai')
const sinon = require('sinon')
const SandboxedModule = require('sandboxed-module')

describe('prepare editable document retirement', function () {
  beforeEach(function () {
    this.owner = {
      projectId: 'project-id',
      docId: 'doc-id',
      operationId: 'operation-id',
      version: 7,
    }
    this.settings = {
      documentupdater: {
        enableRetirementQueue: true,
        enableRetirementWriterSeal: true,
      },
    }
    this.lock = 'project-lock'
    this.fenceDocument = sinon.stub().resolves('fenced')
    this.extendLock = sinon.stub().resolves()
    this.drain = sinon.stub().resolves('empty')
    this.withLock = sinon.stub().callsFake(async (projectId, action) => {
      expect(projectId).to.equal(this.owner.projectId)
      return await action(this.lock)
    })
    this.getDoc = sinon.stub().resolves({ version: 7 })
    this.sealDocumentWrite = sinon.stub().resolves('sealed')
    this.flushSealedDocument = sinon.stub().resolves({ version: 7, rev: 21 })
    const { reconcileRetirement } = SandboxedModule.require(
      '../../../app/js/EditableDocumentRetirement.js',
      {
        requires: {
          '@overleaf/settings': this.settings,
          './ProjectLockManager': { promises: { extendLock: this.extendLock } },
          './WebApiManager': {
            promises: {
              getRetirementDecision: sinon.stub().resolves('prepared'),
            },
          },
          './RealTimeRedisManager': {
            guardedProjectQueue: { fenceDocument: this.fenceDocument },
          },
          './UpdateManager': {
            promises: {
              processGuardedQueuedBatchUnderLock: this.drain,
              withGuardedProjectLock: this.withLock,
            },
          },
          './DocumentManager': {
            promises: {
              getDoc: this.getDoc,
              flushSealedDocument: this.flushSealedDocument,
            },
          },
          './RedisManager': {
            promises: { sealDocumentWrite: this.sealDocumentWrite },
          },
          './HistoryManager': {
            promises: { ensureQueuedHistoryDurable: sinon.stub() },
          },
        },
      }
    )
    this.prepare = () => reconcileRetirement(this.owner)
  })

  it('drains older accepted edits before acquiring and flushing the exact seal', async function () {
    this.fenceDocument.onFirstCall().resolves('not_drained')
    this.drain.resolves('acknowledged')

    expect(await this.prepare()).to.deep.equal({
      status: 'prepared',
      persisted: { version: 7, rev: 21 },
    })
    sinon.assert.calledTwice(this.fenceDocument)
    expect(
      this.drain.firstCall.calledBefore(this.fenceDocument.secondCall)
    ).to.equal(true)
    sinon.assert.callOrder(
      this.getDoc,
      this.sealDocumentWrite,
      this.flushSealedDocument
    )
    sinon.assert.calledOnceWithExactly(this.sealDocumentWrite, this.owner)
    sinon.assert.calledOnceWithExactly(this.flushSealedDocument, this.owner)
  })

  it('defers preparation if older history is pending', async function () {
    this.fenceDocument.resolves('not_drained')
    this.drain.resolves('waiting-history')

    expect(await this.prepare()).to.deep.equal({ status: 'pending' })
    sinon.assert.notCalled(this.sealDocumentWrite)
    sinon.assert.notCalled(this.flushSealedDocument)
  })

  it('detects a document edit that advanced the requested base before the fence', async function () {
    this.getDoc.resolves({ version: 8 })

    expect(await this.prepare()).to.deep.equal({ status: 'conflict' })
    sinon.assert.notCalled(this.sealDocumentWrite)
    sinon.assert.notCalled(this.flushSealedDocument)
  })

  it('retries an exact prior fence and rejects a mismatched persistence reply', async function () {
    this.fenceDocument.resolves('already_fenced')
    this.flushSealedDocument.resolves({ version: 8, rev: 22 })

    await expect(this.prepare()).to.be.rejectedWith(
      'Persisted retirement version did not match'
    )
    sinon.assert.calledOnceWithExactly(this.flushSealedDocument, this.owner)
  })

  it('defers to Web when Redis reports a terminal state while Web is prepared', async function () {
    this.fenceDocument.resolves('already_committed')

    expect(await this.prepare()).to.deep.equal({ status: 'conflict' })
    sinon.assert.notCalled(this.getDoc)
    sinon.assert.notCalled(this.flushSealedDocument)
  })

  it('leaves ordinary workers outside the guarded protocol', async function () {
    this.settings.documentupdater.enableRetirementQueue = false

    await expect(this.prepare()).to.be.rejectedWith(
      'Guarded document retirement is unavailable'
    )
    sinon.assert.notCalled(this.withLock)
    sinon.assert.notCalled(this.fenceDocument)
  })
})
