import type { AuthSessionRevocationReason } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AuthErrors } from '../http/public-api-error.js';
import type { AuthPrincipal } from '../session/auth-principal.js';
import { SessionService } from '../session/session.service.js';

/** Identity reads and identity-wide actions for an authenticated principal. */
@Injectable()
export class IdentityQueries {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  /** Minimal identity view: never hashes, secrets or tokens. */
  async me(principal: AuthPrincipal) {
    const identity = await this.database.client.authIdentity.findUnique({
      where: { id: principal.identityId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!identity) throw AuthErrors.unauthenticated();
    return {
      id: identity.id,
      realm: principal.realm,
      email: identity.email,
      emailVerified: identity.emailVerifiedAt !== null,
    };
  }

  async revokeAllSessions(
    principal: AuthPrincipal,
    reason: AuthSessionRevocationReason,
  ): Promise<void> {
    await this.database.client.$transaction((tx) =>
      this.sessions.revokeAllForIdentity(tx, principal.identityId, reason),
    );
  }
}
