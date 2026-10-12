import { createDatabaseClient } from '@euroteranga/database';
import { hash } from '@node-rs/argon2';
import { FIXTURE_PASSWORD, FIXTURES } from './fixtures.js';

/**
 * Resets the fixture identities before each run (STAFF starts without MFA so
 * the enrollment flow is exercised). Refuses to run against anything but a
 * disposable test database.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Browser tests need DATABASE_URL (disposable test database)');
  if (process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production') {
    throw new Error('Refusing to seed browser fixtures outside local/ci');
  }

  const db = createDatabaseClient({ databaseUrl });
  try {
    // Argon2id, same parameters as the API (they are encoded in the hash).
    const passwordHash = await hash(FIXTURE_PASSWORD, {
      algorithm: 2,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    for (const fixture of Object.values(FIXTURES)) {
      await db.authIdentity.deleteMany({
        where: { realm: fixture.realm, normalizedEmail: fixture.email },
      });
      await db.authIdentity.create({
        data: {
          realm: fixture.realm,
          email: fixture.email,
          normalizedEmail: fixture.email,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          passwordCredential: { create: { passwordHash } },
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
}
