import { AuthChallengeType, AuthIdentityStatus } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, toDbRealm, type AuthConfig, type Realm } from '../auth.config.js';
import { verifyAgainstDummyHash, verifyPassword } from '../crypto/password-hasher.js';
import { AuthErrors } from '../http/public-api-error.js';
import { normalizeEmail } from '../identity/email.js';
import { ChallengeService } from '../mfa/challenge.service.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import { SessionService, type IssuedSession } from '../session/session.service.js';

export type LoginOutcome =
  | { kind: 'session'; session: IssuedSession }
  | {
      kind: 'challenge';
      status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
      token: string;
      expiresAt: Date;
    };

/**
 * Password login for every realm. Unknown email, wrong password and unusable
 * accounts (pending verification, suspended, disabled) all produce the same
 * INVALID_CREDENTIALS response, after a comparable Argon2 verification.
 * In an MFA realm (STAFF) a correct password yields a challenge, never a
 * session.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly rateLimits: RateLimitService,
    private readonly sessions: SessionService,
    private readonly challenges: ChallengeService,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  async login(realm: Realm, email: string, password: string, ip: string): Promise<LoginOutcome> {
    const normalizedEmail = normalizeEmail(email);
    const subject = `${realm}:${normalizedEmail}`;
    await this.rateLimits.consume(RATE_LIMITS.loginIp, `ip:${ip}`);
    await this.rateLimits.assertNotExceeded(RATE_LIMITS.loginIdentity, subject);

    const identity = await this.database.client.authIdentity.findUnique({
      where: { realm_normalizedEmail: { realm: toDbRealm(realm), normalizedEmail } },
      select: {
        id: true,
        status: true,
        authVersion: true,
        passwordCredential: { select: { passwordHash: true } },
        mfaTotpCredential: { select: { enabledAt: true } },
      },
    });

    const storedHash = identity?.passwordCredential?.passwordHash;
    const passwordValid = storedHash
      ? await verifyPassword(storedHash, password)
      : await verifyAgainstDummyHash(password);

    if (!identity || !passwordValid || identity.status !== AuthIdentityStatus.ACTIVE) {
      await this.rateLimits.increment(RATE_LIMITS.loginIdentity, subject);
      this.securityLog.record('AUTH_LOGIN_FAILURE', {
        realm,
        subject,
        ip,
        // Internal diagnosis only; the public response is identical.
        reason: !identity ? 'unknown_identity' : !passwordValid ? 'wrong_password' : 'inactive',
      });
      throw AuthErrors.invalidCredentials();
    }

    if (this.config.realms[realm].mfaRequired) {
      const enrolled = Boolean(identity.mfaTotpCredential?.enabledAt);
      const type = enrolled ? AuthChallengeType.MFA_LOGIN : AuthChallengeType.MFA_ENROLLMENT;
      const challenge = await this.challenges.create(identity.id, type);
      this.securityLog.record('AUTH_MFA_CHALLENGE_ISSUED', {
        realm,
        identityId: identity.id,
        challenge_type: type,
      });
      return {
        kind: 'challenge',
        status: enrolled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
        ...challenge,
      };
    }

    const session = await this.database.client.$transaction((tx) =>
      this.sessions.create(tx, identity, realm),
    );
    this.securityLog.record('AUTH_LOGIN_SUCCESS', { realm, identityId: identity.id, ip });
    return { kind: 'session', session };
  }
}
