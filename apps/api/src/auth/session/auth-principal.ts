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

/**
 * An operator command run outside HTTP, such as the pilot data bootstrap.
 * It has no identity and no session: its audit events carry a null actor
 * and record `source` in their metadata (`systemActor`).
 */
export interface SystemActor {
  readonly kind: 'system';
  readonly source: string;
}

/** Who performs a domain mutation: an authenticated caller or an operator command. */
export type Actor = AuthPrincipal | SystemActor;

export function isSystemActor(actor: Actor): actor is SystemActor {
  return 'kind' in actor && actor.kind === 'system';
}

/** The identity recorded as author of a change: none for an operator command. */
export function actorIdentityId(actor: Actor): string | null {
  return isSystemActor(actor) ? null : actor.identityId;
}
