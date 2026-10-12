import {
  AuthIdentityStatus,
  AuthSessionRevocationReason,
  type DatabaseTransaction,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, toDbRealm, type AuthConfig, type Realm } from '../auth.config.js';
import { hashOpaqueToken, isWellFormedOpaqueToken, secureRandomToken } from '../crypto/tokens.js';
import type { AuthPrincipal } from './auth-principal.js';

export interface IssuedSession {
  /** Raw token: goes into the HttpOnly cookie only, never stored or logged. */
  token: string;
  sessionId: string;
  absoluteExpiresAt: Date;
}

export interface SessionDescription {
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Opaque, server-side sessions. Only SHA-256(token) reaches the database; a
 * session is valid while it is not revoked, not idle- or absolute-expired,
 * its authVersion matches the identity's, the identity is ACTIVE and belongs
 * to the requested realm.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async create(
    tx: DatabaseTransaction,
    identity: { id: string; authVersion: number },
    realm: Realm,
  ): Promise<IssuedSession> {
    const settings = this.config.realms[realm];
    const token = secureRandomToken();
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + settings.sessionAbsoluteMs);
    const session = await tx.authSession.create({
      data: {
        identityId: identity.id,
        tokenHash: hashOpaqueToken(token),
        authVersion: identity.authVersion,
        idleExpiresAt: new Date(
          Math.min(now + settings.sessionIdleMs, absoluteExpiresAt.getTime()),
        ),
        absoluteExpiresAt,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, absoluteExpiresAt };
  }

  /**
   * Resolves a cookie token to a principal, or null when it is not a valid
   * session for this realm. Database errors propagate (fail closed: the
   * request errors instead of being treated as authenticated).
   */
  async authenticate(realm: Realm, token: string | undefined): Promise<AuthPrincipal | null> {
    if (!isWellFormedOpaqueToken(token)) return null;

    const session = await this.database.client.authSession.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        identityId: true,
        authVersion: true,
        revokedAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        identity: { select: { realm: true, status: true, authVersion: true } },
      },
    });
    const now = new Date();
    if (
      !session ||
      session.revokedAt !== null ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.identity.realm !== toDbRealm(realm) ||
      session.identity.status !== AuthIdentityStatus.ACTIVE ||
      session.identity.authVersion !== session.authVersion
    ) {
      return null;
    }

    await this.touch(session.id, session.lastSeenAt, session.absoluteExpiresAt, realm, now);
    return { identityId: session.identityId, realm, sessionId: session.id };
  }

  /**
   * Slides the idle expiry, but writes at most once per touch interval so a
   * busy session does not update its row on every request.
   */
  private async touch(
    sessionId: string,
    lastSeenAt: Date,
    absoluteExpiresAt: Date,
    realm: Realm,
    now: Date,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - this.config.sessionTouchIntervalMs);
    if (lastSeenAt > threshold) return;
    const idle = now.getTime() + this.config.realms[realm].sessionIdleMs;
    await this.database.client.authSession.updateMany({
      where: { id: sessionId, lastSeenAt: { lte: threshold }, revokedAt: null },
      data: {
        lastSeenAt: now,
        idleExpiresAt: new Date(Math.min(idle, absoluteExpiresAt.getTime())),
      },
    });
  }

  async describe(sessionId: string): Promise<SessionDescription | null> {
    return this.database.client.authSession.findUnique({
      where: { id: sessionId },
      select: { createdAt: true, idleExpiresAt: true, absoluteExpiresAt: true },
    });
  }

  /** Idempotent: revoking an already revoked session changes nothing. */
  async revoke(sessionId: string, reason: AuthSessionRevocationReason): Promise<boolean> {
    const result = await this.database.client.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    return result.count === 1;
  }

  /**
   * Revokes every session of an identity and bumps its authVersion, so even
   * a session created concurrently with an old version cannot be used.
   */
  async revokeAllForIdentity(
    tx: DatabaseTransaction,
    identityId: string,
    reason: AuthSessionRevocationReason,
  ): Promise<{ authVersion: number }> {
    await tx.authSession.updateMany({
      where: { identityId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    return tx.authIdentity.update({
      where: { id: identityId },
      data: { authVersion: { increment: 1 } },
      select: { authVersion: true },
    });
  }
}
