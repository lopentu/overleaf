const assert = require('node:assert/strict')
const sinon = require('sinon')
const modulePath = '../../../../app/js/RealTimeRedisManager.js'
const SandboxedModule = require('sandboxed-module')
const Errors = require('../../../../app/js/Errors')

describe('RealTimeRedisManager', function () {
  beforeEach(function () {
    this.rclient = { eval: sinon.stub() }
    this.pubsubClient = { publish: sinon.stub() }
    this.RealTimeRedisManager = SandboxedModule.require(modulePath, {
      requires: {
        './Errors': Errors,
        '@overleaf/redis-wrapper': {
          createClient: config =>
            config.name === 'pubsub' ? this.pubsubClient : this.rclient,
        },
        '@overleaf/settings': (this.Settings = {
          redis: {
            documentupdater: (this.settings = {
              key_schema: {
                pendingProjectUpdates({ project_id: projectId }) {
                  return `PendingProjectUpdates:{${projectId}}`
                },
              },
            }),
            pubsub: {
              name: 'pubsub',
            },
          },
        }),
        crypto: (this.crypto = {
          randomBytes: sinon
            .stub()
            .withArgs(4)
            .returns(Buffer.from([0x1, 0x2, 0x3, 0x4])),
        }),
        os: (this.os = { hostname: sinon.stub().returns('somehost') }),
        './Metrics': (this.metrics = {
          summary: sinon.stub(),
          histogram: sinon.stub(),
        }),
      },
    })

    this.doc_id = 'doc-id-123'
    this.project_id = 'project-id-123'
    this.callback = sinon.stub()
  })

  describe('getPendingProjectUpdates', function () {
    it('checks protection and pops a batch using one project-slot EVAL', async function () {
      const updates = [
        { doc: 'doc-1', op: [{ i: 'foo', p: 4 }] },
        { doc: 'doc-2', op: [{ i: 'bar', p: 6 }] },
      ]
      const raw = updates.map(update => JSON.stringify(update))
      this.rclient.eval.resolves(['popped', 2, raw])
      assert.deepEqual(
        await this.RealTimeRedisManager.promises.getPendingProjectUpdates(
          this.project_id
        ),
        updates
      )
      const tag = `{${this.project_id}}`
      sinon.assert.calledOnceWithExactly(
        this.rclient.eval,
        sinon.match.string,
        4,
        `PendingProjectUpdates:${tag}`,
        `EditableRetirements:${tag}`,
        `PendingProjectUpdatesInFlight:${tag}`,
        `PendingProjectUpdatesGeneration:${tag}`,
        'legacy-pop'
      )
      assert.equal(this.metrics.summary.callCount, raw.length)
      assert.equal(this.metrics.histogram.firstCall.args[1], 2)
    })

    it('signals a protected queue as an error and reports no pop', async function () {
      this.rclient.eval.resolves(['guarded'])
      await new Promise((resolve, reject) => {
        this.RealTimeRedisManager.getPendingProjectUpdates(
          this.project_id,
          (error, updates) => {
            try {
              assert.ok(error instanceof Errors.ProjectUpdateQueueGuardedError)
              assert.equal(updates, undefined)
              assert.equal(this.metrics.summary.callCount, 0)
              resolve()
            } catch (assertionError) {
              reject(assertionError)
            }
          }
        )
      })
    })

    it('reports malformed persisted JSON as a parse error', async function () {
      this.rclient.eval.resolves(['popped', 1, ['broken json']])
      await assert.rejects(
        this.RealTimeRedisManager.promises.getPendingProjectUpdates(
          this.project_id
        ),
        SyntaxError
      )
    })
  })

  it('reuses the same project queue for guarded processing and mode reads', async function () {
    this.rclient.eval.resolves(['legacy'])
    assert.equal(
      await this.RealTimeRedisManager.guardedProjectQueue.getDrainMode(
        this.project_id
      ),
      'legacy'
    )
    assert.equal(this.rclient.eval.firstCall.args.at(-1), 'drain-mode')
  })

  describe('getProjectUpdatesLength', function () {
    beforeEach(function () {
      this.rclient.llen = sinon.stub().yields(null, (this.length = 4))
      return this.RealTimeRedisManager.getProjectUpdatesLength(
        this.project_id,
        this.callback
      )
    })

    it('should look up the length of the per-project queue', function () {
      return this.rclient.llen
        .calledWith(`PendingProjectUpdates:{${this.project_id}}`)
        .should.equal(true)
    })

    return it('should return the length', function () {
      return this.callback.calledWith(null, this.length).should.equal(true)
    })
  })

  return describe('sendData', function () {
    beforeEach(function () {
      this.message_id = 'doc:somehost:01020304-0'
      this.data = {
        project_id: this.project_id,
        doc_id: this.doc_id,
        op: 'thisop',
      }
      this.blob = JSON.stringify({
        ...this.data,
        _id: this.message_id,
        message: 'otUpdateApplied',
      })
    })

    describe('on the base editor-events channel', function () {
      beforeEach(function () {
        this.RealTimeRedisManager.sendData(this.data)
      })

      it('should send the op with a message id and message name', function () {
        return this.pubsubClient.publish
          .calledWith('editor-events', this.blob)
          .should.equal(true)
      })

      it('should track the payload size', function () {
        return this.metrics.summary
          .calledWith('redis.publish.applied-ops', this.blob.length, {
            path: 'editor-events',
          })
          .should.equal(true)
      })
    })

    describe('on the per-project editor-events channel', function () {
      beforeEach(function () {
        this.Settings.publishOnIndividualChannels = true
        this.RealTimeRedisManager.sendData(this.data)
      })

      it('should send the op on the per-project channel', function () {
        return this.pubsubClient.publish
          .calledWith(`editor-events:${this.project_id}`, this.blob)
          .should.equal(true)
      })
    })

    describe('with an error', function () {
      beforeEach(function () {
        this.data = {
          project_id: this.project_id,
          doc_id: this.doc_id,
          error: 'something went wrong',
        }
        this.blob = JSON.stringify({
          ...this.data,
          _id: this.message_id,
          message: 'otUpdateError',
        })
        this.RealTimeRedisManager.sendData(this.data)
      })

      it('should send the error with the otUpdateError message name', function () {
        return this.pubsubClient.publish
          .calledWith('editor-events', this.blob)
          .should.equal(true)
      })
    })
  })
})
