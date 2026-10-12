import type { Realm } from '../auth.config.js';

/**
 * The authenticated caller, as established by a valid server-side session.
 * Deliberately minimal: authorization (roles, permissions) arrives in PR-03
 * and will build on this principal.
 */
export interface AuthPrincipal {
  identityId: string;
  realm: Realm;
  sessionId: string;
}
