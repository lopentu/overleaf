// @ts-check
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import OError from '@overleaf/o-error'
import { fetchString } from '@overleaf/fetch-utils'
import OAuth from 'oauth-1.0a'
import crypto from 'crypto'
import { getRequestErrorInfo } from './ZoteroRequestError.mjs'

const ZOTERO_OAUTH_URL = 'https://www.zotero.org/oauth'
const REQUEST_TIMEOUT_MS = 60 * 1000

/** @param {string} baseString @param {string} key */
function hashFunctionSha1(baseString, key) {
  return crypto.createHmac('sha1', key).update(baseString).digest('base64')
}

function createOAuthClient() {
  return new OAuth({
    consumer: {
      key: Settings.zotero.clientKey,
      secret: Settings.zotero.clientSecret,
    },
    signature_method: 'HMAC-SHA1',
    hash_function: hashFunctionSha1,
  })
}

/**
 * @param {import('oauth-1.0a').RequestOptions} requestData
 * @param {import('oauth-1.0a').Token} [tokenData]
 */
function buildAuthorizationHeader(requestData, tokenData) {
  const oauth = createOAuthClient()
  const authData = oauth.authorize(requestData, tokenData)

  return oauth.toHeader(authData).Authorization
}

/** @param {string} body @param {string[]} requiredFields */
function parseOAuthResponse(body, requiredFields) {
  const data = Object.fromEntries(new URLSearchParams(body).entries())
  if (requiredFields.some(field => !data[field]?.trim())) {
    throw new OError('Invalid Zotero OAuth response')
  }
  return data
}

/** @param {string} oauthToken */
function getAuthorizationUrl(oauthToken) {
  const params = new URLSearchParams({
    oauth_token: oauthToken,
    library_access: '1',
    all_groups: 'read',
  })

  return `${ZOTERO_OAUTH_URL}/authorize?${params}`
}

async function getRequestToken() {
  const url = `${ZOTERO_OAUTH_URL}/request`

  try {
    const body = await fetchString(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: buildAuthorizationHeader({
          url,
          method: 'POST',
          data: {
            oauth_callback: Settings.zotero.callbackURL,
          },
        }),
      },
    })

    return parseOAuthResponse(body, ['oauth_token', 'oauth_token_secret'])
  } catch (err) {
    const info = getRequestErrorInfo(err, 'getRequestToken')
    logger.error(info, 'error obtaining Zotero request token')
    throw new OError('error obtaining Zotero request token', info)
  }
}

/**
 * @param {string} oauthToken
 * @param {string} oauthTokenSecret
 * @param {string} oauthVerifier
 */
async function exchangeRequestTokenForAccessToken(
  oauthToken,
  oauthTokenSecret,
  oauthVerifier
) {
  const url = `${ZOTERO_OAUTH_URL}/access`

  try {
    const body = await fetchString(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: buildAuthorizationHeader(
          {
            url,
            method: 'POST',
            data: {
              oauth_verifier: oauthVerifier,
            },
          },
          {
            key: oauthToken,
            secret: oauthTokenSecret,
          }
        ),
      },
    })

    const data = parseOAuthResponse(body, ['oauth_token', 'userID'])
    if (!/^\d+$/.test(data.userID)) {
      throw new OError('Invalid Zotero user ID in OAuth response')
    }

    return {
      accessToken: data.oauth_token,
      zoteroUserId: data.userID,
    }
  } catch (err) {
    const info = getRequestErrorInfo(err, 'exchangeRequestTokenForAccessToken')
    logger.error(info, 'error obtaining Zotero access token')
    throw new OError('error obtaining Zotero access token', info)
  }
}

export default {
  getAuthorizationUrl,
  getRequestToken,
  exchangeRequestTokenForAccessToken,
}
