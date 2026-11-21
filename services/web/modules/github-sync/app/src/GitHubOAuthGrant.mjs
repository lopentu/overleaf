// @ts-check
import { z } from 'zod'

const token = z.string().min(1)
const seconds = z.number().int().positive()

export const storedGrant = z.object({
  accessToken: token,
  refreshToken: token,
  accessExpiresAt: seconds,
  refreshExpiresAt: seconds,
})

/** @typedef {z.infer<typeof storedGrant>} OAuthGrant */

const tokenResponse = z.object({
  access_token: token,
  refresh_token: token.optional(),
  expires_in: seconds.optional(),
  refresh_token_expires_in: seconds.optional(),
})

/**
 * Older GitHub installations can return long-lived tokens. A partial expiring
 * grant is unusable and must never replace a working credential.
 * @param {unknown} response
 * @returns {string | OAuthGrant | null}
 */
export function parseTokenResponse(response) {
  const result = tokenResponse.safeParse(response)
  if (!result.success) return null

  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: accessLifetime,
    refresh_token_expires_in: refreshLifetime,
  } = result.data
  if (!refreshToken && !accessLifetime && !refreshLifetime) return accessToken
  if (!refreshToken || !accessLifetime || !refreshLifetime) return null

  const now = Date.now()
  const accessExpiresAt = now + accessLifetime * 1000
  const refreshExpiresAt = now + refreshLifetime * 1000
  if (
    !Number.isSafeInteger(accessExpiresAt) ||
    !Number.isSafeInteger(refreshExpiresAt)
  ) {
    return null
  }
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}
