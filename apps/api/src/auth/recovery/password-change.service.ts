import { AuthSessionRevocationReason } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { hashPassword, verifyPassword } from '../crypto/password-hasher.js';
import { AuthErrors } from '../http/public-api-error.js';
import { AuthMailer } from '../mail/auth-mailer.js';
import { checkPasswordPolicy } from '../password/password-policy.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import type { AuthPrincipal } from '../session/auth-principal.js';
import { SessionService, type IssuedSession } from '../session/session.service.js';

/**
 * Authenticated password change. Strategy: every existing session, including
 * the current one, is revoked (authVersion is bumped); a brand-new session is
 * issued to the caller in the same transaction. No old session — and no CSRF
 * token bound to one — remains valid.
 */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: RateLimitService,
    private readonly sessions: SessionService,
    private readonly mailer: AuthMailer,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  async changePassword(
    principal: AuthPrincipal,
    currentPassword: string,
    newPassword: string,
  ): Promise<IssuedSession> {
    const subject = `identity:${principal.identityId}`;
    await this.rateLimits.assertNotExceeded(RATE_LIMITS.passwordChangeIdentity, subject);

    const identity = await this.database.client.authIdentity.findUniqueOrThrow({
      where: { id: principal.identityId },
      select: { email: true, passwordCredential: { select: { passwordHash: true } } },
    });
    const storedHash = identity.passwordCredential?.passwordHash;
    if (!storedHash || !(await verifyPassword(storedHash, currentPassword))) {
      await this.rateLimits.increment(RATE_LIMITS.passwordChangeIdentity, subject);
      throw AuthErrors.currentPasswordInvalid();
    }

    const policy = checkPasswordPolicy(newPassword, { email: identity.email });
    if (!policy.ok) throw AuthErrors.passwordPolicy(policy.message);
    const passwordHash = await hashPassword(newPassword);

    const session = await this.database.client.$transaction(async (tx) => {
      await tx.passwordCredential.update({
        where: { identityId: principal.identityId },
        data: { passwordHash },
      });
      const { authVersion } = await this.sessions.revokeAllForIdentity(
        tx,
        principal.identityId,
        AuthSessionRevocationReason.PASSWORD_CHANGED,
      );
      return this.sessions.create(tx, { id: principal.identityId, authVersion }, principal.realm);
    });

    this.securityLog.record('AUTH_PASSWORD_CHANGED', {
      realm: principal.realm,
      identityId: principal.identityId,
    });
    this.mailer.sendPasswordChanged(identity.email);
    return session;
  }
}
