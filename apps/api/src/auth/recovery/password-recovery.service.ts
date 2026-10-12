import {
  AuthIdentityStatus,
  AuthRealm,
  AuthSessionRevocationReason,
  Prisma,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { hashPassword } from '../crypto/password-hasher.js';
import { hashOpaqueToken, isWellFormedOpaqueToken, secureRandomToken } from '../crypto/tokens.js';
import { AuthErrors } from '../http/public-api-error.js';
import { normalizeEmail } from '../identity/email.js';
import { AuthMailer } from '../mail/auth-mailer.js';
import { checkPasswordPolicy } from '../password/password-policy.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import { SessionService } from '../session/session.service.js';

/**
 * Customer password recovery ("forgot password"). Only the CUSTOMER realm is
 * exposed publicly; STAFF and CREW recovery will go through an administrative
 * process (PR-03).
 */
@Injectable()
export class PasswordRecoveryService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly rateLimits: RateLimitService,
    private readonly sessions: SessionService,
    private readonly mailer: AuthMailer,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  /** Same response whether or not an active account exists. */
  async requestReset(email: string, ip: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    await this.rateLimits.consume(RATE_LIMITS.passwordResetIp, `ip:${ip}`);
    await this.rateLimits.consume(RATE_LIMITS.passwordResetIdentity, `customer:${normalizedEmail}`);

    let issued: { email: string; token: string } | null = null;
    try {
      issued = await this.database.client.$transaction(async (tx) => {
        const identity = await tx.authIdentity.findUnique({
          where: { realm_normalizedEmail: { realm: AuthRealm.CUSTOMER, normalizedEmail } },
          select: { id: true, status: true, email: true },
        });
        // Pending accounts verify their email first; suspended/disabled get nothing.
        if (identity?.status !== AuthIdentityStatus.ACTIVE) return null;

        await tx.passwordResetToken.updateMany({
          where: { identityId: identity.id, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: new Date() },
        });
        const token = secureRandomToken();
        await tx.passwordResetToken.create({
          data: {
            identityId: identity.id,
            tokenHash: hashOpaqueToken(token),
            expiresAt: new Date(Date.now() + this.config.passwordResetTtlMs),
          },
        });
        return { email: identity.email, token };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }

    this.securityLog.record('AUTH_PASSWORD_RESET_REQUESTED', {
      realm: 'customer',
      subject: `customer:${normalizedEmail}`,
      ip,
    });
    if (issued)
      this.mailer.sendPasswordReset(issued.email, issued.token, this.config.passwordResetTtlMs);
  }

  /**
   * Consumes the token, replaces the password, bumps authVersion and revokes
   * every session — all in one transaction. The user is not logged in
   * automatically and must sign in with the new password.
   */
  async resetPassword(token: string, newPassword: string, ip: string): Promise<void> {
    await this.rateLimits.consume(RATE_LIMITS.tokenSubmissionIp, `ip:${ip}`);
    if (!isWellFormedOpaqueToken(token)) throw AuthErrors.invalidToken();

    const record = await this.database.client.passwordResetToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        identityId: true,
        expiresAt: true,
        consumedAt: true,
        invalidatedAt: true,
        identity: { select: { email: true, status: true, realm: true } },
      },
    });
    if (
      !record ||
      record.consumedAt ||
      record.invalidatedAt ||
      record.expiresAt <= new Date() ||
      record.identity.status !== AuthIdentityStatus.ACTIVE ||
      record.identity.realm !== AuthRealm.CUSTOMER
    ) {
      throw AuthErrors.invalidToken();
    }

    const policy = checkPasswordPolicy(newPassword, { email: record.identity.email });
    if (!policy.ok) throw AuthErrors.passwordPolicy(policy.message);
    const passwordHash = await hashPassword(newPassword);

    await this.database.client.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: {
          id: record.id,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) throw AuthErrors.invalidToken();

      await tx.passwordCredential.upsert({
        where: { identityId: record.identityId },
        create: { identityId: record.identityId, passwordHash },
        update: { passwordHash },
      });
      await this.sessions.revokeAllForIdentity(
        tx,
        record.identityId,
        AuthSessionRevocationReason.PASSWORD_RESET,
      );
    });

    this.securityLog.record('AUTH_PASSWORD_RESET', {
      realm: 'customer',
      identityId: record.identityId,
      ip,
    });
    this.mailer.sendPasswordChanged(record.identity.email);
  }
}
