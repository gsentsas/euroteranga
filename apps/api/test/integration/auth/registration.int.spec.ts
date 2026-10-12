import { createHash } from 'node:crypto';
import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OTHER_TEST_PASSWORD,
  TEST_PASSWORD,
  client,
  cookiesOf,
  createIdentity,
  csrfToken,
  db,
  uniqueEmail,
  withoutRequestId,
} from '../../support/auth-helpers.js';
import { tokenFromMail } from '../../support/fake-auth-mail.provider.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const REGISTER = '/v1/auth/customer/register';
const VERIFY = '/v1/auth/customer/verify-email';
const RESEND = '/v1/auth/customer/resend-verification';

describe('customer registration and email verification', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('runs the full flow: register → mail → verify → login → me → csrf → logout', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('flow');

    const registered = await http.post(REGISTER, { email, password: TEST_PASSWORD });
    expect(registered.status).toBe(202);
    expect(registered.body).toEqual({
      message: 'Si cette adresse peut être utilisée, les prochaines instructions seront envoyées.',
    });

    const identity = await db(t.app).authIdentity.findFirstOrThrow({
      where: { normalizedEmail: email },
      select: { status: true, passwordCredential: true },
    });
    expect(identity.status).toBe(AuthIdentityStatus.PENDING_VERIFICATION);
    // The password only becomes a credential once the email is verified.
    expect(identity.passwordCredential).toBeNull();

    // Pending accounts cannot log in (generic answer).
    const early = await http.post('/v1/auth/customer/login', { email, password: TEST_PASSWORD });
    expect(early.status).toBe(401);
    expect(early.body.code).toBe('INVALID_CREDENTIALS');

    const token = tokenFromMail(await t.mail.waitFor(email));
    const verified = await http.post(VERIFY, { token, password: TEST_PASSWORD });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ status: 'EMAIL_VERIFIED' });

    const login = await http.post('/v1/auth/customer/login', { email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ status: 'AUTHENTICATED' });
    const cookie = `et_customer_session=${cookiesOf(login).et_customer_session}`;

    const me = await http.get('/v1/auth/customer/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      id: expect.any(String),
      realm: 'customer',
      email,
      emailVerified: true,
    });
    expect(Object.keys(me.body as object).sort()).toEqual([
      'email',
      'emailVerified',
      'id',
      'realm',
    ]);

    const csrf = await csrfToken(t.app, 'customer', cookie);
    const logout = await http.post('/v1/auth/customer/logout', {}, cookie, csrf);
    expect(logout.status).toBe(204);

    expect((await http.get('/v1/auth/customer/me', cookie)).status).toBe(401);
  });

  it('answers identically for a new and an already registered address', async () => {
    const http = client(t.app, 'customer');
    const existing = await createIdentity(t.app, { realm: 'customer' });

    const fresh = await http.post(REGISTER, { email: uniqueEmail('new'), password: TEST_PASSWORD });
    const duplicate = await http.post(REGISTER, {
      email: existing.email,
      password: OTHER_TEST_PASSWORD,
    });

    expect(duplicate.status).toBe(fresh.status);
    expect(withoutRequestId(duplicate.body)).toEqual(withoutRequestId(fresh.body));
    // The owner is told privately instead.
    expect((await t.mail.waitFor(existing.email)).subject).toContain(
      'tentative de création de compte',
    );
    // And the existing password is untouched.
    const unchanged = await http.post('/v1/auth/customer/login', {
      email: existing.email,
      password: existing.password,
    });
    expect(unchanged.status).toBe(200);
  });

  it('explains password policy violations without referring to other accounts', async () => {
    const http = client(t.app, 'customer');
    const tooShort = await http.post(REGISTER, { email: uniqueEmail(), password: 'short pass' });
    expect(tooShort.status).toBe(422);
    expect(tooShort.body.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect(tooShort.body.message).toContain('15 caractères');

    const common = await http.post(REGISTER, {
      email: uniqueEmail(),
      password: 'passwordpassword',
    });
    expect(common.status).toBe(422);
    expect(common.body.message).toBe(
      'Ce mot de passe est trop courant. Choisissez une phrase de passe plus longue et unique.',
    );
  });

  it('stores only the SHA-256 of the verification token', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('hash');
    await http.post(REGISTER, { email, password: TEST_PASSWORD });
    const token = tokenFromMail(await t.mail.waitFor(email));

    const rows = await db(t.app).emailVerificationToken.findMany({
      where: { identity: { normalizedEmail: email } },
      select: { tokenHash: true },
    });
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.tokenHash)).toEqual(createHash('sha256').update(token).digest());
    expect(t.logs.raw.join('\n')).not.toContain(token);
  });

  it('requires the registration password to activate (pre-account-hijacking defence)', async () => {
    const victim = client(t.app, 'customer');
    const attacker = client(t.app, 'customer');
    const email = uniqueEmail('victim');

    await victim.post(REGISTER, { email, password: TEST_PASSWORD });
    await attacker.post(REGISTER, { email, password: OTHER_TEST_PASSWORD });
    // The latest link carries the attacker's password: the victim's password
    // does not activate it, so the attacker cannot end up owning the account.
    const latest = tokenFromMail(await t.mail.waitFor(email, 2));
    const rejected = await victim.post(VERIFY, { token: latest, password: TEST_PASSWORD });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('VERIFICATION_FAILED');

    const status = await db(t.app).authIdentity.findFirstOrThrow({
      where: { normalizedEmail: email },
      select: { status: true },
    });
    expect(status.status).toBe(AuthIdentityStatus.PENDING_VERIFICATION);
  });

  it('rejects a superseded link after a resend, and accepts the new one', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('resend');
    await http.post(REGISTER, { email, password: TEST_PASSWORD });
    const first = tokenFromMail(await t.mail.waitFor(email));

    const resent = await http.post(RESEND, { email });
    expect(resent.status).toBe(202);
    const second = tokenFromMail(await t.mail.waitFor(email, 2));
    expect(second).not.toBe(first);

    expect((await http.post(VERIFY, { token: first, password: TEST_PASSWORD })).status).toBe(400);
    expect((await http.post(VERIFY, { token: second, password: TEST_PASSWORD })).status).toBe(200);
  });

  it('answers resend requests generically for unknown and active addresses', async () => {
    const http = client(t.app, 'customer');
    const active = await createIdentity(t.app, { realm: 'customer' });
    const unknown = await http.post(RESEND, { email: uniqueEmail('nobody') });
    const known = await http.post(RESEND, { email: active.email });
    expect(known.status).toBe(202);
    expect(withoutRequestId(known.body)).toEqual(withoutRequestId(unknown.body));
    await t.mail.settle();
    expect(t.mail.to(active.email)).toHaveLength(0);
  });

  it('rejects expired, unknown and malformed tokens', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('expired');
    await http.post(REGISTER, { email, password: TEST_PASSWORD });
    const token = tokenFromMail(await t.mail.waitFor(email));
    await db(t.app).emailVerificationToken.updateMany({
      where: { identity: { normalizedEmail: email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    for (const candidate of [token, 'A'.repeat(43), 'not-a-token']) {
      const response = await http.post(VERIFY, { token: candidate, password: TEST_PASSWORD });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VERIFICATION_FAILED');
    }
  });

  it('accepts exactly one of two concurrent verifications of the same token', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('race');
    await http.post(REGISTER, { email, password: TEST_PASSWORD });
    const token = tokenFromMail(await t.mail.waitFor(email));

    const results = await Promise.all([
      http.post(VERIFY, { token, password: TEST_PASSWORD }),
      http.post(VERIFY, { token, password: TEST_PASSWORD }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it('keeps the database consistent when mail delivery fails', async () => {
    const http = client(t.app, 'customer');
    const email = uniqueEmail('smtp-down');
    t.mail.failing = true;
    try {
      const response = await http.post(REGISTER, { email, password: TEST_PASSWORD });
      expect(response.status).toBe(202);
      await t.mail.settle();
    } finally {
      t.mail.failing = false;
    }
    // Identity and one usable token exist; the user can request a new link.
    const tokens = await db(t.app).emailVerificationToken.count({
      where: { identity: { normalizedEmail: email }, consumedAt: null, invalidatedAt: null },
    });
    expect(tokens).toBe(1);
    expect(t.logs.lines.some((line) => line.security_event === 'AUTH_MAIL_DELIVERY_FAILED')).toBe(
      true,
    );
    expect((await http.post(RESEND, { email })).status).toBe(202);
    expect(tokenFromMail(await t.mail.waitFor(email))).toHaveLength(43);
  });
});
