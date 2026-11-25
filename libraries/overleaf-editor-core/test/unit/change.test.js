'use strict'

const { expect } = require('chai')
const FakeBlobStore = require('./support/fake_blob_store')
const { rawChange, rawStorageChange } = require('../../lib/schemas')
const {
  Change,
  Chunk,
  ChunkResponse,
  History,
  File,
  Operation,
  AddFileOperation,
  Snapshot,
  Origin,
  RestoreFileOrigin,
  TextOperation,
} = require('../..')

describe('Change', function () {
  describe('findBlobHashes', function () {
    it('finds blob hashes from operations', function () {
      const blobHashes = new Set()

      const change = Change.fromRaw({
        operations: [],
        timestamp: '2015-03-05T12:03:53.035Z',
        authors: [null],
      })

      change.findBlobHashes(blobHashes)
      expect(blobHashes.size).to.equal(0)

      // AddFile with content doesn't have a hash.
      change.pushOperation(Operation.addFile('a.txt', File.fromString('a')))
      change.findBlobHashes(blobHashes)
      expect(blobHashes.size).to.equal(0)

      // AddFile with hash should give us a hash.
      change.pushOperation(
        Operation.addFile('b.txt', File.fromHash(File.EMPTY_FILE_HASH))
      )
      change.findBlobHashes(blobHashes)
      expect(blobHashes.size).to.equal(1)
      expect(blobHashes.has(File.EMPTY_FILE_HASH)).to.be.true
    })

    it('finds blob hashes from operations with ranges', function () {
      const blobHashes = new Set()
      const fileHash = 'a5675307b61ec2517330622a6e649b4ca1ee5612'
      const rangesHash = '380de212d09bf8498065833dbf242aaf11184316'

      const change = Change.fromRaw({
        operations: [],
        timestamp: '2015-03-05T12:03:53.035Z',
        authors: [null],
      })

      // AddFile with file and ranges hashes.
      change.pushOperation(
        Operation.addFile('c.txt', File.fromHash(fileHash, rangesHash))
      )
      change.findBlobHashes(blobHashes)
      // Both file and ranges hashes should be found
      expect(blobHashes.size).to.equal(2)
      expect(blobHashes.has(fileHash)).to.be.true
      expect(blobHashes.has(rangesHash)).to.be.true
    })
  })

  describe('RestoreFileOrigin', function () {
    it('should convert to and from raw', function () {
      const origin = new RestoreFileOrigin(1, 'path', new Date())
      const raw = origin.toRaw()
      const newOrigin = Origin.fromRaw(raw)
      expect(newOrigin).to.eql(origin)
    })

    it('change should have a correct origin class', function () {
      const change = Change.fromRaw({
        operations: [],
        timestamp: '2015-03-05T12:03:53.035Z',
        authors: [null],
        origin: {
          kind: 'file-restore',
          version: 1,
          path: 'path',
          timestamp: '2015-03-05T12:03:53.035Z',
        },
      })

      expect(change.getOrigin()).to.be.an.instanceof(RestoreFileOrigin)
    })
  })

  describe('applyTo', function () {
    it('sets the timestamp on the snapshot', function () {
      const snapshot = new Snapshot()
      snapshot.addFile('main.tex', File.fromString(''))
      const operation = new AddFileOperation('main.tex', File.fromString(''))
      const now = new Date()
      const change = new Change([operation], now)
      change.applyTo(snapshot)
      expect(snapshot.getTimestamp().toISOString()).to.equal(now.toISOString())
    })
  })
})

describe('internal history publication metadata', function () {
  const raw = {
    operations: [],
    timestamp: '2015-03-05T12:03:53.035Z',
    authors: [null],
  }
  const publication = {
    historyId: '507f1f77bcf86cd799439011',
    batchId: '10000000-0000-4000-8000-000000000001',
    ordinal: 0,
    entryOrdinal: 1,
    digest: 'a'.repeat(64),
  }

  it('preserves the existing raw format for an untagged change', async function () {
    const change = Change.mustFromRaw(raw)
    expect(JSON.stringify(await change.store(new FakeBlobStore()))).to.equal(
      JSON.stringify(change.toRaw())
    )
    expect(change.toRaw()).not.to.have.property('historyPublication')
    expect(rawChange.safeParse(change.toRaw()).success).to.equal(true)
  })

  it('round-trips the exact internal identity through stored history', async function () {
    const change = Change.fromStorageRaw({
      ...raw,
      historyPublication: publication,
    })
    const history = new History(new Snapshot(), [change])
    const stored = await history.store(new FakeBlobStore())
    expect(stored.changes[0].historyPublication).to.eql(publication)
    expect(rawStorageChange.safeParse(stored.changes[0]).success).to.equal(true)
    const restored = History.fromStorageRaw(JSON.parse(JSON.stringify(stored)))
    expect(restored.getChanges()[0].getHistoryPublication()).to.eql(publication)
    expect(restored.toStorageRaw()).to.eql(history.toStorageRaw())
  })

  it('keeps internal identities out of change, chunk, and ordinary import formats', function () {
    const stored = { ...raw, historyPublication: publication }
    const change = Change.fromStorageRaw(stored)
    const response = new ChunkResponse(
      new Chunk(new History(new Snapshot(), [change]), 0)
    )
    expect(change.toRaw()).not.to.have.property('historyPublication')
    expect(JSON.stringify(change)).not.to.include(publication.batchId)
    expect(response.toRaw().chunk.history.changes[0]).to.eql(change.toRaw())
    expect(rawChange.safeParse(stored).success).to.equal(false)
    expect(Change.mustFromRaw(stored).toStorageRaw()).not.to.have.property(
      'historyPublication'
    )
  })

  it('preserves a tag across transform and reconstruction without allowing retagging', function () {
    const submitted = { ...publication }
    const change = Change.mustFromRaw(raw)
    change.setHistoryPublication(submitted)
    submitted.digest = 'b'.repeat(64)
    change.toStorageRaw().historyPublication.ordinal = 999
    const copy = change.clone()
    copy.pushOperation(
      Operation.editFile('main.tex', new TextOperation().insert('a'))
    )
    const other = Change.mustFromRaw(raw)
    other.pushOperation(
      Operation.editFile('main.tex', new TextOperation().insert('b'))
    )
    const originalOperations = copy.toRaw().operations
    copy.transformAfter(other)
    expect(copy.toRaw().operations).not.to.eql(originalOperations)
    expect(copy.toStorageRaw().historyPublication).to.eql(publication)
    expect(copy.getOperations()).to.have.length(1)
    expect(copy.getHistoryPublication()).not.to.equal(
      change.getHistoryPublication()
    )
    copy.setHistoryPublication({ ...publication })
    expect(() => copy.setHistoryPublication(submitted)).to.throw(
      'History publication identity is already set'
    )
  })

  it('rejects incomplete, out-of-range, and unrecognized receipt metadata', function () {
    for (const invalid of [
      null,
      Object.create(publication),
      { ...publication, historyId: 'not-a-history-id' },
      { ...publication, batchId: 'not-a-uuid' },
      { ...publication, ordinal: Number.MAX_SAFE_INTEGER + 1 },
      { ...publication, entryOrdinal: -1 },
      { ...publication, digest: 'a' },
      { ...publication, extra: 'must not be accepted' },
    ]) {
      const stored = { ...raw, historyPublication: invalid }
      expect(rawStorageChange.safeParse(stored).success).to.equal(false)
      expect(() => Change.fromStorageRaw(stored)).to.throw(
        'Invalid history publication metadata'
      )
    }
  })
})
