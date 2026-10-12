import {
  AuthChallengeType,
  AuthIdentityStatus,
  type DatabaseTransaction,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { TotpSecretCipher } from '../crypto/totp-cipher.js';
import { AuthErrors } from '../http/public-api-error.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import { SessionService, type IssuedSession } from '../session/session.service.js';
import { ChallengeService, type ChallengeRef } from './challenge.service.js';
import { consumeRecoveryCode, replaceRecoveryCodes } from './recovery-codes.js';
import { generateTotpSecret, matchTotpStep, totpEnrollmentDetails } from './totp.js';

export type MfaProof = { code: string } | { recoveryCode: string };

class EnrollmentAuthorizationLostError extends Error {
  constructor() {
    super('STAFF MFA enrollment authorization is missing, expired or already consumed');
    this.name = 'EnrollmentAuthorizationLostError';
  }
}

/**
 * STAFF second factor (TOTP, RFC 6238) and recovery codes. A STAFF session
 * only exists after one of these succeeds on a valid challenge.
 */
@Injectable()
export class StaffMfaService {
  private readonly cipher: TotpSecretCipher;

  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) config: AuthConfig,
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
    private readonly rateLimits: RateLimitService,
    private readonly securityLog: SecurityEventLogger,
  ) {
    this.cipher = new TotpSecretCipher(config.totpKey, config.totpKeyVersion);
  }

  /** Generates (or regenerates) the pending secret of an enrollment challenge. */
  async startEnrollment(challengeToken: string | undefined) {
    const challenge = await this.challenges.find(challengeToken, AuthChallengeType.MFA_ENROLLMENT);
    if (!challenge) throw AuthErrors.challengeInvalid();

    const identity = await this.database.client.authIdentity.findUniqueOrThrow({
      where: { id: challenge.identityId },
      select: {
        email: true,
        mfaTotpCredential: { select: { enabledAt: true } },
        staffEnrollmentGrant: { select: { expiresAt: true, consumedAt: true } },
      },
    });
    if (identity.mfaTotpCredential?.enabledAt) throw AuthErrors.mfaAlreadyEnabled();
    const grant = identity.staffEnrollmentGrant;
    if (!grant || grant.consumedAt !== null || grant.expiresAt <= new Date()) {
      throw AuthErrors.challengeInvalid();
    }

    const secret = generateTotpSecret();
    const encrypted = this.cipher.encrypt(secret, challenge.identityId);
    const data = {
      secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce,
      keyVersion: encrypted.keyVersion,
      enabledAt: null,
      lastAcceptedStep: null,
    };
    await this.database.client.mfaTotpCredential.upsert({
      where: { identityId: challenge.identityId },
      create: { identityId: challenge.identityId, ...data },
      update: data,
    });
    return totpEnrollmentDetails(secret, identity.email);
  }

  /** Verifies the first code, enables TOTP, issues recovery codes and a session. */
  async confirmEnrollment(
    challengeToken: string | undefined,
    code: string,
    ip: string,
  ): Promise<{ session: IssuedSession; recoveryCodes: string[] }> {
    await this.rateLimits.consume(RATE_LIMITS.mfaIp, `ip:${ip}`);
    const challenge = await this.challenges.spendAttempt(
      challengeToken,
      AuthChallengeType.MFA_ENROLLMENT,
    );
    if (!challenge) this.fail(ip);

    const step = await this.matchCode(challenge.identityId, code, { enabled: false });
    if (step === null) this.fail(ip, challenge.identityId);

    let result: { session: IssuedSession; recoveryCodes: string[] };
    try {
      result = await this.database.client.$transaction(async (tx) => {
        if (!(await this.acceptStep(tx, challenge.identityId, step, { enabled: false }))) {
          throw new EnrollmentAuthorizationLostError();
        }

        // Consume the one-time administrative authorization in the same
        // transaction as enabling TOTP and creating the STAFF session.
        const grant = await tx.staffEnrollmentGrant.updateMany({
          where: {
            identityId: challenge.identityId,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { consumedAt: new Date() },
        });
        if (grant.count !== 1) throw new EnrollmentAuthorizationLostError();

        const enabled = await tx.mfaTotpCredential.updateMany({
          where: { identityId: challenge.identityId, enabledAt: null },
          data: { enabledAt: new Date() },
        });
        if (enabled.count !== 1) throw new EnrollmentAuthorizationLostError();

        const recoveryCodes = await replaceRecoveryCodes(tx, challenge.identityId);
        const session = await this.finishChallenge(tx, challenge);
        if (!session) throw new EnrollmentAuthorizationLostError();
        return { session, recoveryCodes };
      });
    } catch (error) {
      if (error instanceof EnrollmentAuthorizationLostError) {
        this.fail(ip, challenge.identityId);
      }
      throw error;
    }

    this.securityLog.record('AUTH_MFA_ENROLLED', {
      realm: 'staff',
      identityId: challenge.identityId,
    });
    this.securityLog.record('AUTH_LOGIN_SUCCESS', {
      realm: 'staff',
      identityId: challenge.identityId,
      ip,
    });
    return result;
  }

  /** Second factor of a regular STAFF login: TOTP code or recovery code. */
  async verifyLogin(
    challengeToken: string | undefined,
    proof: MfaProof,
    ip: string,
  ): Promise<IssuedSession> {
    await this.rateLimits.consume(RATE_LIMITS.mfaIp, `ip:${ip}`);
    const challenge = await this.challenges.spendAttempt(
      challengeToken,
      AuthChallengeType.MFA_LOGIN,
    );
    if (!challenge) this.fail(ip);

    const step =
      'code' in proof
        ? await this.matchCode(challenge.identityId, proof.code, { enabled: true })
        : null;
    if ('code' in proof && step === null) this.fail(ip, challenge.identityId);

    const session = await this.database.client.$transaction(async (tx) => {
      const proven =
        'code' in proof
          ? step !== null &&
            (await this.acceptStep(tx, challenge.identityId, step, { enabled: true }))
          : await consumeRecoveryCode(tx, challenge.identityId, proof.recoveryCode);
      return proven ? this.finishChallenge(tx, challenge) : null;
    });
    if (!session) this.fail(ip, challenge.identityId);

    if ('recoveryCode' in proof) {
      this.securityLog.record('AUTH_MFA_RECOVERY_CODE_USED', {
        realm: 'staff',
        identityId: challenge.identityId,
      });
    }
    this.securityLog.record('AUTH_MFA_SUCCESS', {
      realm: 'staff',
      identityId: challenge.identityId,
    });
    this.securityLog.record('AUTH_LOGIN_SUCCESS', {
      realm: 'staff',
      identityId: challenge.identityId,
      ip,
    });
    return session;
  }

  private async matchCode(
    identityId: string,
    code: string,
    state: { enabled: boolean },
  ): Promise<number | null> {
    const credential = await this.database.client.mfaTotpCredential.findUnique({
      where: { identityId },
      select: { secretCiphertext: true, secretNonce: true, keyVersion: true, enabledAt: true },
    });
    if (!credential || Boolean(credential.enabledAt) !== state.enabled) return null;
    const secret = this.cipher.decrypt(
      {
        ciphertext: credential.secretCiphertext,
        nonce: credential.secretNonce,
        keyVersion: credential.keyVersion,
      },
      identityId,
    );
    return matchTotpStep(secret, code);
  }

  /**
   * Records the accepted time step only if it is newer than the last one:
   * a code (or any code from an earlier step) cannot be replayed, even by two
   * concurrent requests.
   */
  private async acceptStep(
    tx: DatabaseTransaction,
    identityId: string,
    step: number,
    state: { enabled: boolean },
  ): Promise<boolean> {
    const result = await tx.mfaTotpCredential.updateMany({
      where: {
        identityId,
        enabledAt: state.enabled ? { not: null } : null,
        OR: [{ lastAcceptedStep: null }, { lastAcceptedStep: { lt: BigInt(step) } }],
      },
      data: { lastAcceptedStep: BigInt(step) },
    });
    return result.count === 1;
  }

  /** Consumes the challenge and opens the STAFF session (identity still active). */
  private async finishChallenge(
    tx: DatabaseTransaction,
    challenge: ChallengeRef,
  ): Promise<IssuedSession | null> {
    if (!(await this.challenges.consume(tx, challenge.challengeId))) return null;
    const identity = await tx.authIdentity.findUnique({
      where: { id: challenge.identityId },
      select: { id: true, status: true, authVersion: true },
    });
    if (identity?.status !== AuthIdentityStatus.ACTIVE) return null;
    return this.sessions.create(tx, identity, 'staff');
  }

  private fail(ip: string, identityId?: string): never {
    this.securityLog.record('AUTH_MFA_FAILURE', {
      realm: 'staff',
      ip,
      ...(identityId ? { identityId } : {}),
    });
    throw AuthErrors.mfaCodeInvalid();
  }
}
