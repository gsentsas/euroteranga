import { createHash, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { hash } from '@node-rs/argon2';
import { FIXTURE_PASSWORD, FIXTURES, type Fixture } from './fixtures.js';

const DAY_MS = 24 * 3_600_000;

/**
 * Seeds the fixture identities before each run. STAFF fixtures start without
 * MFA but with a one-time enrollment grant (what an accepted invitation
 * gives), so the enrollment flow is exercised; the `invited` fixture is a
 * pending account with an invitation. Refuses to run against anything but a
 * disposable test database.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Browser tests need DATABASE_URL (disposable test database)');
  if (process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production') {
    throw new Error('Refusing to seed browser fixtures outside local/ci');
  }
  process.env.E2E_RUN_ID = randomBytes(4).toString('hex');
  const invitationToken = randomBytes(32).toString('base64url');
  process.env.E2E_INVITATION_TOKEN = invitationToken;

  const db = createDatabaseClient({ databaseUrl });
  try {
    // Argon2id, same parameters as the API (they are encoded in the hash).
    const passwordHash = await hash(FIXTURE_PASSWORD, {
      algorithm: 2,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    const expiresAt = new Date(Date.now() + DAY_MS);
    const fixtures: Fixture[] = Object.values(FIXTURES);
    for (const fixture of fixtures) {
      // Only the non-STAFF fixtures keep a fixed address and are reset here.
      if (fixture.realm !== 'STAFF') {
        await db.authIdentity.deleteMany({
          where: { realm: fixture.realm, normalizedEmail: fixture.email },
        });
      }
      const identity = await db.authIdentity.create({
        data: {
          realm: fixture.realm,
          email: fixture.email,
          normalizedEmail: fixture.email,
          status: fixture.invited ? 'PENDING_VERIFICATION' : 'ACTIVE',
          emailVerifiedAt: fixture.invited ? null : new Date(),
          ...(fixture.invited ? {} : { passwordCredential: { create: { passwordHash } } }),
        },
      });
      for (const roleKey of fixture.roles ?? []) {
        await db.authorizationRoleAssignment.create({
          data: { identityId: identity.id, roleKey, grantReason: 'browser test fixture' },
        });
      }
      if (fixture.realm !== 'STAFF') continue;
      if (fixture.invited) {
        await db.staffInvitation.create({
          data: {
            identityId: identity.id,
            tokenHash: new Uint8Array(createHash('sha256').update(invitationToken).digest()),
            expiresAt,
          },
        });
      } else {
        await db.staffEnrollmentGrant.create({ data: { identityId: identity.id, expiresAt } });
      }
    }
  } finally {
    await db.$disconnect();
  }
}
