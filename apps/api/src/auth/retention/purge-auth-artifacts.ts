import type { PrismaClient } from '@euroteranga/database';

const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTH_RETENTION_MS = {
  verificationAndReset: 7 * DAY_MS,
  challenge: DAY_MS,
  session: 90 * DAY_MS,
  staffTemporary: 7 * DAY_MS,
} as const;

export interface PurgedAuthArtifacts {
  emailVerificationTokens: number;
  passwordResetTokens: number;
  challenges: number;
  rateLimitBuckets: number;
  sessions: number;
  staffInvitations: number;
  staffEnrollmentGrants: number;
}

/**
 * Deletes only expired temporary authentication artifacts. Audit/security
 * events and durable identity/MFA credentials are deliberately out of scope.
 *
 * The operation is idempotent and transactionally applies one retention
 * snapshot derived from now, so an operator can safely schedule it daily.
 */
export async function purgeExpiredAuthArtifacts(
  database: PrismaClient,
  now = new Date(),
): Promise<PurgedAuthArtifacts> {
  const tokenCutoff = new Date(now.getTime() - AUTH_RETENTION_MS.verificationAndReset);
  const challengeCutoff = new Date(now.getTime() - AUTH_RETENTION_MS.challenge);
  const sessionCutoff = new Date(now.getTime() - AUTH_RETENTION_MS.session);
  const staffCutoff = new Date(now.getTime() - AUTH_RETENTION_MS.staffTemporary);

  return database.$transaction(async (tx) => {
    const emailVerificationTokens = await tx.emailVerificationToken.deleteMany({
      where: { expiresAt: { lt: tokenCutoff } },
    });
    const passwordResetTokens = await tx.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: tokenCutoff } },
    });
    const challenges = await tx.authChallenge.deleteMany({
      where: { expiresAt: { lt: challengeCutoff } },
    });
    const rateLimitBuckets = await tx.authRateLimitBucket.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const sessions = await tx.authSession.deleteMany({
      where: {
        OR: [
          { idleExpiresAt: { lt: sessionCutoff } },
          { absoluteExpiresAt: { lt: sessionCutoff } },
          { revokedAt: { lt: sessionCutoff } },
        ],
      },
    });
    const staffInvitations = await tx.staffInvitation.deleteMany({
      where: { expiresAt: { lt: staffCutoff } },
    });
    const staffEnrollmentGrants = await tx.staffEnrollmentGrant.deleteMany({
      where: { expiresAt: { lt: staffCutoff } },
    });

    return {
      emailVerificationTokens: emailVerificationTokens.count,
      passwordResetTokens: passwordResetTokens.count,
      challenges: challenges.count,
      rateLimitBuckets: rateLimitBuckets.count,
      sessions: sessions.count,
      staffInvitations: staffInvitations.count,
      staffEnrollmentGrants: staffEnrollmentGrants.count,
    };
  });
}
