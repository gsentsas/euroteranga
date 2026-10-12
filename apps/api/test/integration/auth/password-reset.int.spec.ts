import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OTHER_TEST_PASSWORD,
  TEST_PASSWORD,
  client,
  createIdentity,
  db,
  loginCookie,
  uniqueEmail,
  withoutRequestId,
} from '../../support/auth-helpers.js';
import { tokenFromMail } from '../../support/fake-auth-mail.provider.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const FORGOT = '/v1/auth/customer/password/forgot';
const RESET = '/v1/auth/customer/password/reset';

describe('customer password reset', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('answers identically for existing and unknown addresses', async () => {
    const http = client(t.app, 'customer');
    const user = await createIdentity(t.app, { realm: 'customer' });
    const known = await http.post(FORGOT, { email: user.email });
    const unknown = await http.post(FORGOT, { email: uniqueEmail('nobody') });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(withoutRequestId(known.body)).toEqual(withoutRequestId(unknown.body));
    expect(known.body.message).toBe(
      'Si un compte correspondant existe, les instructions ont été envoyées.',
    );
    expect((await t.mail.waitFor(user.email)).subject).toContain('réinitialisation');
  });

  it('sends nothing to suspended, disabled or pending accounts', async () => {
    const http = client(t.app, 'customer');
    for (const status of [
      AuthIdentityStatus.SUSPENDED,
      AuthIdentityStatus.DISABLED,
      AuthIdentityStatus.PENDING_VERIFICATION,
    ]) {
      const user = await createIdentity(t.app, { realm: 'customer', status });
      expect((await http.post(FORGOT, { email: user.email })).status).toBe(202);
      await t.mail.settle();
      expect(t.mail.to(user.email)).toHaveLength(0);
    }
  });

  it('resets the password, revokes every session and burns the token', async () => {
    const http = client(t.app, 'customer');
    const user = await createIdentity(t.app, { realm: 'customer' });
    const sessionA = await loginCookie(t.app, 'customer', user.email);
    const sessionB = await loginCookie(t.app, 'customer', user.email);

    await http.post(FORGOT, { email: user.email });
    const token = tokenFromMail(await t.mail.waitFor(user.email));

    const reset = await http.post(RESET, { token, newPassword: OTHER_TEST_PASSWORD });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ status: 'PASSWORD_RESET' });
    // No automatic login after a reset.
    expect(reset.headers['set-cookie']).toBeUndefined();

    expect((await http.get('/v1/auth/customer/me', sessionA)).status).toBe(401);
    expect((await http.get('/v1/auth/customer/me', sessionB)).status).toBe(401);
    expect(
      (await http.post('/v1/auth/customer/login', { email: user.email, password: TEST_PASSWORD }))
        .status,
    ).toBe(401);
    expect(
      (
        await http.post('/v1/auth/customer/login', {
          email: user.email,
          password: OTHER_TEST_PASSWORD,
        })
      ).status,
    ).toBe(200);

    const reuse = await http.post(RESET, {
      token,
      newPassword: 'yet another synthetic passphrase 3',
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    // A security notice is sent after the change.
    expect((await t.mail.waitFor(user.email, 2)).subject).toContain('modifié');
  });

  it('accepts exactly one of two concurrent resets with the same token', async () => {
    const http = client(t.app, 'customer');
    const user = await createIdentity(t.app, { realm: 'customer' });
    await http.post(FORGOT, { email: user.email });
    const token = tokenFromMail(await t.mail.waitFor(user.email));

    const results = await Promise.all([
      http.post(RESET, { token, newPassword: OTHER_TEST_PASSWORD }),
      http.post(RESET, { token, newPassword: 'a different synthetic passphrase 5' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it('supersedes the previous link when a new reset is requested', async () => {
    const http = client(t.app, 'customer');
    const user = await createIdentity(t.app, { realm: 'customer' });
    await http.post(FORGOT, { email: user.email });
    const first = tokenFromMail(await t.mail.waitFor(user.email));
    await http.post(FORGOT, { email: user.email });
    const second = tokenFromMail(await t.mail.waitFor(user.email, 2));

    expect(
      (await http.post(RESET, { token: first, newPassword: OTHER_TEST_PASSWORD })).status,
    ).toBe(400);
    expect(
      (await http.post(RESET, { token: second, newPassword: OTHER_TEST_PASSWORD })).status,
    ).toBe(200);
  });

  it('rejects expired tokens and weak new passwords (without consuming the token)', async () => {
    const http = client(t.app, 'customer');
    const user = await createIdentity(t.app, { realm: 'customer' });
    await http.post(FORGOT, { email: user.email });
    const token = tokenFromMail(await t.mail.waitFor(user.email));

    const weak = await http.post(RESET, { token, newPassword: user.email + ' 2026' });
    expect(weak.status).toBe(422);
    expect(weak.body.message).toContain('adresse e-mail');

    await db(t.app).passwordResetToken.updateMany({
      where: { identityId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await http.post(RESET, { token, newPassword: OTHER_TEST_PASSWORD })).status).toBe(400);
  });

  it('does not expose a public reset flow for staff or crew', async () => {
    const staff = client(t.app, 'staff');
    expect(
      (await staff.post('/v1/auth/staff/password/forgot', { email: uniqueEmail() })).status,
    ).toBe(404);
    expect(
      (
        await staff.post('/v1/auth/staff/register', {
          email: uniqueEmail(),
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await client(t.app, 'crew').post('/v1/auth/crew/register', {
          email: uniqueEmail(),
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(404);
  });
});
