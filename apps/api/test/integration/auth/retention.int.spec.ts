import { randomBytes } from 'node:crypto';
import {
  AuthChallengeType,
  AuthIdentityStatus,
  AuthRealm,
  createDatabaseClient,
} from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredAuthArtifacts } from '../../../src/auth/retention/purge-auth-artifacts.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const token = () => randomBytes(32);

describe('PR-24 authentication retention purge', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let db: ReturnType<typeof createDatabaseClient>;
  const now = new Date('2026-10-17T12:00:00.000Z');

  beforeAll(async () => {
    database = await isolatedDatabase();
    db = createDatabaseClient({ databaseUrl: database.url });

    const customer = await db.authIdentity.create({
      data: {
        realm: AuthRealm.CUSTOMER,
        email: 'retention.customer@example.test',
        normalizedEmail: 'retention.customer@example.test',
        status: AuthIdentityStatus.ACTIVE,
        emailVerifiedAt: now,
      },
    });
    const oldStaff = await db.authIdentity.create({
      data: {
        realm: AuthRealm.STAFF,
        email: 'retention.old.staff@example.test',
        normalizedEmail: 'retention.old.staff@example.test',
        status: AuthIdentityStatus.ACTIVE,
        emailVerifiedAt: now,
      },
    });
    const freshStaff = await db.authIdentity.create({
      data: {
        realm: AuthRealm.STAFF,
        email: 'retention.fresh.staff@example.test',
        normalizedEmail: 'retention.fresh.staff@example.test',
        status: AuthIdentityStatus.ACTIVE,
        emailVerifiedAt: now,
      },
    });

    const expired8d = new Date(now.getTime() - 8 * DAY_MS);
    const expired6d = new Date(now.getTime() - 6 * DAY_MS);
    const expired2d = new Date(now.getTime() - 2 * DAY_MS);
    const expired12h = new Date(now.getTime() - DAY_MS / 2);

    await db.emailVerificationToken.createMany({
      data: [
        {
          identityId: customer.id,
          tokenHash: token(),
          expiresAt: expired8d,
          consumedAt: expired8d,
        },
        { identityId: customer.id, tokenHash: token(), expiresAt: expired6d },
      ],
    });
    await db.passwordResetToken.createMany({
      data: [
        {
          identityId: customer.id,
          tokenHash: token(),
          expiresAt: expired8d,
          consumedAt: expired8d,
        },
        { identityId: customer.id, tokenHash: token(), expiresAt: expired6d },
      ],
    });
    await db.authChallenge.createMany({
      data: [
        {
          identityId: customer.id,
          type: AuthChallengeType.MFA_LOGIN,
          tokenHash: token(),
          expiresAt: expired2d,
        },
        {
          identityId: customer.id,
          type: AuthChallengeType.MFA_LOGIN,
          tokenHash: token(),
          expiresAt: expired12h,
        },
      ],
    });
    await db.authRateLimitBucket.createMany({
      data: [
        {
          key: token(),
          windowStart: new Date(now.getTime() - 60_000),
          action: 'retention-old',
          count: 1,
          expiresAt: new Date(now.getTime() - 1),
        },
        {
          key: token(),
          windowStart: now,
          action: 'retention-fresh',
          count: 1,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      ],
    });
    await db.authSession.createMany({
      data: [
        {
          identityId: customer.id,
          tokenHash: token(),
          authVersion: 1,
          createdAt: new Date(now.getTime() - 100 * DAY_MS),
          lastSeenAt: new Date(now.getTime() - 100 * DAY_MS),
          idleExpiresAt: new Date(now.getTime() - 91 * DAY_MS),
          absoluteExpiresAt: new Date(now.getTime() - 91 * DAY_MS),
        },
        {
          identityId: customer.id,
          tokenHash: token(),
          authVersion: 1,
          createdAt: new Date(now.getTime() - 60_000),
          lastSeenAt: new Date(now.getTime() - 60_000),
          idleExpiresAt: new Date(now.getTime() + DAY_MS),
          absoluteExpiresAt: new Date(now.getTime() + 2 * DAY_MS),
        },
      ],
    });
    await db.staffInvitation.createMany({
      data: [
        {
          identityId: oldStaff.id,
          tokenHash: token(),
          createdAt: new Date(expired8d.getTime() - DAY_MS),
          expiresAt: expired8d,
          consumedAt: expired8d,
        },
        {
          identityId: freshStaff.id,
          tokenHash: token(),
          createdAt: new Date(expired6d.getTime() - DAY_MS),
          expiresAt: expired6d,
        },
      ],
    });
    await db.staffEnrollmentGrant.createMany({
      data: [
        {
          identityId: oldStaff.id,
          issuedAt: new Date(expired8d.getTime() - DAY_MS),
          expiresAt: expired8d,
          consumedAt: expired8d,
        },
        {
          identityId: freshStaff.id,
          issuedAt: new Date(expired6d.getTime() - DAY_MS),
          expiresAt: expired6d,
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    await database?.drop();
  });

  it('deletes only artifacts beyond their retention window', async () => {
    await expect(purgeExpiredAuthArtifacts(db, now)).resolves.toEqual({
      emailVerificationTokens: 1,
      passwordResetTokens: 1,
      challenges: 1,
      rateLimitBuckets: 1,
      sessions: 1,
      staffInvitations: 1,
      staffEnrollmentGrants: 1,
    });

    const counts = await Promise.all([
      db.emailVerificationToken.count(),
      db.passwordResetToken.count(),
      db.authChallenge.count(),
      db.authRateLimitBucket.count(),
      db.authSession.count(),
      db.staffInvitation.count(),
      db.staffEnrollmentGrant.count(),
    ]);
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('is idempotent when rerun at the same retention snapshot', async () => {
    await expect(purgeExpiredAuthArtifacts(db, now)).resolves.toEqual({
      emailVerificationTokens: 0,
      passwordResetTokens: 0,
      challenges: 0,
      rateLimitBuckets: 0,
      sessions: 0,
      staffInvitations: 0,
      staffEnrollmentGrants: 0,
    });
  });
});
