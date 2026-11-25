// @ts-check

import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { Project } from '../../../../app/src/models/Project.mjs'
import Handler from '../../../../app/src/Features/Project/ProjectEntityMongoUpdateHandler.mjs'

vi.mock('../../../../app/src/infrastructure/Mongoose.mjs', async () => {
  const { default: mongoose } = await import('mongoose')
  return { default: new mongoose.Mongoose() }
})
vi.mock('../../../../app/src/infrastructure/LockManager.mjs', () => ({
  default: {},
}))
vi.mock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: {},
}))
vi.mock(
  '../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
  () => ({
    default: {},
  })
)

const { ObjectId } = mongoose.Types
const owner = {
  projectId: '507f1f77bcf86cd799439001',
  docId: '507f1f77bcf86cd799439002',
  operationId: '92788a13-507e-4311-b3fd-2fe27a554cf6',
  version: 42,
}
const intent = {
  ...owner,
  folderId: '507f1f77bcf86cd799439003',
  path: '/Figures/Chapters/figure.tex',
  baseStructureVersion: 7,
  userId: '507f1f77bcf86cd799439004',
}
const otherDoc = new ObjectId('507f1f77bcf86cd799439005')
const rootFolderId = new ObjectId('507f1f77bcf86cd799439006')
const parentFolderId = new ObjectId('507f1f77bcf86cd799439007')
const secondOperation = '811d9b8b-e861-4fbc-873b-9bbb626455eb'
const operationPath = `documentRetirements.${owner.operationId}`
const folderPath = 'rootFolder.0.folders.0.folders.0'
const docPath = `${folderPath}.docs.1`
const deletedAt = new Date('2026-11-21T10:10:00Z')
const {
  prepareDocumentRetirement,
  readDocumentRetirement,
  commitDocumentRetirement,
  commitDocumentReplacement,
  abortDocumentRetirement,
} = Handler.promises

function preparedRecord(
  baseStructureVersion = /** @type {number | null} */ (7)
) {
  return {
    phase: 'prepared',
    editorVersion: owner.version,
    docId: new ObjectId(owner.docId),
    folderId: new ObjectId(intent.folderId),
    path: intent.path,
    baseStructureVersion,
    userId: new ObjectId(intent.userId),
  }
}

