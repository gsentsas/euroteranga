import { randomBytes } from 'node:crypto';
import { AuthIdentityStatus, AuthRealm } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentity, db, uniqueEmail } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const bytes = (length: number) => new Uint8Array(randomBytes(length));
const inOneHour = () => new Date(Date.now() + 3600_000);

/** Invariants written as explicit SQL in the PR-02 migration. */
describe('authentication database invariants', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('enforces UNIQUE(realm, normalized_email) within a realm only', async () => {
    const email = uniqueEmail('unique');
    await createIdentity(t.app, { realm: 'customer', email });
    await expect(createIdentity(t.app, { realm: 'customer', email })).rejects.toThrow();
    await expect(createIdentity(t.app, { realm: 'staff', email })).resolves.toBeDefined();
  });

  it('refuses an active customer without a verified email', async () => {
    const email = uniqueEmail('unverified');
    await expect(
      db(t.app).authIdentity.create({
        data: {
          realm: AuthRealm.CUSTOMER,
          email,
          normalizedEmail: email,
          status: AuthIdentityStatus.ACTIVE,
        },
      }),
    ).rejects.toThrow(/auth_identity_active_customer_verified/);
  });

  it('allows at most one usable verification token per identity', async () => {
    const identity = await createIdentity(t.app, {
      realm: 'customer',
      status: AuthIdentityStatus.PENDING_VERIFICATION,
    });
    await db(t.app).emailVerificationToken.create({
      data: { identityId: identity.id, tokenHash: bytes(32), expiresAt: inOneHour() },
    });
    await expect(
      db(t.app).emailVerificationToken.create({
        data: { identityId: identity.id, tokenHash: bytes(32), expiresAt: inOneHour() },
      }),
    ).rejects.toThrow();
  });

  it('allows at most one usable reset token per identity', async () => {
    const identity = await createIdentity(t.app, { realm: 'customer' });
    await db(t.app).passwordResetToken.create({
      data: { identityId: identity.id, tokenHash: bytes(32), expiresAt: inOneHour() },
    });
    await expect(
      db(t.app).passwordResetToken.create({
        data: { identityId: identity.id, tokenHash: bytes(32), expiresAt: inOneHour() },
      }),
    ).rejects.toThrow();
  });

  it('refuses token digests that are not 32 bytes and malformed GCM nonces', async () => {
    const identity = await createIdentity(t.app, { realm: 'staff' });
    await expect(
      db(t.app).authSession.create({
        data: {
          identityId: identity.id,
          tokenHash: bytes(16),
          authVersion: 1,
          idleExpiresAt: inOneHour(),
          absoluteExpiresAt: inOneHour(),
        },
      }),
    ).rejects.toThrow(/auth_session_token_hash_len/);
    await expect(
      db(t.app).mfaTotpCredential.create({
        data: {
          identityId: identity.id,
          secretCiphertext: bytes(36),
          secretNonce: bytes(16),
          keyVersion: 1,
        },
      }),
    ).rejects.toThrow(/mfa_totp_credential_nonce_len/);
  });

  it('keeps revocation reason and timestamp consistent', async () => {
    const identity = await createIdentity(t.app, { realm: 'crew' });
    await expect(
      db(t.app).authSession.create({
        data: {
          identityId: identity.id,
          tokenHash: bytes(32),
          authVersion: 1,
          idleExpiresAt: inOneHour(),
          absoluteExpiresAt: inOneHour(),
          revokedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/auth_session_revocation_consistent/);
  });
});
