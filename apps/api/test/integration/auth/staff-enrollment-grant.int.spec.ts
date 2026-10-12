import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../../../src/auth/mfa/totp.js';
import { client, cookiesOf, createIdentity, db, uniqueIp } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/, ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

/**
 * PR-03 closes the PR-02 trust-on-first-use gap: a STAFF identity without
 * TOTP may only enroll its first factor with an explicit, expiring,
 * single-use StaffEnrollmentGrant issued by an administrator.
 */
describe('STAFF first MFA enrollment requires an administrator grant', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  const challengeCount = (identityId: string) =>
    db(t.app).authChallenge.count({ where: { identityId } });

  async function login(email: string, password: string, ip = uniqueIp()) {
    const response = await client(t.app, 'staff', ip).post('/v1/auth/staff/login', {
      email,
      password,
    });
    const challenge = cookiesOf(response).et_staff_mfa;
    return { response, ip, cookie: challenge ? `et_staff_mfa=${challenge}` : undefined };
  }

  it('staff password knowledge cannot bootstrap its own first MFA factor', async () => {
    // Test A / H: no grant → same answer as a wrong password, no challenge.
    const staff = await createIdentity(t.app, { realm: 'staff' });
    const { response, cookie } = await login(staff.email, staff.password);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(cookie).toBeUndefined();
    expect(await challengeCount(staff.id)).toBe(0);
    expect(await db(t.app).mfaTotpCredential.count({ where: { identityId: staff.id } })).toBe(0);
    expect(t.logs.lines.some((line) => line.security_event === 'AUTH_MFA_ENROLLMENT_BLOCKED')).toBe(
      true,
    );
  });

  it('issues an MFA_ENROLLMENT challenge when a valid grant exists (Test B)', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
    const { response, cookie } = await login(staff.email, staff.password);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED' });
    expect(cookie).toBeDefined();
    const challenges = await db(t.app).authChallenge.findMany({
      where: { identityId: staff.id },
      select: { type: true },
    });
    expect(challenges).toEqual([{ type: 'MFA_ENROLLMENT' }]);
  });

  it.each([
    ['expired (Test C)', { expiresAt: new Date(Date.now() - 1000) }],
    ['consumed (Test D)', { consumedAt: new Date(Date.now() - 1000) }],
  ])('refuses enrollment when the grant is %s', async (_label, grant) => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: grant });
    const { response, cookie } = await login(staff.email, staff.password);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(cookie).toBeUndefined();
    expect(await challengeCount(staff.id)).toBe(0);
  });

  it('refuses to start enrollment when the grant disappears after login (Test E)', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
    const { cookie, ip } = await login(staff.email, staff.password);
    expect(cookie).toBeDefined();
    await db(t.app).staffEnrollmentGrant.update({
      where: { identityId: staff.id },
      data: { expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 2000) },
    });

    const start = await client(t.app, 'staff', ip).post(
      '/v1/auth/staff/mfa/enrollment/start',
      {},
      cookie,
    );
    expect(start.status).toBe(401);
    expect(start.body.secret).toBeUndefined();
    expect(await db(t.app).mfaTotpCredential.count({ where: { identityId: staff.id } })).toBe(0);
  });

  it('refuses to confirm enrollment when the grant is consumed in between', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
    const { cookie, ip } = await login(staff.email, staff.password);
    const http = client(t.app, 'staff', ip);
    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, cookie);
    const secret = base32Decode(start.body.secret as string);
    await db(t.app).staffEnrollmentGrant.update({
      where: { identityId: staff.id },
      data: { consumedAt: new Date() },
    });

    const confirm = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: generateTotpCode(secret) },
      cookie,
    );
    expect(confirm.status).toBe(401);
    expect(cookiesOf(confirm).et_staff_session).toBeUndefined();
    const credential = await db(t.app).mfaTotpCredential.findUnique({
      where: { identityId: staff.id },
    });
    expect(credential?.enabledAt ?? null).toBeNull();
    // The rollback also leaves the time step unused.
    expect(credential?.lastAcceptedStep ?? null).toBeNull();
  });

  it('consumes the grant atomically with TOTP, challenge, recovery codes and session (Test F)', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
    const { cookie, ip } = await login(staff.email, staff.password);
    const http = client(t.app, 'staff', ip);
    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, cookie);
    const secret = base32Decode(start.body.secret as string);

    const confirm = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: generateTotpCode(secret) },
      cookie,
    );
    expect(confirm.status).toBe(200);
    const [credential, grant, challenge, sessions, codes] = await Promise.all([
      db(t.app).mfaTotpCredential.findUniqueOrThrow({ where: { identityId: staff.id } }),
      db(t.app).staffEnrollmentGrant.findUniqueOrThrow({ where: { identityId: staff.id } }),
      db(t.app).authChallenge.findFirstOrThrow({
        where: { identityId: staff.id, type: 'MFA_ENROLLMENT' },
      }),
      db(t.app).authSession.count({ where: { identityId: staff.id } }),
      db(t.app).mfaRecoveryCode.count({ where: { identityId: staff.id } }),
    ]);
    expect(credential.enabledAt).not.toBeNull();
    expect(grant.consumedAt).not.toBeNull();
    expect(challenge.consumedAt).not.toBeNull();
    expect(sessions).toBe(1);
    expect(codes).toBe(10);

    // Single use: the grant cannot authorize a second enrollment.
    const again = await login(staff.email, staff.password);
    expect(again.response.body).toEqual({ status: 'MFA_REQUIRED' });
  });

  it('accepts exactly one of two concurrent confirmations (Test G)', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
    const { cookie, ip } = await login(staff.email, staff.password);
    const http = client(t.app, 'staff', ip);
    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, cookie);
    const code = generateTotpCode(base32Decode(start.body.secret as string));

    const results = await Promise.all([
      http.post('/v1/auth/staff/mfa/enrollment/confirm', { code }, cookie),
      http.post('/v1/auth/staff/mfa/enrollment/confirm', { code }, cookie),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(
      await db(t.app).staffEnrollmentGrant.count({
        where: { identityId: staff.id, consumedAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      await db(t.app).mfaTotpCredential.count({
        where: { identityId: staff.id, enabledAt: { not: null } },
      }),
    ).toBe(1);
    expect(await db(t.app).authSession.count({ where: { identityId: staff.id } })).toBe(1);
  });
});
