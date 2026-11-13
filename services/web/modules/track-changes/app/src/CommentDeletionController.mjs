// @ts-check

import { RequestFailedError } from '@overleaf/fetch-utils'

import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import TokenAccessHandler from '../../../../app/src/Features/TokenAccess/TokenAccessHandler.mjs'

/** @param {unknown} value */
function isObjectId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value)
}

/**
 * Delete only a message in the requested project and thread. Reviewers use the
 * author-scoped backend delete as well as the ownership check: the delete must
 * remain conditional on ownership even if the message changes after the read.
 *
 * @param {import('express').Request<{project_id: string, thread_id: string, message_id: string}> & {session?: unknown}} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function deleteComment(req, res, next) {
  try {
    const {
      project_id: projectId,
      thread_id: threadId,
      message_id: messageId,
    } = req.params
    if (![projectId, threadId, messageId].every(isObjectId)) {
      res.sendStatus(400)
      return
    }
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!isObjectId(userId)) {
      res.sendStatus(403)
      return
    }
    const token = TokenAccessHandler.getRequestToken(req, projectId)
    const canWrite =
      await AuthorizationManager.promises.canUserWriteProjectContent(
        userId,
        projectId,
        token
      )
    if (
      !canWrite &&
      !(await AuthorizationManager.promises.canUserWriteOrReviewProjectContent(
        userId,
        projectId,
        token
      ))
    ) {
      res.sendStatus(403)
      return
    }

    // This read uses findThread, not findOrCreateThread, and binds both IDs.
    // Missing threads/messages therefore cannot cause a delete or an event.
    /** @type {unknown} */
    const message = await ChatApiHandler.promises.getThreadMessage(
      projectId,
      threadId,
      messageId
    )
    if (
      !message ||
      typeof message !== 'object' ||
      !('id' in message) ||
      message.id !== messageId
    ) {
      res.sendStatus(404)
      return
    }
    if (canWrite) {
      await ChatApiHandler.promises.deleteMessage(
        projectId,
        threadId,
        messageId
      )
    } else {
      if (!('user_id' in message) || message.user_id !== userId) {
        res.sendStatus(403)
        return
      }
      await ChatApiHandler.promises.deleteUserMessage(
        projectId,
        threadId,
        userId,
        messageId
      )
    }
    EditorRealTimeController.emitToRoom(
      projectId,
      'delete-message',
      threadId,
      messageId
    )
    res.sendStatus(204)
  } catch (error) {
    if (error instanceof RequestFailedError && error.response.status === 404) {
      res.sendStatus(404)
      return
    }
    next(error)
  }
}
