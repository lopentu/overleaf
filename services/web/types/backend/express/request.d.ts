import 'express'
import OAuth2Server from '@node-oauth/oauth2-server'
import type SessionData from 'express-session'
import type { Capability } from '../../capabilities'
import type { MongoUser } from '../../user'

// Request-scoped logger attached by @overleaf/metrics http.monitor() middleware.
// See libraries/metrics/http.js RequestLogger class.
interface RequestLogger {
  addFields(fields: Record<string, unknown>): void
  setLevel(level: string): void
  disable(): void
}

// Add properties to Express's Request object that are defined in JS middleware
// or controllers and expected to be present in controllers.
declare module 'express' {
  interface Request {
    session: SessionData
    userRestrictions?: Set
    oauth_user?: OAuth2Server.User
    // AuthenticationController.authenticate attaches the serialized session user.
    user?: MongoUser
    logger: RequestLogger
    // Set by a body-parser `verify` callback on routes that check a webhook
    // signature, which needs the bytes exactly as received.
    rawBody?: Buffer | string
    i18n: {
      language: string
      translate(
        key: string,
        vars?: Record<string, any>,
        components?: any
      ): string
    }
    // Set by PermissionMiddleware
    managedBy?: any
    isManagedGroupAdmin?: boolean
    capabilitySet?: Set<Capability>
    assertPermission(capability: string): void
  }
}
