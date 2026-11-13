import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestFailedError } from '@overleaf/fetch-utils'

const mocks = vi.hoisted(() => ({
  getLoggedInUserId: vi.fn(),
  getRequestToken: vi.fn(),
  canUserWriteProjectContent: vi.fn(),
  canUserWriteOrReviewProjectContent: vi.fn(),
  getThreadMessage: vi.fn(),
  deleteMessage: vi.fn(),
  deleteUserMessage: vi.fn(),
  emitToRoom: vi.fn(),
}))

vi.mock('../../../../../app/src/Features/Chat/ChatApiHandler.mjs', () => ({
  default: { promises: mocks },
}))
vi.mock(
  '../../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({ default: mocks })
)
vi.mock(
  '../../../../../app/src/Features/TokenAccess/TokenAccessHandler.mjs',
  () => ({ default: mocks })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
  () => ({ default: { promises: mocks } })
)
vi.mock(
  '../../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
  () => ({ default: mocks })
)
vi.mock('../../../../../app/src/Features/Chat/ChatManager.mjs', () => ({
  default: {},
}))
vi.mock('../../../../../app/src/Features/User/UserInfoManager.mjs', () => ({
  default: {},
}))
vi.mock('../../../../../app/src/Features/User/UserInfoController.mjs', () => ({
  default: {},
}))
vi.mock('../../../../../app/src/Features/Docstore/DocstoreManager.mjs', () => ({
  default: {},
}))
vi.mock(
  '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
  () => ({ default: {} })
)
vi.mock(
  '../../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs',
  () => ({ default: {} })
)
vi.mock('../../../../../app/src/models/Project.mjs', () => ({ Project: {} }))

import TrackChangesController from '../../../app/src/TrackChangesController.mjs'

const projectId = '111111111111111111111111'
const threadId = '222222222222222222222222'
const messageId = '333333333333333333333333'
const reviewerId = '444444444444444444444444'
const otherId = '555555555555555555555555'

function request() {
  return {
    params: {
      project_id: projectId,
      thread_id: threadId,
      message_id: messageId,
    },
    session: {},
  }
}

async function remove(req = request()) {
  const res = { sendStatus: vi.fn() }
  const next = vi.fn()
  await TrackChangesController.deleteMessage(req, res, next)
  return { res, next }
}

function expectNoMutation() {
  expect(mocks.deleteMessage).not.toHaveBeenCalled()
  expect(mocks.deleteUserMessage).not.toHaveBeenCalled()
  expect(mocks.emitToRoom).not.toHaveBeenCalled()
}

