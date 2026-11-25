import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import tk from 'timekeeper'
import moment from 'moment'

const modulePath = '../../../../app/src/Features/History/RestoreManager'

function nestedMapWithSetToObject(m) {
  return Object.fromEntries(
    Array.from(m.entries()).map(([key, set]) => [key, Array.from(set)])
  )
}

describe('RestoreManager', function () {
  beforeEach(async function (ctx) {
    tk.freeze(Date.now()) // freeze the time for these tests

    ctx.fsPath = '/tmp/path/on/disk'
    ctx.blobStream = 'blob-stream'

    vi.doMock('../../../../app/src/Features/Errors/Errors.js', () => ({
      default: Errors,
    }))

    vi.doMock(
      '../../../../app/src/Features/History/HistoryManager.mjs',
      () => ({
        default: (ctx.HistoryManager = {
          promises: {
            getContentAtVersion: sinon.stub().resolves({
              // Raw snapshot data that will be passed to Snapshot.fromRaw
              files: {
                'main.tex': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    editorId: 'test-editor',
                  },
                },
                'foo.tex': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    editorId: 'test-editor',
                  },
                },
                'folder/file.tex': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    editorId: 'test-editor',
                  },
                },
                'foo.png': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    provider: 'bar',
                  },
                },
                'linkedFile.bib': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    provider: 'mendeley',
                  },
                },
                'withMainTrue.tex': {
                  hash: 'abcdef1234567890abcdef1234567890abcdef12',
                  stringLength: 100,
                  metadata: {
                    main: true,
                  },
                },
              },
              timestamp: new Date().toISOString(),
            }),
            requestBlob: sinon.stub().resolves({ stream: ctx.blobStream }),
          },
        }),
      })
    )

    vi.doMock('../../../../app/src/infrastructure/Metrics.mjs', () => ({
      default: {
        revertFileDurationSeconds: {
          startTimer: sinon.stub().returns(sinon.stub()),
        },
        revertProjectDurationSeconds: {
          startTimer: sinon.stub().returns(sinon.stub()),
        },
      },
    }))

    vi.doMock('@overleaf/settings', () => ({
      default: {
        fileIgnorePattern:
          '**/{{__MACOSX,.git,.texpadtmp,.R,.venv,venv}{,/**},.!(latexmkrc),*.{dvi,aux,log,toc,out,pdfsync,synctex,synctex(busy),fdb_latexmk,fls,nlo,ind,glo,gls,glg,bbl,blg,doc,docx,gz,swp}}',
        editableFilenames: [],
        textExtensions: [
          'tex',
          'latex',
          'sty',
          'cls',
          'bst',
          'bib',
          'bibtex',
          'txt',
          'tikz',
          'mtx',
          'rtex',
          'md',
          'asy',
          'lbx',
          'bbx',
          'cbx',
          'm',
          'lco',
          'dtx',
          'ins',
          'ist',
          'def',
          'clo',
          'ldf',
          'rmd',
          'lua',
          'gv',
          'mf',
          'yml',
          'yaml',
          'lhs',
          'lean',
          'lean4',
          'hs',
          'mk',
          'xmpdata',
          'cfg',
          'rnw',
          'ltx',
          'inc',
        ],
      },
    }))

    vi.doMock('../../../../app/src/infrastructure/FileWriter', () => ({
      default: (ctx.FileWriter = {
        promises: {
          writeStreamToDisk: sinon.stub().resolves(ctx.fsPath),
          writeContentToDisk: sinon.stub().resolves(ctx.fsPath),
        },
      }),
    }))

    vi.doMock(
      '../../../../app/src/Features/Uploads/FileSystemImportManager',
      () => ({
        default: (ctx.FileSystemImportManager = {
          promises: {},
        }),
      })
    )

    vi.doMock('../../../../app/src/Features/Editor/EditorController', () => ({
      default: (ctx.EditorController = {
        promises: {},
      }),
    }))

    vi.doMock('../../../../app/src/Features/Project/ProjectLocator', () => ({
      default: (ctx.ProjectLocator = { promises: {} }),
    }))

    vi.doMock(
      '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler',
      () => ({
        default: (ctx.DocumentUpdaterHandler = {
          promises: { flushProjectToMongo: sinon.stub().resolves() },
        }),
      })
    )

    vi.doMock('../../../../app/src/Features/Docstore/DocstoreManager', () => ({
      default: (ctx.DocstoreManager = {
        promises: { getCommentThreadIds: sinon.stub().resolves({}) },
      }),
    }))

    vi.doMock('../../../../app/src/Features/Chat/ChatApiHandler', () => ({
      default: (ctx.ChatApiHandler = { promises: {} }),
    }))

    vi.doMock('../../../../app/src/Features/Chat/ChatManager', () => ({
      default: (ctx.ChatManager = { promises: {} }),
    }))

    vi.doMock(
      '../../../../app/src/Features/Editor/EditorRealTimeController',
      () => ({
        default: (ctx.EditorRealTimeController = {}),
      })
    )

    vi.doMock('../../../../app/src/Features/Project/ProjectGetter', () => ({
      default: (ctx.ProjectGetter = { promises: {} }),
    }))

    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityHandler',
      () => ({
        default: (ctx.ProjectEntityHandler = {
          promises: {},
        }),
      })
    )

    vi.doMock('overleaf-editor-core', () => ({
      Snapshot: {
        fromRaw: sinon.stub().callsFake(snapshotData => ({
          getFile: pathname => ({
            getStringLength: sinon.stub().returns(100),
            getByteLength: sinon.stub().returns(100),
            getContent: sinon
              .stub()
              .callsFake(({ filterTrackedDeletes } = {}) => {
                const file = snapshotData?.files?.[pathname]
                const filtered = filterTrackedDeletes
                  ? file?.filteredText
                  : undefined
                return filtered ?? file?.rawText ?? 'foo\nbar\nbaz'
              }),
            isEditable: sinon.stub().returns(true),
            getMetadata: sinon
              .stub()
              .returns(snapshotData?.files?.[pathname]?.metadata),
            getHash: sinon.stub().returns((ctx.hash = 'somehash')),
          }),
          getFilePathnames: sinon
            .stub()
            .returns(Object.keys(snapshotData.files || {})),
          getTimestamp: sinon
            .stub()
            .returns(
              snapshotData?.timestamp
                ? new Date(snapshotData.timestamp)
                : new Date()
            ),
        })),
      },
      getDocUpdaterCompatibleRanges: (ctx.getDocUpdaterCompatibleRanges = sinon
        .stub()
        .returns({
          changes: ctx.tracked_changes || [],
          comments: ctx.comments || [],
        })),
    }))

    ctx.RestoreManager = (await import(modulePath)).default
    ctx.user_id = 'mock-user-id'
    ctx.project_id = 'mock-project-id'
    ctx.version = 42

    // Add missing method mocks to RestoreManager
    ctx.RestoreManager.promises._getUpdatesFromHistory = sinon.stub().resolves([
      {
        toV: ctx.version,
        meta: { end_ts: new Date('2024-01-01T00:00:00.000Z') },
      },
    ])

    ctx.RestoreManager.promises._writeFileVersionToDisk = sinon
      .stub()
      .resolves('/tmp/mock-file-path')
  })

  afterEach(function () {
    tk.reset()
    vi.resetModules()
  })

  describe('restoreFileFromV2', function () {
    beforeEach(function (ctx) {
      ctx.ProjectGetter.promises.getProject = sinon.stub().resolves({})
      ctx.RestoreManager.promises._writeFileVersionToDisk = sinon
        .stub()
        .resolves((ctx.fsPath = '/tmp/path/on/disk'))
      ctx.RestoreManager.promises._findOrCreateFolder = sinon
        .stub()
        .resolves((ctx.folder_id = 'mock-folder-id'))
      ctx.FileSystemImportManager.promises.addEntity = sinon
        .stub()
        .resolves((ctx.entity = 'mock-entity'))
    })

    describe('with a file not in a folder', function () {
      beforeEach(async function (ctx) {
        ctx.pathname = 'foo.tex'
        ctx.result = await ctx.RestoreManager.promises.restoreFileFromV2(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          ctx.pathname
        )
      })

      it('should write the file version to disk', function (ctx) {
        ctx.RestoreManager.promises._writeFileVersionToDisk
          .calledWith(ctx.project_id, ctx.version, ctx.pathname)
          .should.equal(true)
      })

      it('should find the root folder', function (ctx) {
        ctx.RestoreManager.promises._findOrCreateFolder
          .calledWith(ctx.project_id, '', ctx.user_id)
          .should.equal(true)
      })

      it('should add the entity', function (ctx) {
        ctx.FileSystemImportManager.promises.addEntity
          .calledWith(
            ctx.user_id,
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ctx.fsPath,
            false
          )
          .should.equal(true)
      })

      it('should return the entity', function (ctx) {
        expect(ctx.result).to.equal(ctx.entity)
      })
    })

    describe('with a file in a folder', function () {
      beforeEach(async function (ctx) {
        ctx.pathname = 'foo/bar.tex'
        await ctx.RestoreManager.promises.restoreFileFromV2(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          ctx.pathname
        )
      })

      it('should find the folder', function (ctx) {
        ctx.RestoreManager.promises._findOrCreateFolder
          .calledWith(ctx.project_id, 'foo', ctx.user_id)
          .should.equal(true)
      })

      it('should add the entity by its basename', function (ctx) {
        ctx.FileSystemImportManager.promises.addEntity
          .calledWith(
            ctx.user_id,
            ctx.project_id,
            ctx.folder_id,
            'bar.tex',
            ctx.fsPath,
            false
          )
          .should.equal(true)
      })
    })

    describe('when addEntity throws an error', function () {
      beforeEach(function (ctx) {
        ctx.pathname = 'foo.tex'
        ctx.FileSystemImportManager.promises.addEntity = sinon
          .stub()
          .rejects(new Error('Failed to add entity'))
        ctx.fsUnlink = sinon.stub().resolves()
        vi.doMock('node:fs', () => ({
          default: { promises: { unlink: ctx.fsUnlink } },
        }))
      })

      it('should clean up the temporary file and propagate the error', async function (ctx) {
        let error
        try {
          await ctx.RestoreManager.promises.restoreFileFromV2(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        } catch (err) {
          error = err
        }
        expect(error).to.exist
        expect(error.message).to.equal('Failed to add entity')
      })
    })
  })

  describe('range-enabled deleted-file recovery', function () {
    beforeEach(function (ctx) {
      ctx.ProjectGetter.promises.getProject = sinon.stub().resolves({
        overleaf: { history: { id: 'history-id', rangesSupportEnabled: true } },
      })
      ctx.recoverySnapshot = {
        editable: true,
        content: 'foo\nbar\nbaz',
        timestamp: '2026-11-22T00:00:00.000Z',
        metadata: null,
        changes: [],
        comments: [],
      }
      ctx.HistoryManager.promises.getFileRecoveryAtVersion = sinon
        .stub()
        .resolves(ctx.recoverySnapshot)
      ctx.recovered = { _id: 'recovered-doc', type: 'doc' }
      ctx.EditorController.promises.addHistoryRecovery = sinon
        .stub()
        .resolves(ctx.recovered)
      ctx.EditorController.promises.deleteEntity = sinon.stub()
      ctx.EditorController.promises.upsertFile = sinon.stub()
      ctx.RestoreManager.promises._findOrCreateFolder = sinon
        .stub()
        .resolves('folder-id')
      ctx.FileSystemImportManager.promises.addEntity = sinon.stub().resolves({
        _id: 'bare-copy',
        type: 'doc',
      })
      ctx.EditorRealTimeController.emitToRoom = sinon.stub()
      ctx.ChatApiHandler.promises.resolveThread = sinon.stub().resolves()
      ctx.ChatApiHandler.promises.reopenThread = sinon.stub().resolves()
      ctx.ChatApiHandler.promises.deleteThread = sinon.stub().resolves()
      ctx.ChatManager.promises.injectUserInfoIntoThreads = sinon
        .stub()
        .resolves()
      ctx.recover = (pathname = 'foo.tex') =>
        ctx.RestoreManager.promises.restoreFileFromV2(
          ctx.user_id,
          ctx.project_id,
          0,
          pathname
        )
    })

    it('recovers additively from version zero', async function (ctx) {
      expect(await ctx.recover()).to.deep.equal(ctx.recovered)
      sinon.assert.calledOnceWithExactly(
        ctx.HistoryManager.promises.getFileRecoveryAtVersion,
        ctx.project_id,
        0,
        'foo.tex'
      )
      sinon.assert.notCalled(ctx.HistoryManager.promises.getContentAtVersion)
      sinon.assert.notCalled(ctx.FileSystemImportManager.promises.addEntity)
      sinon.assert.notCalled(ctx.EditorController.promises.deleteEntity)
    })

    it('keeps historical ranges and copies surviving threads without changing their originals', async function (ctx) {
      const historicalChanges = [{ op: { p: 1, i: 'historical insertion' } }]
      const original = {
        id: 'original-thread',
        op: { t: 'original-thread', p: 0, c: 'anchor', resolved: true },
      }
      const missing = {
        id: 'deleted-thread',
        op: { t: 'deleted-thread', p: 2, c: 'old anchor' },
      }
      ctx.recoverySnapshot.changes = historicalChanges
      ctx.recoverySnapshot.comments = [original, missing]
      ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
        .stub()
        .resolves({
          newThreads: {
            'original-thread': { duplicateId: 'copied-thread' },
            'deleted-thread': { error: 'not found' },
          },
        })
      const reply = { content: 'reply in the copied thread' }
      ctx.ChatApiHandler.promises.generateThreadData = sinon.stub().resolves({
        'copied-thread': { messages: [reply] },
      })

      expect(await ctx.recover()).to.deep.equal(ctx.recovered)

      sinon.assert.calledOnceWithExactly(
        ctx.ChatApiHandler.promises.duplicateCommentThreads,
        ctx.project_id,
        ['original-thread', 'deleted-thread']
      )
      sinon.assert.calledOnceWithExactly(
        ctx.ChatApiHandler.promises.resolveThread,
        ctx.project_id,
        'copied-thread',
        ctx.user_id
      )
      sinon.assert.notCalled(ctx.ChatApiHandler.promises.reopenThread)
      expect(original.op.t).to.equal('original-thread')
      expect(
        ctx.EditorController.promises.addHistoryRecovery.firstCall.args[4]
      ).to.deep.equal({
        type: 'doc',
        lines: ['foo', 'bar', 'baz'],
        ranges: {
          changes: historicalChanges,
          comments: [
            {
              id: 'copied-thread',
              op: { t: 'copied-thread', p: 0, c: 'anchor', resolved: true },
            },
          ],
        },
      })
      expect(
        ctx.EditorRealTimeController.emitToRoom.firstCall.args[2][
          'copied-thread'
        ].messages
      ).to.deep.equal([reply])
    })

    it('propagates a chat operational failure and cleans up known unused copies', async function (ctx) {
      ctx.recoverySnapshot.comments = [
        { op: { t: 'original-thread' } },
        { op: { t: 'error-thread' } },
      ]
      ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
        .stub()
        .resolves({
          newThreads: {
            'original-thread': { duplicateId: 'unused-copy' },
            'error-thread': { error: 'unknown' },
          },
        })

      await expect(ctx.recover()).to.eventually.be.rejectedWith(
        'failed to duplicate a historical comment thread'
      )

      sinon.assert.calledOnceWithExactly(
        ctx.ChatApiHandler.promises.deleteThread,
        ctx.project_id,
        'unused-copy'
      )
      sinon.assert.notCalled(ctx.EditorController.promises.addHistoryRecovery)
    })

    it('cleans known unused copies when the add fails before inserting', async function (ctx) {
      ctx.recoverySnapshot.comments = [{ op: { t: 'original-thread' } }]
      ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
        .stub()
        .resolves({
          newThreads: { 'original-thread': { duplicateId: 'unused-copy' } },
        })
      ctx.ChatApiHandler.promises.generateThreadData = sinon.stub().resolves({
        'unused-copy': { messages: [] },
      })
      ctx.EditorController.promises.addHistoryRecovery.rejects(
        new Error('docstore failed')
      )

      await expect(ctx.recover()).to.eventually.be.rejectedWith(
        'docstore failed'
      )
      sinon.assert.calledOnceWithExactly(
        ctx.ChatApiHandler.promises.deleteThread,
        ctx.project_id,
        'unused-copy'
      )
      sinon.assert.notCalled(ctx.EditorRealTimeController.emitToRoom)
    })

    it('cleans unused copies when the project is already at its file limit', async function (ctx) {
      ctx.recoverySnapshot.comments = [{ op: { t: 'original-thread' } }]
      ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
        .stub()
        .resolves({
          newThreads: { 'original-thread': { duplicateId: 'unused-copy' } },
        })
      ctx.ChatApiHandler.promises.generateThreadData = sinon.stub().resolves({
        'unused-copy': { messages: [] },
      })
      ctx.EditorController.promises.addHistoryRecovery.callsFake(
        async (...args) => {
          args[7]()
          throw new Errors.TooManyFilesError('project has too many files')
        }
      )

      await expect(ctx.recover()).to.eventually.be.rejectedWith(
        Errors.TooManyFilesError
      )

      sinon.assert.calledOnceWithExactly(
        ctx.ChatApiHandler.promises.deleteThread,
        ctx.project_id,
        'unused-copy'
      )
    })

    it('filters tracked deletions when materializing historical text as a binary file', async function (ctx) {
      ctx.recoverySnapshot.content = 'keep'
      ctx.EditorController.promises.addHistoryRecovery.resolves({
        _id: 'recovered-file',
        type: 'file',
      })

      await ctx.recover('legacy.pdf')

      sinon.assert.calledOnceWithExactly(
        ctx.FileWriter.promises.writeContentToDisk,
        'history-id_restore-manager-editable',
        'keep'
      )
      expect(
        ctx.EditorController.promises.addHistoryRecovery.firstCall.args[4].type
      ).to.equal('file')
    })

    it('keeps copy threads if a failure may have occurred after the document was attached', async function (ctx) {
      ctx.recoverySnapshot.comments = [{ op: { t: 'original-thread' } }]
      ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
        .stub()
        .resolves({
          newThreads: {
            'original-thread': { duplicateId: 'possibly-attached-copy' },
          },
        })
      ctx.ChatApiHandler.promises.generateThreadData = sinon.stub().resolves({
        'possibly-attached-copy': { messages: [] },
      })
      ctx.EditorController.promises.addHistoryRecovery.callsFake(
        async (...args) => {
          args[7]()
          throw new Error('doc updater failed')
        }
      )

      await expect(ctx.recover()).to.eventually.be.rejectedWith(
        'doc updater failed'
      )
      sinon.assert.notCalled(ctx.ChatApiHandler.promises.deleteThread)
      sinon.assert.notCalled(ctx.EditorRealTimeController.emitToRoom)
    })

    it('adds a historical linked file without upserting a live one', async function (ctx) {
      const file = { _id: 'new-linked-file', type: 'file' }
      ctx.EditorController.promises.addHistoryRecovery.resolves(file)
      ctx.recoverySnapshot.content = null
      ctx.recoverySnapshot.editable = false
      ctx.recoverySnapshot.metadata = { provider: 'mendeley' }
      ctx.RestoreManager.promises._writeFileVersionToDisk.resolves(ctx.fsPath)

      expect(await ctx.recover('linkedFile.bib')).to.deep.equal(file)
      sinon.assert.calledOnceWithExactly(
        ctx.RestoreManager.promises._writeFileVersionToDisk,
        ctx.project_id,
        0,
        'linkedFile.bib'
      )
      expect(
        ctx.EditorController.promises.addHistoryRecovery.firstCall.args[4]
      ).to.deep.equal({
        type: 'file',
        fsPath: ctx.fsPath,
        linkedFileData: { provider: 'mendeley' },
      })
      sinon.assert.notCalled(ctx.EditorController.promises.upsertFile)
      sinon.assert.notCalled(ctx.EditorController.promises.deleteEntity)
    })
  })

  describe('_findOrCreateFolder', function () {
    beforeEach(async function (ctx) {
      ctx.EditorController.promises.mkdirp = sinon.stub().resolves({
        newFolders: [],
        lastFolder: { _id: (ctx.folder_id = 'mock-folder-id') },
      })
      ctx.result = await ctx.RestoreManager.promises._findOrCreateFolder(
        ctx.project_id,
        'folder/name',
        ctx.user_id
      )
    })

    it('should look up or create the folder', function (ctx) {
      ctx.EditorController.promises.mkdirp
        .calledWith(ctx.project_id, 'folder/name', ctx.user_id)
        .should.equal(true)
    })

    it('should return the folder_id', function (ctx) {
      expect(ctx.result).to.equal(ctx.folder_id)
    })
  })

  describe('_addEntityWithUniqueName', function () {
    beforeEach(function (ctx) {
      ctx.addEntityWithName = sinon.stub()
      ctx.filename = 'foo.tex'
    })

    describe('with a valid name', function () {
      beforeEach(async function (ctx) {
        ctx.addEntityWithName.resolves((ctx.entity = 'mock-entity'))
        ctx.result = await ctx.RestoreManager.promises._addEntityWithUniqueName(
          ctx.addEntityWithName,
          ctx.filename
        )
      })

      it('should add the entity', function (ctx) {
        ctx.addEntityWithName.calledWith(ctx.filename).should.equal(true)
      })

      it('should return the entity', function (ctx) {
        expect(ctx.result).to.equal(ctx.entity)
      })
    })

    describe('with a duplicate name', function () {
      beforeEach(async function (ctx) {
        ctx.addEntityWithName.rejects(new Errors.DuplicateNameError())
        ctx.addEntityWithName
          .onSecondCall()
          .resolves((ctx.entity = 'mock-entity'))
        ctx.result = await ctx.RestoreManager.promises._addEntityWithUniqueName(
          ctx.addEntityWithName,
          ctx.filename
        )
      })

      it('should try to add the entity with its original name', function (ctx) {
        ctx.addEntityWithName.calledWith('foo.tex').should.equal(true)
      })

      it('should try to add the entity with a unique name', function (ctx) {
        const date = moment(new Date()).format('Do MMM YY H:mm:ss')
        ctx.addEntityWithName
          .calledWith(`foo (Restored on ${date}).tex`)
          .should.equal(true)
      })

      it('should return the entity', function (ctx) {
        expect(ctx.result).to.equal(ctx.entity)
      })
    })
  })

  describe('revertFile', function () {
    beforeEach(function (ctx) {
      ctx.ProjectGetter.promises.getProject = sinon.stub()
      ctx.ProjectGetter.promises.getProject.withArgs(ctx.project_id).resolves({
        overleaf: { history: { rangesSupportEnabled: true } },
        rootDoc_id: 'root-doc-id',
      })
      ctx.RestoreManager.promises._findOrCreateFolder = sinon
        .stub()
        .resolves((ctx.folder_id = 'mock-folder-id'))
      ctx.FileSystemImportManager.promises.addEntity = sinon
        .stub()
        .resolves((ctx.entity = 'mock-entity'))
    })

    describe('reverting a project without ranges support', function () {
      beforeEach(function (ctx) {
        ctx.ProjectGetter.promises.getProject = sinon.stub().resolves({
          overleaf: { history: { rangesSupportEnabled: false } },
        })
      })

      it('should throw an error', async function (ctx) {
        await expect(
          ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        ).to.eventually.be.rejectedWith('project does not have ranges support')
      })
    })

    describe('reverting a document with ranges', function () {
      beforeEach(function (ctx) {
        ctx.pathname = 'foo.tex'
        ctx.comments = [
          {
            id: 'comment-in-other-doc',
            op: { t: 'comment-in-other-doc', p: 0, c: 'foo' },
          },
          {
            id: 'single-comment',
            op: { t: 'single-comment', p: 10, c: 'bar' },
          },
          {
            id: 'deleted-comment',
            op: { t: 'deleted-comment', p: 20, c: 'baz' },
          },
        ]
        ctx.remappedComments = [
          {
            id: 'duplicate-comment',
            op: { t: 'duplicate-comment', p: 0, c: 'foo' },
          },
          {
            id: 'single-comment',
            op: { t: 'single-comment', p: 10, c: 'bar' },
          },
        ]
        ctx.ProjectLocator.promises.findElementByPath = sinon.stub().rejects()
        ctx.DocstoreManager.promises.getCommentThreadIds = sinon
          .stub()
          .resolves({ 'other-doc': [ctx.comments[0].op.t] })
        ctx.ChatApiHandler.promises.duplicateCommentThreads = sinon
          .stub()
          .resolves({
            newThreads: {
              'comment-in-other-doc': {
                duplicateId: 'duplicate-comment',
              },
            },
          })
        ctx.ChatApiHandler.promises.generateThreadData = sinon.stub().resolves(
          (ctx.threadData = {
            'single-comment': {
              messages: [
                {
                  content: 'message-content',
                  timestamp: '2024-01-01T00:00:00.000Z',
                  user_id: 'user-1',
                },
              ],
            },
            'duplicate-comment': {
              messages: [
                {
                  content: 'another message',
                  timestamp: '2024-01-01T00:00:00.000Z',
                  user_id: 'user-1',
                },
              ],
            },
          })
        )
        ctx.ChatManager.promises.injectUserInfoIntoThreads = sinon
          .stub()
          .resolves(ctx.threadData)

        ctx.EditorRealTimeController.emitToRoom = sinon.stub()
        ctx.tracked_changes = [
          {
            op: { pos: 4, i: 'bar' },
            metadata: { ts: '2024-01-01T00:00:00.000Z', user_id: 'user-1' },
          },
          {
            op: { pos: 8, d: 'qux' },
            metadata: { ts: '2024-01-01T00:00:00.000Z', user_id: 'user-2' },
          },
        ]
        ctx.getDocUpdaterCompatibleRanges.returns({
          changes: ctx.tracked_changes,
          comments: ctx.comments,
        })
        ctx.RestoreManager.promises._getUpdatesFromHistory = sinon
          .stub()
          .resolves([
            { toV: ctx.version, meta: { end_ts: (ctx.endTs = new Date()) } },
          ])
        ctx.EditorController.promises.addDocWithRanges = sinon
          .stub()
          .resolves((ctx.addedFile = { _id: 'mock-doc', type: 'doc' }))
      })

      describe("when reverting a file that doesn't current exist", function () {
        beforeEach(async function (ctx) {
          ctx.data = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should flush the document before fetching ranges', function (ctx) {
          expect(
            ctx.DocumentUpdaterHandler.promises.flushProjectToMongo
          ).to.have.been.calledBefore(
            ctx.DocstoreManager.promises.getCommentThreadIds
          )
        })

        it('should import the file', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ['foo', 'bar', 'baz'],
            { changes: ctx.tracked_changes, comments: ctx.remappedComments }
          )
        })

        it('should return the created entity', function (ctx) {
          expect(ctx.data).to.deep.equal(ctx.addedFile)
        })
      })

      describe('with an existing file in the current project', function () {
        beforeEach(async function (ctx) {
          ctx.ProjectGetter.promises.getProject = sinon.stub()
          ctx.ProjectGetter.promises.getProject
            .withArgs(ctx.project_id)
            .resolves({
              overleaf: { history: { rangesSupportEnabled: true } },
              rootDoc_id: 'root-doc-id',
            })
          ctx.ProjectLocator.promises.findElementByPath = sinon
            .stub()
            .resolves({ type: 'file', element: { _id: 'mock-file-id' } })
          ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()

          ctx.data = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should delete the existing file', async function (ctx) {
          expect(
            ctx.EditorController.promises.deleteEntity
          ).to.have.been.calledWith(
            ctx.project_id,
            'mock-file-id',
            'file',
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            },
            ctx.user_id
          )
        })
      })

      describe('with an existing document in the current project', function () {
        beforeEach(async function (ctx) {
          ctx.ProjectGetter.promises.getProject = sinon.stub()
          ctx.ProjectGetter.promises.getProject
            .withArgs(ctx.project_id)
            .resolves({
              overleaf: { history: { rangesSupportEnabled: true } },
              rootDoc_id: 'root-doc-id',
            })
          ctx.ProjectLocator.promises.findElementByPath = sinon
            .stub()
            .resolves({ type: 'doc', element: { _id: 'mock-file-id' } })
          ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()

          ctx.data = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should delete the existing document', async function (ctx) {
          expect(
            ctx.EditorController.promises.deleteEntity
          ).to.have.been.calledWith(
            ctx.project_id,
            'mock-file-id',
            'doc',
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            },
            ctx.user_id
          )
        })

        it('should flush the document before fetching ranges', function (ctx) {
          expect(
            ctx.DocumentUpdaterHandler.promises.flushProjectToMongo
          ).to.have.been.calledBefore(
            ctx.DocstoreManager.promises.getCommentThreadIds
          )
        })

        it('should import the file', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ['foo', 'bar', 'baz'],
            { changes: ctx.tracked_changes, comments: ctx.remappedComments },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            }
          )
        })

        it('should return the created entity', function (ctx) {
          expect(ctx.data).to.deep.equal(ctx.addedFile)
        })
      })

      describe('with comments in same doc', function () {
        // copy of the above, addition: inject and later inspect threadIds set
        beforeEach(async function (ctx) {
          ctx.ProjectGetter.promises.getProject = sinon.stub()
          ctx.ProjectGetter.promises.getProject
            .withArgs(ctx.project_id)
            .resolves({
              overleaf: { history: { rangesSupportEnabled: true } },
              rootDoc_id: 'root-doc-id',
            })
          ctx.ProjectLocator.promises.findElementByPath = sinon
            .stub()
            .resolves({ type: 'doc', element: { _id: 'mock-file-id' } })
          ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()
          ctx.ChatApiHandler.promises.generateThreadData = sinon
            .stub()
            .resolves(
              (ctx.threadData = {
                [ctx.comments[0].op.t]: {
                  messages: [
                    {
                      content: 'message',
                      timestamp: '2024-01-01T00:00:00.000Z',
                      user_id: 'user-1',
                    },
                  ],
                },
                [ctx.comments[1].op.t]: {
                  messages: [
                    {
                      content: 'other message',
                      timestamp: '2024-01-01T00:00:00.000Z',
                      user_id: 'user-1',
                    },
                  ],
                },
              })
            )

          ctx.threadIds = new Map([
            [
              'mock-file-id',
              new Set([ctx.comments[0].op.t, ctx.comments[1].op.t]),
            ],
          ])
          // Comments are updated in-place. Look up threads before reverting.
          ctx.afterThreadIds = {
            // mock-file-id removed
            [ctx.addedFile._id]: [ctx.comments[0].op.t, ctx.comments[1].op.t],
          }
          ctx.data = await ctx.RestoreManager.promises._revertSingleFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname,
            ctx.threadIds,
            {
              getFile: sinon.stub().returns({
                getMetadata: sinon.stub().returns(undefined),
                getContent: sinon.stub().returns('foo\nbar\nbaz'),
                isEditable: sinon.stub().returns(true),
              }),
            },
            {
              origin: {
                kind: 'file-restore',
                path: 'foo.tex',
                timestamp: new Date(ctx.endTs).toISOString(),
                version: 42,
              },
            }
          )
        })

        it('should import the file with original comments minus the deleted one', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ['foo', 'bar', 'baz'],
            {
              changes: ctx.tracked_changes,
              comments: ctx.comments.slice(0, 2),
            },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            }
          )
        })

        it('should add the seen thread ids to the map', function (ctx) {
          expect(nestedMapWithSetToObject(ctx.threadIds)).to.deep.equal(
            ctx.afterThreadIds
          )
        })
      })

      describe('with remapped comments during revertProject', function () {
        // copy of the above, addition: inject and later inspect threadIds set
        beforeEach(async function (ctx) {
          ctx.ProjectGetter.promises.getProject = sinon.stub()
          ctx.ProjectGetter.promises.getProject
            .withArgs(ctx.project_id)
            .resolves({
              overleaf: { history: { rangesSupportEnabled: true } },
              rootDoc_id: 'root-doc-id',
            })
          ctx.ProjectLocator.promises.findElementByPath = sinon
            .stub()
            .resolves({ type: 'doc', element: { _id: 'mock-file-id' } })
          ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()

          ctx.threadIds = new Map([
            ['other-doc', new Set([ctx.comments[0].op.t])],
          ])
          // Comments are updated in-place. Look up threads before reverting.
          ctx.afterThreadIds = {
            // mock-file-id removed
            'other-doc': [ctx.comments[0].op.t],
            [ctx.addedFile._id]: [
              ctx.remappedComments[0].op.t,
              ctx.remappedComments[1].op.t,
            ],
          }
          ctx.data = await ctx.RestoreManager.promises._revertSingleFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname,
            ctx.threadIds,
            {
              getFile: sinon.stub().returns({
                getMetadata: sinon.stub().returns(undefined),
                getContent: sinon.stub().returns('foo\nbar\nbaz'),
                isEditable: sinon.stub().returns(true),
              }),
            },
            {
              origin: {
                kind: 'file-restore',
                path: 'foo.tex',
                timestamp: new Date(ctx.endTs).toISOString(),
                version: 42,
              },
            }
          )
        })

        it('should import the file', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ['foo', 'bar', 'baz'],
            { changes: ctx.tracked_changes, comments: ctx.remappedComments },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            }
          )
        })

        it('should add the seen thread ids to the map', function (ctx) {
          expect(nestedMapWithSetToObject(ctx.threadIds)).to.deep.equal(
            ctx.afterThreadIds
          )
        })
      })

      describe('when restored file has the same id as root doc', function () {
        beforeEach(async function (ctx) {
          ctx.ProjectGetter.promises.getProject = sinon.stub()
          ctx.ProjectGetter.promises.getProject
            .withArgs(ctx.project_id)
            .resolves({
              overleaf: { history: { rangesSupportEnabled: true } },
              rootDoc_id: 'root-doc-id',
            })
          ctx.ProjectLocator.promises.findElementByPath = sinon
            .stub()
            .resolves({ type: 'doc', element: { _id: 'root-doc-id' } })
          ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()
          ctx.EditorController.promises.addDocWithRanges = sinon
            .stub()
            .resolves((ctx.addedFile = { _id: 'new-doc-id', type: 'doc' }))
          ctx.EditorController.promises.setRootDoc = sinon.stub().resolves()

          ctx.data = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should delete the existing root document', async function (ctx) {
          expect(
            ctx.EditorController.promises.deleteEntity
          ).to.have.been.calledWith(
            ctx.project_id,
            'root-doc-id',
            'doc',
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            },
            ctx.user_id
          )
        })

        it('should import the file', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'foo.tex',
            ['foo', 'bar', 'baz'],
            { changes: ctx.tracked_changes, comments: ctx.remappedComments },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            }
          )
        })

        it('should return the created entity with root doc id', function (ctx) {
          expect(ctx.data).to.deep.equal(ctx.addedFile)
          expect(ctx.data._id).to.equal('new-doc-id')
        })

        it('should set the restored document as the new root doc', function (ctx) {
          expect(
            ctx.EditorController.promises.setRootDoc
          ).to.have.been.calledWith(ctx.project_id, ctx.addedFile._id)
        })
      })
    })

    describe('reverting a file or document with metadata', function () {
      beforeEach(function (ctx) {
        ctx.ProjectLocator.promises.findElementByPath = sinon.stub().rejects()
        ctx.EditorController.promises.addDocWithRanges = sinon.stub()
        ctx.RestoreManager.promises._getUpdatesFromHistory = sinon
          .stub()
          .resolves([
            { toV: ctx.version, meta: { end_ts: (ctx.endTs = new Date()) } },
          ])

        ctx.EditorController.promises.upsertFile = sinon
          .stub()
          .resolves({ _id: 'mock-file-id', type: 'file' })
        ctx.EditorController.promises.addDocWithRanges = sinon
          .stub()
          .resolves((ctx.addedFile = { _id: 'mock-doc-id', type: 'doc' }))

        ctx.DocstoreManager.promises.getCommentThreadIds = sinon
          .stub()
          .resolves({})
        ctx.ChatApiHandler.promises.generateThreadData = sinon
          .stub()
          .resolves({})
        ctx.ChatManager.promises.injectUserInfoIntoThreads = sinon
          .stub()
          .resolves({})
        ctx.EditorRealTimeController.emitToRoom = sinon.stub()
      })

      describe('when reverting a linked file', function () {
        beforeEach(async function (ctx) {
          ctx.pathname = 'foo.png'
          ctx.result = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should revert it as a file', function (ctx) {
          expect(ctx.result).to.deep.equal({
            _id: 'mock-file-id',
            type: 'file',
          })
        })

        it('should upload to the project as a file', function (ctx) {
          expect(
            ctx.EditorController.promises.upsertFile
          ).to.have.been.calledWith(
            ctx.project_id,
            'mock-folder-id',
            'foo.png',
            ctx.fsPath,
            { provider: 'bar' },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            },
            ctx.user_id
          )
        })

        it('should not try to add a document', function (ctx) {
          expect(ctx.EditorController.promises.addDocWithRanges).to.not.have
            .been.called
        })
      })

      describe('when reverting a linked document with provider', function () {
        beforeEach(async function (ctx) {
          ctx.pathname = 'linkedFile.bib'
          ctx.result = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should revert it as a file', function (ctx) {
          expect(ctx.result).to.deep.equal({
            _id: 'mock-file-id',
            type: 'file',
          })
        })

        it('should upload to the project as a file', function (ctx) {
          expect(
            ctx.EditorController.promises.upsertFile
          ).to.have.been.calledWith(
            ctx.project_id,
            'mock-folder-id',
            'linkedFile.bib',
            ctx.fsPath,
            { provider: 'mendeley' },
            {
              kind: 'file-restore',
              path: ctx.pathname,
              version: ctx.version,
              timestamp: new Date(ctx.endTs).toISOString(),
            },
            ctx.user_id
          )
        })

        it('should not try to add a document', function (ctx) {
          expect(ctx.EditorController.promises.addDocWithRanges).to.not.have
            .been.called
        })
      })

      describe('when reverting a linked document with { main: true }', function () {
        beforeEach(async function (ctx) {
          ctx.pathname = 'withMainTrue.tex'
          ctx.result = await ctx.RestoreManager.promises.revertFile(
            ctx.user_id,
            ctx.project_id,
            ctx.version,
            ctx.pathname
          )
        })

        it('should revert it as a document', function (ctx) {
          expect(ctx.result).to.deep.equal({
            _id: 'mock-doc-id',
            type: 'doc',
          })
        })

        it('should not upload to the project as a file', function (ctx) {
          expect(ctx.EditorController.promises.upsertFile).to.not.have.been
            .called
        })

        it('should add the document', function (ctx) {
          expect(
            ctx.EditorController.promises.addDocWithRanges
          ).to.have.been.calledWith(
            ctx.project_id,
            ctx.folder_id,
            'withMainTrue.tex',
            ['foo', 'bar', 'baz'],
            { changes: [], comments: [] }
          )
        })
      })
    })

    describe('when reverting a binary file', function () {
      beforeEach(async function (ctx) {
        ctx.pathname = 'foo.png'
        ctx.EditorController.promises.upsertFile = sinon
          .stub()
          .resolves({ _id: 'mock-file-id', type: 'file' })
        ctx.EditorController.promises.deleteEntity = sinon.stub().resolves()
        ctx.RestoreManager.promises._getUpdatesFromHistory = sinon
          .stub()
          .resolves([{ toV: ctx.version, meta: { end_ts: Date.now() } }])
      })

      it('should return the created entity if file exists', async function (ctx) {
        ctx.ProjectLocator.promises.findElementByPath = sinon
          .stub()
          .resolves({ type: 'file', element: { _id: 'existing-file-id' } })

        const revertRes = await ctx.RestoreManager.promises.revertFile(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          ctx.pathname
        )

        expect(revertRes).to.deep.equal({ _id: 'mock-file-id', type: 'file' })
      })

      it('should return the created entity if file does not exists', async function (ctx) {
        ctx.ProjectLocator.promises.findElementByPath = sinon.stub().rejects()

        const revertRes = await ctx.RestoreManager.promises.revertFile(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          ctx.pathname
        )

        expect(revertRes).to.deep.equal({ _id: 'mock-file-id', type: 'file' })
      })
    })
  })

  describe('revertProject', function () {
    beforeEach(function (ctx) {
      ctx.ProjectGetter.promises.getProject = sinon.stub()
      ctx.ProjectGetter.promises.getProject
        .withArgs(ctx.project_id)
        .resolves({ overleaf: { history: { rangesSupportEnabled: true } } })
      ctx.RestoreManager.promises._revertSingleFile = sinon.stub().resolves({
        _id: 'mock-doc-id',
        type: 'doc',
      })
      ctx.RestoreManager.promises._getProjectPathsAtVersion = sinon
        .stub()
        .resolves([])
      ctx.ProjectEntityHandler.promises.getAllEntities = sinon
        .stub()
        .resolves({ docs: [], files: [], folders: [] })
      ctx.EditorController.promises.deleteEntityWithPath = sinon
        .stub()
        .resolves()
      ctx.RestoreManager.promises._getUpdatesFromHistory = sinon
        .stub()
        .resolves([
          { toV: ctx.version, meta: { end_ts: (ctx.end_ts = Date.now()) } },
        ])
    })

    describe('reverting a project without ranges support', function () {
      beforeEach(function (ctx) {
        ctx.ProjectGetter.promises.getProject = sinon.stub().resolves({
          overleaf: { history: { rangesSupportEnabled: false } },
        })
      })

      it('should throw an error', async function (ctx) {
        await expect(
          ctx.RestoreManager.promises.revertProject(
            ctx.user_id,
            ctx.project_id,
            ctx.version
          )
        ).to.eventually.be.rejectedWith('project does not have ranges support')
      })
    })

    for (const { description, historicalPaths, liveBlockers } of [
      {
        description: 'a live folder occupies a historical file path',
        historicalPaths: ['target.tex'],
        liveBlockers: { folders: [{ path: '/Target.tex' }] },
      },
      {
        description: 'a live document obstructs a historical parent folder',
        historicalPaths: ['chapters/old/note.tex'],
        liveBlockers: { docs: [{ path: '/Chapters' }] },
      },
      {
        description:
          'a live ancestor differs from the historical path only in case',
        historicalPaths: ['Figures/plots/note.tex'],
        liveBlockers: {
          docs: [{ path: '/figures/plots/note.tex' }],
          folders: [
            { path: '/' },
            { path: '/figures' },
            { path: '/figures/plots' },
          ],
        },
      },
      {
        description:
          'the live files contain ambiguous aliases for a historical file',
        historicalPaths: ['note.tex'],
        liveBlockers: {
          docs: [{ path: '/note.tex' }],
          files: [{ path: '/Note.tex' }],
        },
      },
      {
        description:
          'the live folders contain ambiguous aliases for a historical ancestor',
        historicalPaths: ['Figures/note.tex'],
        liveBlockers: { folders: [{ path: '/figures' }, { path: '/Figures' }] },
      },
      {
        description: 'the historical version has file aliases',
        historicalPaths: ['Note.tex', 'note.tex'],
      },
      {
        description: 'the historical version has folder aliases',
        historicalPaths: ['Figures/a.tex', 'figures/b.tex'],
      },
      {
        description: 'the historical version aliases a file and a folder',
        historicalPaths: ['Figures', 'figures/note.tex'],
      },
    ]) {
      it(`refuses before modifying earlier files when ${description}`, async function (ctx) {
        const file = { hash: 'abcdef1234567890abcdef1234567890abcdef12' }
        ctx.HistoryManager.promises.getContentAtVersion.resolves({
          files: Object.fromEntries(
            ['main.tex', ...historicalPaths].map(path => [path, file])
          ),
        })
        ctx.ProjectEntityHandler.promises.getAllEntities.resolves({
          docs: [],
          files: [],
          folders: [{ path: '/' }],
          ...liveBlockers,
        })

        await expect(
          ctx.RestoreManager.promises.revertProject(
            ctx.user_id,
            ctx.project_id,
            ctx.version
          )
        ).to.eventually.be.rejectedWith(
          'Some file or folder paths conflict with this version.'
        )

        expect(ctx.RestoreManager.promises._revertSingleFile).not.to.have.been
          .called
        expect(ctx.EditorController.promises.deleteEntityWithPath).not.to.have
          .been.called
        expect(ctx.DocumentUpdaterHandler.promises.flushProjectToMongo).not.to
          .have.been.called
      })
    }

    describe('for a project with overlap in current files and old files', function () {
      beforeEach(async function (ctx) {
        ctx.HistoryManager.promises.getContentAtVersion = sinon
          .stub()
          .resolves({
            files: {
              'main.tex': {
                hash: 'abcdef1234567890abcdef1234567890abcdef12',
                stringLength: 100,
                metadata: {
                  editorId: 'test-editor',
                },
              },
              'figures/image.png': {
                hash: 'abcdef1234567890abcdef1234567890abcdef12',
                stringLength: 100,
                metadata: {
                  provider: 'bar',
                },
              },
              'since-deleted.tex': {
                hash: 'abcdef1234567890abcdef1234567890abcdef12',
                stringLength: 100,
                metadata: {
                  editorId: 'test-editor',
                },
              },
            },
            timestamp: new Date().toISOString(),
          })

        const liveAfterRestore = {
          docs: [{ path: '/main.tex' }, { path: '/new-file.tex' }],
          files: [{ path: '/figures/image.png' }],
          folders: [{ path: '/' }, { path: '/figures' }],
        }
        ctx.ProjectEntityHandler.promises.getAllEntities
          .onFirstCall()
          .resolves({
            ...liveAfterRestore,
            docs: [{ path: '/Main.TEX' }, { path: '/new-file.tex' }],
          })
        ctx.ProjectEntityHandler.promises.getAllEntities
          .onSecondCall()
          .resolves(liveAfterRestore)

        await ctx.RestoreManager.promises.revertProject(
          ctx.user_id,
          ctx.project_id,
          ctx.version
        )
        ctx.origin = {
          kind: 'project-restore',
          version: ctx.version,
          timestamp: new Date(ctx.end_ts).toISOString(),
        }
      })

      it('should delete the old files', function (ctx) {
        expect(
          ctx.EditorController.promises.deleteEntityWithPath
        ).to.have.been.calledWith(
          ctx.project_id,
          'new-file.tex',
          ctx.origin,
          ctx.user_id
        )
      })

      it('should not delete the current files', function (ctx) {
        expect(
          ctx.EditorController.promises.deleteEntityWithPath
        ).to.not.have.been.calledWith(
          ctx.project_id,
          'main.tex',
          ctx.origin,
          ctx.user_id
        )

        expect(
          ctx.EditorController.promises.deleteEntityWithPath
        ).to.not.have.been.calledWith(
          ctx.project_id,
          'figures/image.png',
          ctx.origin,
          ctx.user_id
        )
      })

      it('should revert the old files', function (ctx) {
        expect(
          ctx.RestoreManager.promises._revertSingleFile
        ).to.have.been.calledWith(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          'main.tex'
        )

        expect(
          ctx.RestoreManager.promises._revertSingleFile
        ).to.have.been.calledWith(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          'figures/image.png'
        )

        expect(
          ctx.RestoreManager.promises._revertSingleFile
        ).to.have.been.calledWith(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          'since-deleted.tex'
        )
      })

      it('should not revert the current files', function (ctx) {
        expect(
          ctx.RestoreManager.promises._revertSingleFile
        ).to.not.have.been.calledWith(
          ctx.user_id,
          ctx.project_id,
          ctx.version,
          'new-file.tex'
        )
      })
    })
  })
})
