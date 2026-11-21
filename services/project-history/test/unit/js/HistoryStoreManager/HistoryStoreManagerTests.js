import sinon from 'sinon'
import { expect } from 'chai'
import { strict as esmock } from 'esmock'
import EventEmitter from 'node:events'
import OError from '@overleaf/o-error'
import { RequestFailedError } from '@overleaf/fetch-utils'
import * as Errors from '../../../../app/js/Errors.js'
import { reconcileRetirementPublication } from '../../../../app/js/HistoryPublication.js'
import { parseHistoryUpdate } from '../../../../app/js/HistoryPublicationEnvelope.js'
import { convertToChanges } from '../../../../app/js/UpdateTranslator.js'

const MODULE_PATH = '../../../../app/js/HistoryStoreManager.js'

describe('HistoryStoreManager', function () {
  beforeEach(async function () {
    this.projectId = '123456789012345678901234'
    this.historyId = 'mock-ol-project-id'
    this.settings = {
      overleaf: {
        history: {
          host: 'http://example.com',
          user: 'overleaf',
          pass: 'password',
          requestTimeout: 123,
        },
      },
      apis: {
        filestore: {
          enabled: true,
          url: 'http://filestore.overleaf.production',
        },
      },
    }
    this.callback = sinon.stub()

    this.LocalFileWriter = {
      bufferOnDisk: sinon.stub(),
    }

    this.WebApiManager = {
      getHistoryId: sinon.stub(),
    }
    this.WebApiManager.getHistoryId
      .withArgs(this.projectId)
      .yields(null, this.historyId)

    this.FetchUtils = {
      fetchJson: sinon.stub(),
      fetchJsonWithResponse: sinon.stub(),
      fetchStream: sinon.stub(),
      fetchString: sinon.stub(),
      fetchNothing: sinon.stub().resolves(),
      RequestFailedError,
    }

    this.logger = {
      debug: sinon.stub(),
      warn: sinon.stub(),
    }

    this.HistoryStoreManager = await esmock(MODULE_PATH, {
      '@overleaf/fetch-utils': this.FetchUtils,
      '@overleaf/settings': this.settings,
      '../../../../app/js/LocalFileWriter.js': this.LocalFileWriter,
      '../../../../app/js/WebApiManager.js': this.WebApiManager,
      '../../../../app/js/Errors.js': Errors,
      '@overleaf/logger': this.logger,
    })
  })

  describe('lookupActivationReceipt', function () {
    beforeEach(function () {
      this.publication = {
        historyId: '123456789012345678901234',
        batchId: '12345678-1234-1234-1234-123456789012',
        ordinal: 0,
        entryOrdinal: 0,
        digest: 'ab'.repeat(32),
      }
    })

    for (const status of [
      { status: 'pending' },
      { status: 'conflict' },
      { status: 'committed', historyVersion: 42 },
    ]) {
      it(`returns the exact ${status.status} result`, async function () {
        this.FetchUtils.fetchJson.resolves(status)

        const result = await this.HistoryStoreManager.lookupActivationReceipt(
          this.publication
        )

        expect(result).to.deep.equal(status)
        sinon.assert.calledOnceWithExactly(
          this.FetchUtils.fetchJson,
          'http://example.com/projects/123456789012345678901234/activation-receipts/lookup',
          sinon.match({
            method: 'POST',
            json: this.publication,
            basicAuth: { user: 'overleaf', password: 'password' },
          })
        )
      })
    }

    it('rejects a committed result without a valid persisted version', async function () {
      this.FetchUtils.fetchJson.resolves({
        status: 'committed',
        historyVersion: 0,
      })

      await expect(
        this.HistoryStoreManager.lookupActivationReceipt(this.publication)
      ).to.be.rejected
    })

    it('rejects a malformed history ID before sending the request', async function () {
      const publication = { ...this.publication, historyId: '../other' }

      await expect(
        this.HistoryStoreManager.lookupActivationReceipt(publication)
      ).to.be.rejected
      sinon.assert.notCalled(this.FetchUtils.fetchJson)
    })
  })

  describe('appendGuardedChange', function () {
    beforeEach(function () {
      this.change = {
        timestamp: '2026-11-21T00:00:00.000Z',
        operations: [],
        historyPublication: {
          historyId: '123456789012345678901234',
          batchId: '12345678-1234-1234-1234-123456789012',
          ordinal: 0,
          entryOrdinal: 0,
          digest: 'ab'.repeat(32),
        },
      }
    })

    it('sends preserved storage bytes with the expected base version', async function () {
      const receipt = { status: 'committed', historyVersion: 9 }
      this.FetchUtils.fetchJsonWithResponse.resolves({
        json: receipt,
        response: { status: 200 },
      })

      const result = await this.HistoryStoreManager.appendGuardedChange(
        this.change,
        8
      )

      expect(result).to.deep.equal(receipt)
      sinon.assert.calledOnceWithExactly(
        this.FetchUtils.fetchJsonWithResponse,
        'http://example.com/projects/123456789012345678901234/activation-receipts/append?end_version=8',
        sinon.match({ method: 'POST', json: this.change })
      )
    })

    it('returns pending for an indeterminate append', async function () {
      this.FetchUtils.fetchJsonWithResponse.resolves({
        json: { status: 'pending' },
        response: { status: 202 },
      })

      expect(
        await this.HistoryStoreManager.appendGuardedChange(this.change, 8)
      ).to.deep.equal({ status: 'pending' })
    })

    it('rejects a committed proof carried by a pending response', async function () {
      this.FetchUtils.fetchJsonWithResponse.resolves({
        json: { status: 'committed', historyVersion: 9 },
        response: { status: 202 },
      })

      await expect(
        this.HistoryStoreManager.appendGuardedChange(this.change, 8)
      ).to.be.rejectedWith('Unexpected guarded history append response')
    })

    it('rejects a tag-free change before the private request', async function () {
      delete this.change.historyPublication

      await expect(
        this.HistoryStoreManager.appendGuardedChange(this.change, 8)
      ).to.be.rejectedWith('Invalid guarded history change')
      sinon.assert.notCalled(this.FetchUtils.fetchJsonWithResponse)
    })
  })

  describe('getMostRecentChunk', function () {
    describe('successfully', function () {
      beforeEach(function (done) {
        this.chunk = {
          chunk: {
            startVersion: 0,
            history: {
              snapshot: {
                files: {},
              },
              changes: [],
            },
          },
        }
        this.FetchUtils.fetchString.resolves(JSON.stringify(this.chunk))
        this.HistoryStoreManager.getMostRecentChunk(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should request latest history from the overleaf history service', function () {
        expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects/${this.historyId}/latest/history`,
          {
            method: 'GET',
            basicAuth: {
              user: this.settings.overleaf.history.user,
              password: this.settings.overleaf.history.pass,
            },
          }
        )
      })

      it('should call the callback with the chunk', function () {
        expect(this.callback).to.have.been.calledWith(null, this.chunk)
      })
    })
  })

  describe('getMostRecentVersion', function () {
    describe('successfully', function () {
      beforeEach(function (done) {
        this.chunk = {
          chunk: {
            startVersion: 5,
            history: {
              snapshot: {
                files: {},
              },
              changes: [
                { v2Authors: ['5678'], timestamp: '2017-10-17T10:44:40.227Z' },
                { v2Authors: ['1234'], timestamp: '2017-10-16T10:44:40.227Z' },
              ],
            },
          },
        }

        this.FetchUtils.fetchString.resolves(JSON.stringify(this.chunk))
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should call the callback with the latest version information', function () {
        expect(this.callback).to.have.been.calledWith(
          null,
          7,
          { project: undefined, docs: {} },
          { v2Authors: ['5678'], timestamp: '2017-10-17T10:44:40.227Z' }
        )
      })

      it('should request latest history from the overleaf history service', function () {
        expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects/${this.historyId}/latest/history`,
          {
            method: 'GET',
            basicAuth: {
              user: this.settings.overleaf.history.user,
              password: this.settings.overleaf.history.pass,
            },
          }
        )
      })
    })

    describe('out of order doc ops', function () {
      beforeEach(function (done) {
        this.chunk = {
          chunk: {
            startVersion: 5,
            history: {
              snapshot: {
                v2DocVersions: {
                  mock_doc_id: {
                    pathname: '/main.tex',
                    v: 2,
                  },
                },
              },
              changes: [
                {
                  operations: [],
                  v2DocVersions: {
                    mock_doc_id: {
                      pathname: '/main.tex',
                      v: 1,
                    },
                  },
                },
              ],
            },
          },
        }

        this.FetchUtils.fetchString.resolves(JSON.stringify(this.chunk))
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should return an error', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match
            .instanceOf(Errors.OpsOutOfOrderError)
            .and(sinon.match.has('message', 'doc version out of order'))
        )
      })

      it('should call the callback with the latest version information', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match.instanceOf(Errors.OpsOutOfOrderError),
          6,
          {
            project: undefined,
            docs: { mock_doc_id: { pathname: '/main.tex', v: 2 } },
          },
          this.chunk.chunk.history.changes[0]
        )
      })
    })

    describe('out of order project structure versions', function () {
      beforeEach(function (done) {
        this.chunk = {
          chunk: {
            startVersion: 5,
            history: {
              snapshot: {
                projectVersion: 2,
              },
              changes: [
                {
                  operations: [{ pathname: 'main.tex', newPathname: '' }],
                  projectVersion: 1,
                },
              ],
            },
          },
        }

        this.FetchUtils.fetchString.resolves(JSON.stringify(this.chunk))
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should return an error', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match
            .instanceOf(Errors.OpsOutOfOrderError)
            .and(
              sinon.match.has(
                'message',
                'project structure version out of order'
              )
            )
        )
      })

      it('should call the callback with the latest version information', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match.instanceOf(Errors.OpsOutOfOrderError),
          6,
          { project: 2, docs: {} },
          this.chunk.chunk.history.changes[0]
        )
      })
    })

    describe('out of order project structure and doc versions', function () {
      beforeEach(function (done) {
        this.chunk = {
          chunk: {
            startVersion: 5,
            history: {
              snapshot: {
                projectVersion: 1,
              },
              changes: [
                {
                  operations: [{ pathname: 'main.tex', newPathname: '' }],
                  projectVersion: 1,
                },
                {
                  operations: [{ pathname: 'main.tex', newPathname: '' }],
                  projectVersion: 2,
                },
                {
                  operations: [{ pathname: 'main.tex', newPathname: '' }],
                  projectVersion: 3,
                },
                {
                  operations: [{ pathname: 'main.tex', newPathname: '' }],
                  projectVersion: 1,
                },
                {
                  operations: [],
                  v2DocVersions: {
                    mock_doc_id: {
                      pathname: '/main.tex',
                      v: 1,
                    },
                  },
                },
                {
                  operations: [],
                  v2DocVersions: {
                    mock_doc_id: {
                      pathname: '/main.tex',
                      v: 2,
                    },
                  },
                },
                {
                  operations: [],
                  v2DocVersions: {
                    mock_doc_id: {
                      pathname: '/main.tex',
                      v: 1,
                    },
                  },
                },
              ],
            },
          },
        }

        this.FetchUtils.fetchString.resolves(JSON.stringify(this.chunk))
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should return an error', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match
            .instanceOf(Errors.OpsOutOfOrderError)
            .and(
              sinon.match.has(
                'message',
                'project structure version out of order'
              )
            )
        )
      })

      it('should call the callback with the latest version information', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match.instanceOf(Errors.OpsOutOfOrderError),
          12,
          {
            project: 3,
            docs: { mock_doc_id: { pathname: '/main.tex', v: 2 } },
          },
          this.chunk.chunk.history.changes[6]
        )
      })
    })

    describe('with an unexpected response', function () {
      beforeEach(function (done) {
        this.badChunk = {
          chunk: {
            foo: 123, // valid chunk should have startVersion property
            bar: 456,
          },
        }
        this.FetchUtils.fetchString.resolves(JSON.stringify(this.badChunk))
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should return an error', function () {
        expect(this.callback).to.have.been.calledWith(
          sinon.match
            .instanceOf(Error)
            .and(sinon.match.has('message', 'unexpected response'))
        )
      })
    })
  })

  describe('_requestHistoryService error handling', function () {
    function itCallsBackWithTheHistoryServiceError(statusCode) {
      it('should call the callback with an error naming the status code', function () {
        const err = this.callback.firstCall.args[0]
        expect(err.message).to.equal(
          `history store a non-success status code: ${statusCode}`
        )
      })
    }

    describe('with a 409 response carrying a body', function () {
      beforeEach(function (done) {
        this.FetchUtils.fetchString.rejects(
          new RequestFailedError(
            `${this.settings.overleaf.history.host}/projects/${this.historyId}/latest/history`,
            { method: 'GET' },
            { status: 409 },
            'conflict-detail'
          )
        )
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      itCallsBackWithTheHistoryServiceError(409)

      it('should include the response body and status code in the error info', function () {
        const err = this.callback.firstCall.args[0]
        const info = OError.getFullInfo(err)
        expect(info.body).to.equal('conflict-detail')
        expect(info.statusCode).to.equal(409)
      })
    })

    describe('with a 422 response carrying a body', function () {
      beforeEach(function (done) {
        this.FetchUtils.fetchString.rejects(
          new RequestFailedError(
            `${this.settings.overleaf.history.host}/projects/${this.historyId}/latest/history`,
            { method: 'GET' },
            { status: 422 },
            'schema-validation-detail'
          )
        )
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      itCallsBackWithTheHistoryServiceError(422)

      it('should include the response body and status code in the error info', function () {
        const err = this.callback.firstCall.args[0]
        const info = OError.getFullInfo(err)
        expect(info.body).to.equal('schema-validation-detail')
        expect(info.statusCode).to.equal(422)
      })
    })

    describe('with a 500 response and no informative body', function () {
      beforeEach(function (done) {
        this.FetchUtils.fetchString.rejects(
          new RequestFailedError(
            `${this.settings.overleaf.history.host}/projects/${this.historyId}/latest/history`,
            { method: 'GET' },
            { status: 500 },
            null
          )
        )
        this.HistoryStoreManager.getMostRecentVersion(
          this.projectId,
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      itCallsBackWithTheHistoryServiceError(500)

      it('should not include a response body in the error info', function () {
        const err = this.callback.firstCall.args[0]
        const info = OError.getFullInfo(err)
        expect(info.body).to.equal(null)
        expect(info.statusCode).to.equal(500)
      })
    })
  })

  describe('createBlobForUpdate', function () {
    beforeEach(function () {
      this.fileStream = {}
      this.hash = 'random-hash'
      this.LocalFileWriter.bufferOnDisk.callsArgWith(4, null, this.hash)
      this.FetchUtils.fetchNothing.rejects(
        new RequestFailedError('', {}, { status: 404 })
      )
      this.FetchUtils.fetchStream.resolves(this.fileStream)
    })

    it('replays a conversion outbox until both exact removals and additions are durable', async function () {
      const owner = {
        projectId: this.projectId,
        docId: '123456789012345678901235',
        operationId: 'ea9500de-35a2-42c6-996e-bddf8db68bba',
        version: 4,
      }
      const historyId = '123456789012345678901236'
      const replacement = {
        fileId: '123456789012345678901237',
        sourceCommit: 'a'.repeat(40),
        hash: 'b'.repeat(40),
        name: 'paper.tex',
        created: '2026-01-01T00:00:00.000Z',
      }
      const retirement = {
        ...owner,
        userId: '123456789012345678901238',
        path: '/folder/paper.tex',
        deletedAt: '2026-01-01T00:00:01.000Z',
        committedStructureVersion: 21,
        replacement,
      }
      let durableEntries = 0
      const lookup = sinon.spy(async ({ entryOrdinal }) =>
        entryOrdinal < durableEntries
          ? { status: 'committed', historyVersion: 31 + entryOrdinal }
          : { status: 'pending' }
      )
      const enqueue = sinon.stub().resolves('buffered')
      const reconcile = () =>
        reconcileRetirementPublication(
          {
            getDocumentRetirement: async () => ({
              status: 'committed',
              retirement,
            }),
            getFreshHistoryId: async () => historyId,
            lookup,
            enqueue,
          },
          owner
        )

      expect(await reconcile()).to.equal('pending')
      const [outbox] = enqueue.firstCall.args
      expect(outbox.entries).to.have.length(2)
      const [remove, add] = outbox.entries.map(parseHistoryUpdate)
      expect(remove.version).to.equal('21.0')
      expect(add.version).to.equal('21.1')
      expect(add.pathname).to.equal(remove.pathname)

      const createBlob = () =>
        this.HistoryStoreManager.promises.createBlobForUpdate(
          this.projectId,
          historyId,
          add
        )
      await expect(createBlob()).to.be.rejectedWith('does not match')
      this.FetchUtils.fetchStream.rejects(
        new RequestFailedError('', {}, { status: 404 })
      )
      await expect(createBlob()).to.be.rejected
      expect(this.LocalFileWriter.bufferOnDisk.calledOnce).to.equal(true)

      this.FetchUtils.fetchStream.resolves(this.fileStream)
      this.LocalFileWriter.bufferOnDisk.callsArgWith(4, null, replacement.hash)
      const blobHashes = await createBlob()
      expect(this.FetchUtils.fetchStream.lastCall.args[0]).to.equal(
        `${this.settings.apis.filestore.url}/project/${this.projectId}/file/${replacement.fileId}`
      )
      const changes = convertToChanges(this.projectId, [
        { update: remove },
        { update: add, blobHashes },
      ])
      expect(
        changes.map(change => change.toStorageRaw().projectVersion)
      ).to.deep.equal(['21.0', '21.1'])
      expect(changes[1].toStorageRaw().operations).to.deep.equal([
        { pathname: 'folder/paper.tex', file: { hash: replacement.hash } },
      ])

      durableEntries = 1
      enqueue.resolves('replayed')
      expect(await reconcile()).to.equal('pending')
      expect(enqueue.secondCall.args).to.deep.equal([
        { ...outbox, requireExisting: true },
      ])
      durableEntries = 2
      expect(await reconcile()).to.equal('durable')
      expect(lookup.args.slice(-2)).to.deep.equal(
        changes.map(change => [change.toStorageRaw().historyPublication])
      )
      sinon.assert.calledTwice(enqueue)
    })

    describe('for a file update with any filestore location', function () {
      beforeEach(function (done) {
        this.file_id = '012345678901234567890123'
        this.update = {
          file: true,
          url: `http://filestore.other.cloud.provider/project/${this.projectId}/file/${this.file_id}`,
          hash: this.hash,
        }
        this.HistoryStoreManager.createBlobForUpdate(
          this.projectId,
          this.historyId,
          this.update,
          (err, { file: hash }) => {
            if (err) {
              return done(err)
            }
            this.actualHash = hash
            done()
          }
        )
      })

      it('should not log any warnings', function () {
        expect(this.logger.warn).to.not.have.been.called
      })

      it('should request the file from the filestore in settings', function () {
        expect(this.FetchUtils.fetchStream).to.have.been.calledWithMatch(
          `${this.settings.apis.filestore.url}/project/${this.projectId}/file/${this.file_id}`
        )
      })

      it('should call the callback with the blob', function () {
        expect(this.actualHash).to.equal(this.hash)
      })
    })

    describe('with filestore disabled', function () {
      beforeEach(function (done) {
        this.settings.apis.filestore.enabled = false
        this.file_id = '012345678901234567890123'
        this.update = {
          file: true,
          url: `http://filestore.other.cloud.provider/project/${this.projectId}/file/${this.file_id}`,
          hash: this.hash,
        }
        this.HistoryStoreManager.createBlobForUpdate(
          this.projectId,
          this.historyId,
          this.update,
          err => {
            expect(err).to.match(/blocking filestore read/)
            done()
          }
        )
      })
      it('should not request the file', function () {
        expect(this.FetchUtils.fetchStream).to.not.have.been.called
      })
    })

    describe('for a file update with an invalid filestore location', function () {
      beforeEach(function (done) {
        this.invalid_id = '000000000000000000000000'
        this.file_id = '012345678901234567890123'
        this.update = {
          file: true,
          url: `http://filestore.other.cloud.provider/project/${this.invalid_id}/file/${this.file_id}`,
          hash: this.hash,
        }
        this.HistoryStoreManager.createBlobForUpdate(
          this.projectId,
          this.historyId,
          this.update,
          err => {
            expect(err).to.exist
            done()
          }
        )
      })

      it('should not request the file from the filestore', function () {
        expect(this.FetchUtils.fetchStream).to.not.have.been.called
      })
    })

    describe('when the hash mismatches', function () {
      beforeEach(function (done) {
        this.file_id = '012345678901234567890123'
        this.update = {
          file: true,
          url: `http://filestore.other.cloud.provider/project/${this.projectId}/file/${this.file_id}`,
          hash: 'another-hash-from-web',
        }
        this.HistoryStoreManager.createBlobForUpdate(
          this.projectId,
          this.historyId,
          this.update,
          (err, { file: hash }) => {
            if (err) {
              return done(err)
            }
            this.actualHash = hash
            done()
          }
        )
      })

      it('should log a warning', function () {
        expect(this.logger.warn).to.have.been.calledWith(
          {
            projectId: this.projectId,
            fileId: this.file_id,
            webHash: 'another-hash-from-web',
            fileHash: this.hash,
          },
          'hash mismatch between web and project-history'
        )
      })

      it('should request the file from the filestore in settings', function () {
        expect(this.FetchUtils.fetchStream).to.have.been.calledWithMatch(
          `${this.settings.apis.filestore.url}/project/${this.projectId}/file/${this.file_id}`
        )
      })

      it('should call the callback with the blob', function () {
        expect(this.actualHash).to.equal(this.hash)
      })
    })
    describe('when the createdBlob flag is set on the update', function () {
      beforeEach(function () {
        this.file_id = '012345678901234567890123'
        this.update = {
          file: true,
          createdBlob: true,
          url: `http://filestore.other.cloud.provider/project/${this.projectId}/file/${this.file_id}`,
          hash: this.hash,
        }
      })
      describe('when history-v1 confirms that the blob exists', function () {
        beforeEach(function (done) {
          this.FetchUtils.fetchNothing.resolves()
          this.HistoryStoreManager.createBlobForUpdate(
            this.projectId,
            this.historyId,
            this.update,
            (err, { file: hash }) => {
              if (err) {
                return done(err)
              }
              this.actualHash = hash
              done()
            }
          )
        })

        it('should call the callback with the existing hash', function () {
          expect(this.actualHash).to.equal(this.hash)
        })

        it('should not request the file from the filestore', function () {
          expect(this.FetchUtils.fetchStream).to.not.have.been.called
        })

        it('should log a debug level message', function () {
          expect(this.logger.debug).to.have.been.calledWith(
            {
              projectId: this.projectId,
              fileId: this.file_id,
              update: this.update,
            },
            'Skipping blob creation as it has already been created'
          )
        })
      })
      describe('when history-v1 does not confirm that the blob exists', function () {
        beforeEach(function (done) {
          this.FetchUtils.fetchNothing.rejects(
            new RequestFailedError(
              `${this.settings.overleaf.history.host}/project/${this.projectId}/file/${this.file_id}`,
              { method: 'HEAD' },
              { status: 404 }
            )
          )
          this.HistoryStoreManager.createBlobForUpdate(
            this.projectId,
            this.historyId,
            this.update,
            (err, { file: hash }) => {
              if (err) {
                return done(err)
              }
              this.actualHash = hash
              done()
            }
          )
        })

        it('should warn that we will use the filestore', function () {
          expect(this.logger.warn).to.have.been.calledWithMatch(
            {
              fileId: this.file_id,
              projectId: this.projectId,
              update: this.update,
            },
            'created blob does not exist, reading from filestore'
          )
        })

        it('should request the file from the filestore in settings', function () {
          expect(this.FetchUtils.fetchStream).to.have.been.calledWithMatch(
            `${this.settings.apis.filestore.url}/project/${this.projectId}/file/${this.file_id}`
          )
        })

        it('should call the callback with the blob', function () {
          expect(this.actualHash).to.equal(this.hash)
        })
      })
    })
  })

  describe('getProjectBlob', function () {
    describe('successfully', function () {
      beforeEach(function (done) {
        this.blobContent = 'test content'
        this.blobHash = 'testhash'

        this.FetchUtils.fetchString.resolves(this.blobContent)
        this.HistoryStoreManager.getProjectBlob(
          this.historyId,
          this.blobHash,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should get the blob from the overleaf history service', function () {
        expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects/${this.historyId}/blobs/${this.blobHash}`
        )
      })

      it('should call the callback with the blob', function () {
        expect(this.callback).to.have.been.calledWith(null, this.blobContent)
      })
    })
  })

  describe('getProjectBlobStream', function () {
    describe('successfully', function () {
      beforeEach(function (done) {
        this.historyResponse = new EventEmitter()
        this.blobHash = 'test hash'

        this.FetchUtils.fetchStream.resolves(this.historyResponse)
        this.HistoryStoreManager.getProjectBlobStream(
          this.historyId,
          this.blobHash,
          (err, stream) => {
            if (err) {
              return done(err)
            }
            this.stream = stream
            done()
          }
        )
      })

      it('should get the blob from the overleaf history service', function () {
        expect(this.FetchUtils.fetchStream).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects/${this.historyId}/blobs/${this.blobHash}`
        )
      })

      it('should return a stream of the blob contents', function () {
        expect(this.stream).to.equal(this.historyResponse)
      })
    })
  })

  describe('initializeProject', function () {
    describe('successfully', function () {
      beforeEach(function (done) {
        this.response_body = { projectId: this.historyId }
        this.FetchUtils.fetchString.resolves(JSON.stringify(this.response_body))

        this.HistoryStoreManager.initializeProject(
          this.historyId,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should send the change to the history store', function () {
        expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects`,
          {
            method: 'POST',
            json: { projectId: this.historyId },
          }
        )
      })

      it('should call the callback with the new overleaf id', function () {
        expect(this.callback).to.have.been.calledWith(null, this.historyId)
      })
    })
  })

  describe('deleteProject', function () {
    beforeEach(function (done) {
      this.FetchUtils.fetchString.resolves('')
      this.HistoryStoreManager.deleteProject(this.historyId, done)
    })

    it('should ask the history store to delete the project', function () {
      expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
        `${this.settings.overleaf.history.host}/projects/${this.historyId}`,
        { method: 'DELETE' }
      )
    })
  })

  describe('sendChanges', function () {
    beforeEach(function () {
      this.changes = [{ op: 'mock-change' }]
      this.endVersion = 42
    })

    describe('successfully', function () {
      beforeEach(function (done) {
        this.FetchUtils.fetchString.resolves(
          JSON.stringify({ resyncNeeded: true })
        )
        this.HistoryStoreManager.sendChanges(
          this.projectId,
          this.historyId,
          this.changes,
          this.endVersion,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should send the changes to the history store', function () {
        expect(this.FetchUtils.fetchString).to.have.been.calledWithMatch(
          `${this.settings.overleaf.history.host}/projects/${this.historyId}/legacy_changes?end_version=${this.endVersion}`,
          {
            method: 'POST',
            json: this.changes,
          }
        )
      })

      it('should call the callback with the resync flag from the response', function () {
        expect(this.callback).to.have.been.calledWith(null, {
          resyncNeeded: true,
        })
      })
    })

    describe('when the history store returns a non-success status code', function () {
      beforeEach(function (done) {
        this.FetchUtils.fetchString.rejects(
          new RequestFailedError(
            `${this.settings.overleaf.history.host}/projects/${this.historyId}/legacy_changes`,
            { method: 'POST' },
            { status: 409 },
            'conflict-detail'
          )
        )
        this.HistoryStoreManager.sendChanges(
          this.projectId,
          this.historyId,
          this.changes,
          this.endVersion,
          (...args) => {
            this.callback(...args)
            done()
          }
        )
      })

      it('should call the callback with an error', function () {
        expect(this.callback.firstCall.args[0]).to.be.an.instanceOf(Error)
      })

      it('should keep the response body from the history store in the error info', function () {
        const err = this.callback.firstCall.args[0]
        expect(OError.getFullInfo(err).body).to.equal('conflict-detail')
      })
    })
  })
})
