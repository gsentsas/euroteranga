import {
  AuthIdentityStatus,
  AuthRealm,
  Prisma,
  type DatabaseTransaction,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { hashPassword, verifyPassword } from '../crypto/password-hasher.js';
import { hashOpaqueToken, isWellFormedOpaqueToken, secureRandomToken } from '../crypto/tokens.js';
import { AuthErrors } from '../http/public-api-error.js';
import { displayEmail, normalizeEmail } from '../identity/email.js';
import { AuthMailer } from '../mail/auth-mailer.js';
import { checkPasswordPolicy } from '../password/password-policy.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';

type RegistrationOutcome =
  | { kind: 'verification'; email: string; token: string }
  | { kind: 'account-exists'; email: string }
  | { kind: 'silent' };

/**
 * Customer self-registration and email verification.
 *
 * Responses never reveal whether an address is already registered. The
 * password chosen at registration is stored on the verification token and
 * applied only when that token is verified together with the same password:
 * someone who pre-registers a victim's address cannot end up owning the
 * account the victim later activates (pre-account-hijacking).
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly rateLimits: RateLimitService,
    private readonly mailer: AuthMailer,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  async register(email: string, password: string, ip: string): Promise<void> {
    await this.rateLimits.consume(RATE_LIMITS.registerIp, `ip:${ip}`);

    const policy = checkPasswordPolicy(password, { email });
    if (!policy.ok) throw AuthErrors.passwordPolicy(policy.message);

    const normalizedEmail = normalizeEmail(email);
    // Per-address limit too: repeated registrations of an existing address
    // must not turn "account exists" notices into a mail-bombing vector.
    await this.rateLimits.consume(RATE_LIMITS.verificationIdentity, `customer:${normalizedEmail}`);
    // Hashed in every case so that new and existing addresses cost the same.
    const passwordHash = await hashPassword(password);

    const outcome = await this.runRegistration(displayEmail(email), normalizedEmail, passwordHash);
    this.securityLog.record('AUTH_REGISTRATION_REQUESTED', {
      realm: 'customer',
      subject: `customer:${normalizedEmail}`,
      ip,
    });

    if (outcome.kind === 'verification') {
      this.mailer.sendEmailVerification(
        outcome.email,
        outcome.token,
        this.config.emailVerificationTtlMs,
      );
    } else if (outcome.kind === 'account-exists') {
      this.mailer.sendAccountExists(outcome.email);
    }
  }

  private async runRegistration(
    email: string,
    normalizedEmail: string,
    passwordHash: string,
  ): Promise<RegistrationOutcome> {
    try {
      return await this.database.client.$transaction(async (tx) => {
        const existing = await tx.authIdentity.findUnique({
          where: { realm_normalizedEmail: { realm: AuthRealm.CUSTOMER, normalizedEmail } },
          select: { id: true, status: true, email: true },
        });

        if (!existing) {
          const identity = await tx.authIdentity.create({
            data: {
              realm: AuthRealm.CUSTOMER,
              email,
              normalizedEmail,
              status: AuthIdentityStatus.PENDING_VERIFICATION,
            },
            select: { id: true },
          });
          const token = await this.issueVerificationToken(tx, identity.id, passwordHash);
          return { kind: 'verification', email, token };
        }
        if (existing.status === AuthIdentityStatus.PENDING_VERIFICATION) {
          const token = await this.issueVerificationToken(tx, existing.id, passwordHash);
          return { kind: 'verification', email: existing.email, token };
        }
        if (existing.status === AuthIdentityStatus.ACTIVE) {
          return { kind: 'account-exists', email: existing.email };
        }
        return { kind: 'silent' }; // suspended or disabled: nothing is sent
      });
    } catch (error) {
      // A concurrent registration of the same address won the race; the
      // response stays generic and that request sends the mail.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { kind: 'silent' };
      }
      throw error;
    }
  }

  /**
   * Supersedes any usable token of the identity, then issues a new one. A
   * partial unique index guarantees at most one usable token per identity.
   */
  private async issueVerificationToken(
    tx: DatabaseTransaction,
    identityId: string,
    pendingPasswordHash: string,
  ): Promise<string> {
    await tx.emailVerificationToken.updateMany({
      where: { identityId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: new Date(), pendingPasswordHash: null },
    });
    const token = secureRandomToken();
    await tx.emailVerificationToken.create({
      data: {
        identityId,
        tokenHash: hashOpaqueToken(token),
        pendingPasswordHash,
        expiresAt: new Date(Date.now() + this.config.emailVerificationTtlMs),
      },
    });
    return token;
  }

  /**
   * PENDING_VERIFICATION → ACTIVE. The token is consumed in the same
   * transaction as the activation; concurrent submissions of one token
   * produce exactly one success.
   */
  async verifyEmail(token: string, password: string, ip: string): Promise<void> {
    await this.rateLimits.consume(RATE_LIMITS.tokenSubmissionIp, `ip:${ip}`);
    if (!isWellFormedOpaqueToken(token)) throw AuthErrors.verificationFailed();

    const now = new Date();
    const record = await this.database.client.emailVerificationToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        identityId: true,
        pendingPasswordHash: true,
        expiresAt: true,
        consumedAt: true,
        invalidatedAt: true,
        identity: { select: { status: true } },
      },
    });
    const pendingPasswordHash = record?.pendingPasswordHash;
    if (
      !record ||
      !pendingPasswordHash ||
      record.consumedAt ||
      record.invalidatedAt ||
      record.expiresAt <= now ||
      record.identity.status !== AuthIdentityStatus.PENDING_VERIFICATION
    ) {
      this.securityLog.record('AUTH_EMAIL_VERIFICATION_FAILED', {
        realm: 'customer',
        ip,
        reason: 'token',
      });
      throw AuthErrors.verificationFailed();
    }
    if (!(await verifyPassword(pendingPasswordHash, password))) {
      this.securityLog.record('AUTH_EMAIL_VERIFICATION_FAILED', {
        realm: 'customer',
        identityId: record.identityId,
        ip,
        reason: 'password',
      });
      throw AuthErrors.verificationFailed();
    }

    await this.database.client.$transaction(async (tx) => {
      const consumed = await tx.emailVerificationToken.updateMany({
        where: {
          id: record.id,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date(), pendingPasswordHash: null },
      });
      if (consumed.count !== 1) throw AuthErrors.verificationFailed();

      const activated = await tx.authIdentity.updateMany({
        where: { id: record.identityId, status: AuthIdentityStatus.PENDING_VERIFICATION },
        data: { status: AuthIdentityStatus.ACTIVE, emailVerifiedAt: new Date() },
      });
      if (activated.count !== 1) throw AuthErrors.verificationFailed();

      await tx.passwordCredential.upsert({
        where: { identityId: record.identityId },
        create: { identityId: record.identityId, passwordHash: pendingPasswordHash },
        update: { passwordHash: pendingPasswordHash },
      });
    });
    this.securityLog.record('AUTH_EMAIL_VERIFIED', {
      realm: 'customer',
      identityId: record.identityId,
    });
  }

  /**
   * Issues a new link for a pending registration, carrying the password of
   * the latest registration attempt (the old link stops working). Generic
   * response in every case.
   */
  async resendVerification(email: string, ip: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    await this.rateLimits.consume(RATE_LIMITS.verificationIp, `ip:${ip}`);
    await this.rateLimits.consume(RATE_LIMITS.verificationIdentity, `customer:${normalizedEmail}`);

    let issued: { email: string; token: string } | null = null;
    try {
      issued = await this.database.client.$transaction(async (tx) => {
        const identity = await tx.authIdentity.findUnique({
          where: { realm_normalizedEmail: { realm: AuthRealm.CUSTOMER, normalizedEmail } },
          select: { id: true, status: true, email: true },
        });
        if (identity?.status !== AuthIdentityStatus.PENDING_VERIFICATION) return null;
        const current = await tx.emailVerificationToken.findFirst({
          where: { identityId: identity.id, consumedAt: null, invalidatedAt: null },
          select: { pendingPasswordHash: true },
        });
        if (!current?.pendingPasswordHash) return null;
        const token = await this.issueVerificationToken(
          tx,
          identity.id,
          current.pendingPasswordHash,
        );
        return { email: identity.email, token };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
    if (issued) {
      this.mailer.sendEmailVerification(
        issued.email,
        issued.token,
        this.config.emailVerificationTtlMs,
      );
    }
  }
}
