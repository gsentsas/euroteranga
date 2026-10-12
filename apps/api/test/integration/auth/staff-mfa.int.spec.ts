import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode, TOTP_PERIOD_SECONDS } from '../../../src/auth/mfa/totp.js';
import { client, cookiesOf, createIdentity, db, uniqueIp } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const STEP_MS = TOTP_PERIOD_SECONDS * 1000;

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/, ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

describe('staff MFA (TOTP)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** Password step: returns the challenge cookie and the announced status. */
  async function passwordStep(email: string, password: string, ip = uniqueIp()) {
    const response = await client(t.app, 'staff', ip).post('/v1/auth/staff/login', {
      email,
      password,
    });
    expect(response.status).toBe(200);
    const challenge = cookiesOf(response).et_staff_mfa;
    expect(challenge).toBeDefined();
    expect(cookiesOf(response).et_staff_session).toBeUndefined();
    return { status: response.body.status as string, cookie: `et_staff_mfa=${challenge}`, ip };
  }

  /** Full enrollment; returns the TOTP secret, recovery codes and session cookie. */
  async function enroll() {
    const staff = await createIdentity(t.app, { realm: 'staff' });
    const step = await passwordStep(staff.email, staff.password);
    expect(step.status).toBe('MFA_ENROLLMENT_REQUIRED');
    const http = client(t.app, 'staff', step.ip);

    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, step.cookie);
    expect(start.status).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/EURO%20TERANGA:/);
    const secret = base32Decode(start.body.secret as string);

    const confirm = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: generateTotpCode(secret) },
      step.cookie,
    );
    expect(confirm.status).toBe(200);
    return {
      staff,
      secret,
      recoveryCodes: confirm.body.recoveryCodes as string[],
      session: `et_staff_session=${cookiesOf(confirm).et_staff_session}`,
      enrollmentChallenge: step.cookie,
      start,
    };
  }

  it('enrolls: wrong code gives no session, right code enables MFA and shows recovery codes once', async () => {
    const staff = await createIdentity(t.app, { realm: 'staff' });
    const step = await passwordStep(staff.email, staff.password);
    const http = client(t.app, 'staff', step.ip);
    const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, step.cookie);
    const secret = base32Decode(start.body.secret as string);

    const wrongCode = generateTotpCode(secret, Date.now() + 10 * STEP_MS);
    const wrong = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: wrongCode },
      step.cookie,
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({
      code: 'MFA_CODE_INVALID',
      message: 'Code invalide ou expiré.',
    });
    expect(cookiesOf(wrong).et_staff_session).toBeUndefined();

    const right = await http.post(
      '/v1/auth/staff/mfa/enrollment/confirm',
      { code: generateTotpCode(secret) },
      step.cookie,
    );
    expect(right.status).toBe(200);
    expect(right.body.status).toBe('AUTHENTICATED');
    expect(right.body.recoveryCodes).toHaveLength(10);
    for (const code of right.body.recoveryCodes as string[])
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const session = `et_staff_session=${cookiesOf(right).et_staff_session}`;
    expect((await http.get('/v1/auth/staff/me', session)).body.realm).toBe('staff');

    // Recovery codes are stored hashed only; the challenge cannot be reused.
    const stored = await db(t.app).mfaRecoveryCode.findMany({
      where: { identityId: staff.id },
      select: { codeHash: true },
    });
    expect(stored).toHaveLength(10);
    const raw = (right.body.recoveryCodes as string[]).map((code) => code.replace(/-/g, ''));
    for (const { codeHash } of stored)
      expect(raw).not.toContain(Buffer.from(codeHash).toString('utf8'));
    expect((await http.post('/v1/auth/staff/mfa/enrollment/start', {}, step.cookie)).status).toBe(
      401,
    );
  });

  it('stores the TOTP secret encrypted, never in clear', async () => {
    const { staff, secret, start } = await enroll();
    const credential = await db(t.app).mfaTotpCredential.findUniqueOrThrow({
      where: { identityId: staff.id },
      select: { secretCiphertext: true, secretNonce: true, keyVersion: true, enabledAt: true },
    });
    expect(credential.enabledAt).not.toBeNull();
    expect(credential.secretNonce).toHaveLength(12);
    expect(Buffer.from(credential.secretCiphertext).includes(secret)).toBe(false);
    expect(Buffer.from(credential.secretCiphertext).toString('latin1')).not.toContain(
      start.body.secret,
    );
    expect(t.logs.raw.join('\n')).not.toContain(start.body.secret as string);
  });

  it('requires TOTP on later logins and refuses a replayed code', async () => {
    const { staff, secret } = await enroll();
    // Enrollment accepted the current step; use the next step for the login.
    const later = Date.now() + STEP_MS;
    const code = generateTotpCode(secret, later);

    const first = await passwordStep(staff.email, staff.password);
    expect(first.status).toBe('MFA_REQUIRED');
    const ok = await client(t.app, 'staff', first.ip).post(
      '/v1/auth/staff/mfa/verify',
      { code },
      first.cookie,
    );
    expect(ok.status).toBe(200);
    expect(cookiesOf(ok).et_staff_session).toBeDefined();

    const second = await passwordStep(staff.email, staff.password);
    const replay = await client(t.app, 'staff', second.ip).post(
      '/v1/auth/staff/mfa/verify',
      { code },
      second.cookie,
    );
    expect(replay.status).toBe(401);
    expect(cookiesOf(replay).et_staff_session).toBeUndefined();
  });

  it('accepts one TOTP step only once under concurrency', async () => {
    const { staff, secret } = await enroll();
    const code = generateTotpCode(secret, Date.now() + STEP_MS);
    const a = await passwordStep(staff.email, staff.password);
    const b = await passwordStep(staff.email, staff.password);
    const results = await Promise.all([
      client(t.app, 'staff', a.ip).post('/v1/auth/staff/mfa/verify', { code }, a.cookie),
      client(t.app, 'staff', b.ip).post('/v1/auth/staff/mfa/verify', { code }, b.cookie),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it('accepts a recovery code once', async () => {
    const { staff, recoveryCodes } = await enroll();
    const code = recoveryCodes[0] as string;

    const first = await passwordStep(staff.email, staff.password);
    const used = await client(t.app, 'staff', first.ip).post(
      '/v1/auth/staff/mfa/verify',
      { recoveryCode: code.toLowerCase() },
      first.cookie,
    );
    expect(used.status).toBe(200);
    expect(t.logs.lines.some((line) => line.security_event === 'AUTH_MFA_RECOVERY_CODE_USED')).toBe(
      true,
    );
    expect(t.logs.raw.join('\n')).not.toContain(code);

    const second = await passwordStep(staff.email, staff.password);
    const reused = await client(t.app, 'staff', second.ip).post(
      '/v1/auth/staff/mfa/verify',
      { recoveryCode: code },
      second.cookie,
    );
    expect(reused.status).toBe(401);
  });

  it('consumes one recovery code only once under concurrency', async () => {
    const { staff, recoveryCodes } = await enroll();
    const code = recoveryCodes[1] as string;
    const a = await passwordStep(staff.email, staff.password);
    const b = await passwordStep(staff.email, staff.password);
    const results = await Promise.all([
      client(t.app, 'staff', a.ip).post(
        '/v1/auth/staff/mfa/verify',
        { recoveryCode: code },
        a.cookie,
      ),
      client(t.app, 'staff', b.ip).post(
        '/v1/auth/staff/mfa/verify',
        { recoveryCode: code },
        b.cookie,
      ),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it('makes a challenge unusable after five failed attempts', async () => {
    const { staff, secret } = await enroll();
    const step = await passwordStep(staff.email, staff.password);
    const http = client(t.app, 'staff', step.ip);
    for (let i = 1; i <= 5; i += 1) {
      const wrong = generateTotpCode(secret, Date.now() + (10 + i) * STEP_MS);
      expect(
        (await http.post('/v1/auth/staff/mfa/verify', { code: wrong }, step.cookie)).status,
      ).toBe(401);
    }
    const valid = generateTotpCode(secret, Date.now() + STEP_MS);
    const locked = await http.post('/v1/auth/staff/mfa/verify', { code: valid }, step.cookie);
    expect(locked.status).toBe(401);
    expect(cookiesOf(locked).et_staff_session).toBeUndefined();
  });

  it('rejects an expired challenge', async () => {
    const { staff, secret } = await enroll();
    const step = await passwordStep(staff.email, staff.password);
    await db(t.app).authChallenge.updateMany({
      where: { identityId: staff.id, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await client(t.app, 'staff', step.ip).post(
      '/v1/auth/staff/mfa/verify',
      { code: generateTotpCode(secret, Date.now() + STEP_MS) },
      step.cookie,
    );
    expect(response.status).toBe(401);
  });

  it('cannot verify without the challenge cookie, or with a challenge of another type', async () => {
    const { staff, secret, enrollmentChallenge } = await enroll();
    const http = client(t.app, 'staff');
    const code = generateTotpCode(secret, Date.now() + STEP_MS);
    expect((await http.post('/v1/auth/staff/mfa/verify', { code })).status).toBe(401);
    // The (consumed) enrollment challenge is not a login challenge.
    expect(
      (await http.post('/v1/auth/staff/mfa/verify', { code }, enrollmentChallenge)).status,
    ).toBe(401);
    expect(staff.id).toBeDefined();
  });

  it('does not require MFA for crew (documented decision)', async () => {
    const crew = await createIdentity(t.app, { realm: 'crew' });
    const response = await client(t.app, 'crew').post('/v1/auth/crew/login', {
      email: crew.email,
      password: crew.password,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'AUTHENTICATED' });
  });
});