describe('review comment deletion authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getLoggedInUserId.mockReturnValue(reviewerId)
    mocks.getRequestToken.mockReturnValue('project-token')
    mocks.canUserWriteProjectContent.mockResolvedValue(false)
    mocks.canUserWriteOrReviewProjectContent.mockResolvedValue(true)
    mocks.getThreadMessage.mockResolvedValue({
      id: messageId,
      user_id: reviewerId,
    })
  })

  it('forbids a reviewer deleting another author’s comment before any delete', async () => {
    mocks.getThreadMessage.mockResolvedValue({
      id: messageId,
      user_id: otherId,
    })
    const { res, next } = await remove()
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
    expectNoMutation()
  })

  it('deletes an own comment through the atomic author-scoped endpoint', async () => {
    const { res } = await remove()
    expect(mocks.getThreadMessage).toHaveBeenCalledWith(
      projectId,
      threadId,
      messageId
    )
    expect(mocks.deleteUserMessage).toHaveBeenCalledWith(
      projectId,
      threadId,
      reviewerId,
      messageId
    )
    expect(mocks.deleteMessage).not.toHaveBeenCalled()
    expect(res.sendStatus).toHaveBeenCalledWith(204)
    expect(mocks.emitToRoom).toHaveBeenCalledWith(
      projectId,
      'delete-message',
      threadId,
      messageId
    )
  })

  for (const role of ['writer', 'owner']) {
    it(`preserves ${role} deletion of another author’s comment`, async () => {
      mocks.canUserWriteProjectContent.mockResolvedValue(true)
      mocks.getThreadMessage.mockResolvedValue({
        id: messageId,
        user_id: otherId,
      })
      const { res } = await remove()
      expect(mocks.deleteMessage).toHaveBeenCalledWith(
        projectId,
        threadId,
        messageId
      )
      expect(mocks.deleteUserMessage).not.toHaveBeenCalled()
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  }

  for (const role of ['read-only', 'outsider']) {
    it(`forbids a ${role} user even for an own comment`, async () => {
      mocks.canUserWriteOrReviewProjectContent.mockResolvedValue(false)
      const { res } = await remove()
      expect(res.sendStatus).toHaveBeenCalledWith(403)
      expect(mocks.getThreadMessage).not.toHaveBeenCalled()
      expectNoMutation()
    })
  }

  it('forbids anonymous actors even with write access', async () => {
    mocks.getLoggedInUserId.mockReturnValue(undefined)
    mocks.canUserWriteProjectContent.mockResolvedValue(true)
    const { res } = await remove()
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expectNoMutation()
  })

  for (const field of ['project_id', 'thread_id', 'message_id']) {
    it(`rejects malformed ${field} before backend access`, async () => {
      const req = request()
      req.params[field] = '../other-project'
      const { res } = await remove(req)
      expect(res.sendStatus).toHaveBeenCalledWith(400)
      expect(mocks.getThreadMessage).not.toHaveBeenCalled()
      expectNoMutation()
    })
  }

  for (const [scope, field] of [
    ['unknown message', 'message_id'],
    ['different project', 'project_id'],
    ['different thread', 'thread_id'],
  ]) {
    it(`denies ${scope} without deletion or a websocket event`, async () => {
      const error = new Error('scoped message not found')
      const req = request()
      req.params[field] = '666666666666666666666666'
      mocks.getThreadMessage.mockRejectedValue(error)
      const { next } = await remove(req)
      expect(mocks.getThreadMessage).toHaveBeenCalledWith(
        req.params.project_id,
        req.params.thread_id,
        req.params.message_id
      )
      expect(next).toHaveBeenCalledWith(error)
      expectNoMutation()
    })
  }

  for (const message of [null, {}, { id: otherId }, { id: messageId }]) {
    it(`fails closed for incomplete or mismatched backend message ${JSON.stringify(message)}`, async () => {
      mocks.getThreadMessage.mockResolvedValue(message)
      const { res } = await remove()
      expect(res.sendStatus).toHaveBeenCalledWith(
        message?.id === messageId ? 403 : 404
      )
      expectNoMutation()
    })
  }

  it('does not read or mutate comments before project authorization completes', async () => {
    let complete
    mocks.canUserWriteOrReviewProjectContent.mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    const pending = remove()
    await vi.waitFor(() =>
      expect(mocks.canUserWriteOrReviewProjectContent).toHaveBeenCalledWith(
        reviewerId,
        projectId,
        'project-token'
      )
    )
    expect(mocks.getThreadMessage).not.toHaveBeenCalled()
    expectNoMutation()
    complete(false)
    const { res } = await pending
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expectNoMutation()
  })

  it('returns 404 for an absent scoped message reported by the chat service', async () => {
    const error = new RequestFailedError(
      'http://chat/project/thread/message',
      {},
      new Response(null, { status: 404 }),
      null
    )
    mocks.getThreadMessage.mockRejectedValue(error)
    const { res, next } = await remove()
    expect(res.sendStatus).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
    expectNoMutation()
  })

  it('emits no event and sends no success before the author-scoped deletion completes', async () => {
    let complete
    mocks.deleteUserMessage.mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    const pending = remove()
    await vi.waitFor(() => expect(mocks.deleteUserMessage).toHaveBeenCalled())
    expect(mocks.emitToRoom).not.toHaveBeenCalled()
    complete()
    const { res } = await pending
    expect(res.sendStatus).toHaveBeenCalledWith(204)
  })

  it('propagates deletion failures without announcing a deletion', async () => {
    const error = new Error('backend unavailable')
    mocks.deleteUserMessage.mockRejectedValue(error)
    const { res, next } = await remove()
    expect(next).toHaveBeenCalledWith(error)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(mocks.emitToRoom).not.toHaveBeenCalled()
  })
})
