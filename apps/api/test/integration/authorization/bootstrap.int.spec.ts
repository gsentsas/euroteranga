import { createDatabaseClient, type PrismaClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BootstrapRefusedError,
  bootstrapSuperAdmin,
} from '../../../src/authorization/bootstrap/bootstrap-super-admin.js';
import { generateTotpCode } from '../../../src/auth/mfa/totp.js';
import { client, cookiesOf, uniqueEmail } from '../../support/auth-helpers.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const TTL = { invitationTtlMs: 3_600_000, enrollmentGrantTtlMs: 3_600_000 };
const PASSWORD = 'bootstrap admin synthetic passphrase 77';

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/, ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/** The bootstrap function, tested separately from its CLI wrapper. */
describe('initial SUPER_ADMIN bootstrap (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let db: PrismaClient;
  let t: TestApp;

  beforeAll(async () => {
    database = await isolatedDatabase();
    db = createDatabaseClient({ databaseUrl: database.url });
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  });

  afterAll(async () => {
    await t.app.close();
    await db.$disconnect();
    await database.drop();
  });

  it('bootstraps, regenerates while pending, refuses other emails, then refuses once active', async () => {
    const email = uniqueEmail('root');

    // 1. No SUPER_ADMIN: pending identity + role + invitation, no session, no password.
    const first = await bootstrapSuperAdmin(db, { email, ...TTL });
    expect(first.kind).toBe('invitation');
    if (first.kind !== 'invitation') throw new Error('unexpected outcome');
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const identity = await db.authIdentity.findUniqueOrThrow({
      where: { id: first.identityId },
      include: { passwordCredential: true, sessions: true, roleAssignments: true },
    });
    expect(identity).toMatchObject({ realm: 'STAFF', status: 'PENDING_VERIFICATION' });
    expect(identity.passwordCredential).toBeNull();
    expect(identity.sessions).toHaveLength(0);
    expect(identity.roleAssignments.map((assignment) => assignment.roleKey)).toEqual([
      'SUPER_ADMIN',
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'SUPER_ADMIN_BOOTSTRAPPED' },
    });
    expect(audit.actorIdentityId).toBeNull();
    expect(JSON.stringify(audit)).not.toContain(first.token);

    // 2. Same email while pending: invitation regenerated, old link dead.
    const second = await bootstrapSuperAdmin(db, { email, ...TTL });
    if (second.kind !== 'invitation') throw new Error('unexpected outcome');
    expect(second.regenerated).toBe(true);
    const http = client(t.app, 'staff');
    expect(
      (
        await http.post('/v1/auth/staff/invitation/accept', {
          token: first.token,
          newPassword: PASSWORD,
        })
      ).status,
    ).toBe(400);

    // 3. Another email while a bootstrap is pending: refused.
    await expect(
      bootstrapSuperAdmin(db, { email: uniqueEmail('other'), ...TTL }),
    ).rejects.toMatchObject({
      reason: 'PENDING_BOOTSTRAP_FOR_ANOTHER_EMAIL',
    });

    // 4. Finish: accept invitation, enroll TOTP through the enrollment grant.
    expect(
      (
        await http.post('/v1/auth/staff/invitation/accept', {
          token: second.token,
          newPassword: PASSWORD,
        })
      ).status,
    ).toBe(200);
    const login = await http.post('/v1/auth/staff/login', { email, password: PASSWORD });
    expect(login.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED' });
    const challenge = `et_staff_mfa=${cookiesOf(login).et_staff_mfa}`;
    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, challenge);
    const confirm = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: generateTotpCode(base32Decode(start.body.secret as string)) },
      challenge,
    );
    expect(confirm.status).toBe(200);

    // 5. An active SUPER_ADMIN with MFA exists: refused, nothing changed.
    const refusal = await bootstrapSuperAdmin(db, { email: uniqueEmail('late'), ...TTL }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BootstrapRefusedError);
    expect((refusal as BootstrapRefusedError).reason).toBe('SUPER_ADMIN_ALREADY_ACTIVE');
    expect(await db.auditEvent.count({ where: { action: 'SUPER_ADMIN_BOOTSTRAPPED' } })).toBe(2);
    // MFA stays enabled; bootstrap never disables it.
    expect(
      await db.mfaTotpCredential.count({
        where: { identityId: first.identityId, enabledAt: { not: null } },
      }),
    ).toBe(1);
  });
});