function projectFixture() {
  return {
    _id: new ObjectId(owner.projectId),
    version: /** @type {number | undefined} */ (7),
    rootDoc_id: new ObjectId(owner.docId),
    mainBibliographyDoc_id: otherDoc,
    rootFolder: [
      {
        _id: rootFolderId,
        name: 'root',
        folders: [
          {
            _id: parentFolderId,
            name: 'Figures',
            folders: [
              {
                _id: new ObjectId(intent.folderId),
                name: 'Chapters',
                docs: [
                  { _id: otherDoc, name: 'sibling.tex' },
                  { _id: new ObjectId(owner.docId), name: 'figure.tex' },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/** @param {ReturnType<typeof projectFixture>} [project] @param {ReturnType<typeof preparedRecord>} [record] */
function withPrepared(project = projectFixture(), record = preparedRecord()) {
  return {
    ...project,
    activeDocumentRetirement: owner.operationId,
    documentRetirements: { [owner.operationId]: record },
  }
}

function withCommitted() {
  return {
    ...projectFixture(),
    version: 8,
    activeDocumentRetirement: owner.operationId,
    documentRetirements: {
      [owner.operationId]: {
        ...preparedRecord(),
        phase: 'committed',
        committedStructureVersion: 8,
        deletedAt,
      },
    },
  }
}

function stubCollection() {
  return {
    read: vi.spyOn(Project.collection, 'findOne'),
    write: vi.spyOn(Project.collection, 'findOneAndUpdate'),
  }
}

describe('Web project document retirement persistence', function () {
  beforeEach(() => vi.restoreAllMocks())

  it('commits the sealed document replacement with the original Git blob and file identity', async function () {
    const { read, write } = stubCollection()
    const replacement = {
      sourceCommit: 'a'.repeat(40),
      hash: 'b'.repeat(40),
      fileId: '507f1f77bcf86cd799439008',
      name: 'figure.tex',
      created: deletedAt,
    }
    const stored = { ...replacement, fileId: new ObjectId(replacement.fileId) }
    const preparedReplacement = {
      ...preparedRecord(),
      replacement: stored,
    }
    const prepared = withPrepared(projectFixture(), preparedReplacement)
    const committed = withCommitted()
    const committedReplacement = {
      ...committed,
      documentRetirements: {
        [owner.operationId]: {
          ...committed.documentRetirements[owner.operationId],
          replacement: stored,
        },
      },
    }
    read
      .mockResolvedValueOnce(projectFixture())
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(committedReplacement)
    write
      .mockResolvedValueOnce(prepared)
      .mockRejectedValueOnce(new Error('synthetic lost replacement reply'))

    expect(
      await prepareDocumentRetirement({ ...intent, replacement })
    ).toMatchObject({
      status: 'prepared',
      retirement: { replacement },
    })
    expect(
      await prepareDocumentRetirement({
        ...intent,
        replacement: {
          ...replacement,
          fileId: otherDoc.toHexString(),
        },
      })
    ).toMatchObject({ status: 'prepared', retirement: { replacement } })
    expect(
      await prepareDocumentRetirement({
        ...intent,
        replacement: {
          ...replacement,
          sourceCommit: 'c'.repeat(40),
        },
      })
    ).toEqual({ status: 'conflict' })
    expect(await commitDocumentRetirement(owner, owner)).toEqual({
      status: 'conflict',
    })
    expect(
      await commitDocumentReplacement(owner, { ...owner, version: 43 })
    ).toEqual({ status: 'conflict' })
    expect(
      await commitDocumentReplacement(owner, owner, deletedAt)
    ).toMatchObject({
      status: 'committed',
      retirement: { replacement, committedStructureVersion: 8 },
    })

    expect(write).toHaveBeenCalledTimes(2)
    const [filter, update] = write.mock.calls[1]
    expect(filter).toMatchObject({
      version: 7,
      activeDocumentRetirement: owner.operationId,
      [`${operationPath}.phase`]: 'prepared',
      [`${operationPath}.replacement.fileId`]: stored.fileId,
      [`${operationPath}.replacement.sourceCommit`]: replacement.sourceCommit,
      [`${folderPath}.fileRefs.name`]: { $ne: replacement.name },
    })
    expect(JSON.parse(JSON.stringify(update))).toMatchObject({
      $pull: { [`${folderPath}.docs`]: { _id: owner.docId } },
      $push: {
        [`${folderPath}.fileRefs`]: {
          _id: replacement.fileId,
          name: replacement.name,
          hash: replacement.hash,
          rev: 0,
          created: replacement.created.toISOString(),
        },
      },
      $inc: { version: 1 },
      $set: { [`${operationPath}.phase`]: 'committed' },
    })
  })

  it('records an exact prepared intent separately from the structure revision', async function () {
    const { read, write } = stubCollection()
    read.mockResolvedValueOnce(projectFixture())
    write.mockResolvedValueOnce(withPrepared())

    expect(await prepareDocumentRetirement(intent)).toMatchObject({
      status: 'prepared',
      retirement: intent,
    })
    expect(read).toHaveBeenCalledWith(
      { _id: new ObjectId(owner.projectId) },
      expect.objectContaining({
        readPreference: 'primary',
        readConcern: { level: 'majority' },
      })
    )
    expect(write).toHaveBeenCalledTimes(1)
    const [filter, update] = write.mock.calls[0]
    expect(filter).toMatchObject({
      _id: new ObjectId(owner.projectId),
      version: 7,
      [`${docPath}._id`]: new ObjectId(owner.docId),
      [`${folderPath}._id`]: new ObjectId(intent.folderId),
      [operationPath]: { $exists: false },
    })
    // Mongoose casts the map value to an embedded model before serialization.
    expect(JSON.parse(JSON.stringify(update))).toEqual({
      $set: {
        activeDocumentRetirement: owner.operationId,
        [operationPath]: {
          ...preparedRecord(),
          docId: owner.docId,
          folderId: intent.folderId,
          userId: intent.userId,
        },
      },
    })
    expect(write).toHaveBeenCalledWith(
      filter,
      update,
      expect.objectContaining({
        projection: {
          _id: 1,
          documentRetirements: 1,
          activeDocumentRetirement: 1,
        },
        writeConcern: { w: 'majority' },
        returnDocument: 'after',
      })
    )
  })

  it('recovers a prepared write with a lost reply by majority reread', async function () {
    const { read, write } = stubCollection()
    read
      .mockResolvedValueOnce(projectFixture())
      .mockResolvedValueOnce(withPrepared())
    write.mockRejectedValueOnce(new Error('simulated lost prepare reply'))

    expect(await prepareDocumentRetirement(intent)).toMatchObject({
      status: 'prepared',
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('refuses to bind a prepared operation to another actor or target', async function () {
    const { read, write } = stubCollection()
    read.mockResolvedValue(withPrepared())

    expect(
      await prepareDocumentRetirement({
        ...intent,
        userId: otherDoc.toHexString(),
      })
    ).toEqual({ status: 'conflict' })
    expect(await readDocumentRetirement({ ...owner, version: 41 })).toEqual({
      status: 'conflict',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects an unbound fence before attempting a commit', async function () {
    const { read, write } = stubCollection()
    expect(
      await commitDocumentRetirement(owner, { ...owner, version: 41 })
    ).toEqual({ status: 'conflict' })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('commits only the targeted nested document and its receipt in one majority update', async function () {
    const { read, write } = stubCollection()
    read.mockResolvedValueOnce(withPrepared())
    write.mockResolvedValueOnce(withCommitted())

    expect(
      await commitDocumentRetirement(owner, owner, deletedAt)
    ).toMatchObject({
      status: 'committed',
      retirement: { ...intent, committedStructureVersion: 8, deletedAt },
    })
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        _id: new ObjectId(owner.projectId),
        version: 7,
        [`${operationPath}.phase`]: 'prepared',
        [`${operationPath}.editorVersion`]: 42,
        [`${operationPath}.docId`]: new ObjectId(owner.docId),
        ['rootFolder.0.folders.0.name']: 'Figures',
        [`${folderPath}.name`]: 'Chapters',
        [`${docPath}._id`]: new ObjectId(owner.docId),
        [`${docPath}.name`]: 'figure.tex',
        rootDoc_id: new ObjectId(owner.docId),
        mainBibliographyDoc_id: { $ne: new ObjectId(owner.docId) },
      }),
      {
        $pull: { [`${folderPath}.docs`]: { _id: new ObjectId(owner.docId) } },
        $inc: { version: 1 },
        $set: {
          lastUpdated: deletedAt,
          lastUpdatedBy: new ObjectId(intent.userId),
          [`${operationPath}.phase`]: 'committed',
          [`${operationPath}.committedStructureVersion`]: 8,
          [`${operationPath}.deletedAt`]: deletedAt,
        },
        $unset: { rootDoc_id: 1 },
      },
      expect.objectContaining({
        writeConcern: { w: 'majority' },
        returnDocument: 'after',
      })
    )
  })

  it('refuses a replaced document and an intervening structural revision', async function () {
    const { read, write } = stubCollection()
    const changed = withPrepared()
    changed.rootFolder[0].folders[0].folders[0].docs[1]._id = new ObjectId()
    read
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(withPrepared())
      .mockResolvedValueOnce({ ...withPrepared(), version: 8 })
    write.mockResolvedValueOnce(null)

    expect(await commitDocumentRetirement(owner, owner)).toEqual({
      status: 'conflict',
    })
    expect(write).not.toHaveBeenCalled()
    expect(await commitDocumentRetirement(owner, owner)).toEqual({
      status: 'conflict',
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({ version: 7 })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reconciles a lost commit and replays it after another retirement has prepared', async function () {
    const { read, write } = stubCollection()
    const committed = withCommitted()
    const newerProject = {
      ...committed,
      version: 9,
      documentRetirements: {
        ...committed.documentRetirements,
        [secondOperation]: { ...preparedRecord(), docId: otherDoc },
      },
    }
    read
      .mockResolvedValueOnce(withPrepared())
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce(newerProject)
    write.mockRejectedValueOnce(new Error('simulated lost commit reply'))

    expect(await commitDocumentRetirement(owner, owner)).toMatchObject({
      status: 'committed',
    })
    expect(await readDocumentRetirement(owner)).toMatchObject({
      status: 'committed',
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps a lost commit with no committed receipt indeterminate', async function () {
    const { read, write } = stubCollection()
    read.mockResolvedValue(withPrepared())
    write.mockRejectedValueOnce(new Error('simulated lost commit reply'))

    expect(await commitDocumentRetirement(owner, owner)).toEqual({
      status: 'unknown',
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['committed', 'aborted'])(
    'reconciles both contestants to %s when commit and abort race',
    async function (winner) {
      const { read, write } = stubCollection()
      let project = withPrepared()
      let attempts = 0
      const bothStarted = Promise.withResolvers()
      const winnerFinished = Promise.withResolvers()
      const phaseField = `${operationPath}.phase`
      read.mockImplementation(async () => project)
      write.mockImplementation(async (filter, update) => {
        const phase = !Array.isArray(update) && update.$set?.[phaseField]
        expect(filter[phaseField]).toBe('prepared')
        if (phase === 'aborted') {
          expect(filter).toEqual({
            _id: new ObjectId(owner.projectId),
            activeDocumentRetirement: owner.operationId,
            [`${operationPath}.docId`]: new ObjectId(owner.docId),
            [`${operationPath}.editorVersion`]: owner.version,
            [phaseField]: 'prepared',
          })
          expect(update).toEqual({ $set: { [phaseField]: 'aborted' } })
        }
        if (++attempts === 2) bothStarted.resolve(undefined)
        await bothStarted.promise
        if (phase !== winner) await winnerFinished.promise
        if (
          project.documentRetirements[owner.operationId].phase !==
          filter[phaseField]
        ) {
          return null
        }
        project =
          phase === 'committed'
            ? withCommitted()
            : withPrepared(project, { ...preparedRecord(), phase: 'aborted' })
        winnerFinished.resolve(undefined)
        throw new Error('simulated lost winning reply')
      })

      const outcomes = await Promise.all([
        commitDocumentRetirement(owner, owner, deletedAt),
        abortDocumentRetirement(owner),
      ])
      expect(outcomes.map(outcome => outcome.status)).toEqual([winner, winner])
      expect((await readDocumentRetirement(owner)).status).toBe(winner)
      expect(write).toHaveBeenCalledTimes(2)
      expect(write).toHaveBeenCalledWith(
        expect.anything(),
        { $set: { [phaseField]: 'aborted' } },
        expect.objectContaining({ writeConcern: { w: 'majority' } })
      )
    }
  )

  it('distinguishes a missing legacy structure revision from zero', async function () {
    const { read, write } = stubCollection()
    const project = projectFixture()
    project.version = undefined
    read
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce({ ...project, version: 0 })
    write.mockResolvedValueOnce(withPrepared(project, preparedRecord(null)))

    expect(
      await prepareDocumentRetirement({ ...intent, baseStructureVersion: null })
    ).toMatchObject({ status: 'prepared' })
    expect(write.mock.calls[0][0]).toMatchObject({
      version: { $exists: false },
    })
    expect(
      await prepareDocumentRetirement({ ...intent, baseStructureVersion: null })
    ).toEqual({ status: 'conflict' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a missing operation from an unavailable majority read', async function () {
    const { read, write } = stubCollection()
    read
      .mockResolvedValueOnce(projectFixture())
      .mockRejectedValueOnce(new Error('simulated read failure'))

    expect(await readDocumentRetirement(owner)).toEqual({
      status: 'missing',
    })
    expect(await readDocumentRetirement(owner)).toEqual({
      status: 'unknown',
    })
    expect(write).not.toHaveBeenCalled()
  })
})
