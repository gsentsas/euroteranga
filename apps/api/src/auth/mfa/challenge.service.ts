import { type AuthChallengeType, type DatabaseTransaction } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { hashOpaqueToken, isWellFormedOpaqueToken, secureRandomToken } from '../crypto/tokens.js';

export interface ChallengeRef {
  challengeId: string;
  identityId: string;
}

/**
 * Short-lived step between a verified password and the second factor:
 * single use, expiring, and limited to a fixed number of attempts.
 */
@Injectable()
export class ChallengeService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async create(
    identityId: string,
    type: AuthChallengeType,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = secureRandomToken();
    const expiresAt = new Date(Date.now() + this.config.mfaChallengeTtlMs);
    await this.database.client.authChallenge.create({
      data: { identityId, type, tokenHash: hashOpaqueToken(token), expiresAt },
    });
    return { token, expiresAt };
  }

  /** Resolves a usable challenge without spending an attempt. */
  async find(token: string | undefined, type: AuthChallengeType): Promise<ChallengeRef | null> {
    if (!isWellFormedOpaqueToken(token)) return null;
    const challenge = await this.database.client.authChallenge.findFirst({
      where: {
        tokenHash: hashOpaqueToken(token),
        type,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: this.config.mfaChallengeMaxAttempts },
      },
      select: { id: true, identityId: true },
    });
    return challenge ? { challengeId: challenge.id, identityId: challenge.identityId } : null;
  }

  /**
   * Spends one attempt atomically. Returns null once the challenge is
   * consumed, expired or out of attempts: after the last allowed attempt it
   * is unusable, whatever the next code is.
   */
  async spendAttempt(
    token: string | undefined,
    type: AuthChallengeType,
  ): Promise<ChallengeRef | null> {
    if (!isWellFormedOpaqueToken(token)) return null;
    const tokenHash = hashOpaqueToken(token);
    const result = await this.database.client.authChallenge.updateMany({
      where: {
        tokenHash,
        type,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: this.config.mfaChallengeMaxAttempts },
      },
      data: { attempts: { increment: 1 } },
    });
    if (result.count !== 1) return null;
    const challenge = await this.database.client.authChallenge.findUnique({
      where: { tokenHash },
      select: { id: true, identityId: true },
    });
    return challenge ? { challengeId: challenge.id, identityId: challenge.identityId } : null;
  }

  /** Marks the challenge used; false if another request consumed it first. */
  async consume(tx: DatabaseTransaction, challengeId: string): Promise<boolean> {
    const result = await tx.authChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }
}
