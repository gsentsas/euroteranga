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
  loginCookie,
  uniqueEmail,
  withoutRequestId,
} from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('login, sessions and realm isolation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('enumeration resistance', () => {
    it('gives the same answer for every login failure cause', async () => {
      const http = client(t.app, 'customer');
      const active = await createIdentity(t.app, { realm: 'customer' });
      const suspended = await createIdentity(t.app, {
        realm: 'customer',
        status: AuthIdentityStatus.SUSPENDED,
      });
      const disabled = await createIdentity(t.app, {
        realm: 'customer',
        status: AuthIdentityStatus.DISABLED,
      });
      const pending = await createIdentity(t.app, {
        realm: 'customer',
        status: AuthIdentityStatus.PENDING_VERIFICATION,
      });

      const attempts = await Promise.all([
        http.post('/v1/auth/customer/login', {
          email: uniqueEmail('ghost'),
          password: TEST_PASSWORD,
        }),
        http.post('/v1/auth/customer/login', {
          email: active.email,
          password: OTHER_TEST_PASSWORD,
        }),
        http.post('/v1/auth/customer/login', { email: suspended.email, password: TEST_PASSWORD }),
        http.post('/v1/auth/customer/login', { email: disabled.email, password: TEST_PASSWORD }),
        http.post('/v1/auth/customer/login', { email: pending.email, password: TEST_PASSWORD }),
      ]);
      for (const response of attempts) {
        expect(response.status).toBe(401);
        expect(withoutRequestId(response.body)).toEqual({
          code: 'INVALID_CREDENTIALS',
          message: 'Email ou mot de passe incorrect.',
        });
        expect(cookiesOf(response)).toEqual({});
      }
    });

    it('spends comparable Argon2 work when the account does not exist', async () => {
      const http = client(t.app, 'customer');
      const active = await createIdentity(t.app, { realm: 'customer' });
      const time = async (email: string) => {
        const started = performance.now();
        await http.post('/v1/auth/customer/login', { email, password: OTHER_TEST_PASSWORD });
        return performance.now() - started;
      };
      // Warm up, then compare medians of a few runs per path.
      await time(active.email);
      const unknown: number[] = [];
      const wrong: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        unknown.push(await time(uniqueEmail('ghost')));
        wrong.push(await time(active.email));
      }
      const median = (values: number[]) => values.sort((a, b) => a - b)[1] as number;
      // Not a constant-time guarantee: only that the unknown path is not trivially faster.
      expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.5);
    });
  });

  describe('credential storage', () => {
    it('stores Argon2id hashes only, salted per identity', async () => {
      const a = await createIdentity(t.app, { realm: 'customer' });
      const b = await createIdentity(t.app, { realm: 'customer' });
      const hashes = await db(t.app).passwordCredential.findMany({
        where: { identityId: { in: [a.id, b.id] } },
        select: { passwordHash: true },
      });
      expect(hashes).toHaveLength(2);
      for (const { passwordHash } of hashes) {
        expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
        expect(passwordHash).not.toContain(TEST_PASSWORD);
      }
      expect(hashes[0]!.passwordHash).not.toBe(hashes[1]!.passwordHash);
    });

    it('never writes the raw session token to the database', async () => {
      const user = await createIdentity(t.app, { realm: 'customer' });
      const cookie = await loginCookie(t.app, 'customer', user.email);
      const token = cookie.split('=')[1] as string;

      const session = await db(t.app).authSession.findFirstOrThrow({
        where: { identityId: user.id },
        select: { tokenHash: true },
      });
      expect(Buffer.from(session.tokenHash)).toEqual(createHash('sha256').update(token).digest());

      for (const table of [
        'auth_session',
        'auth_identity',
        'auth_rate_limit_bucket',
        'password_credential',
      ]) {
        const rows = await db(t.app).$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "${table}" t WHERE row_to_json(t)::text LIKE '%' || $1 || '%'`,
          token,
        );
        expect(Number(rows[0]?.n)).toBe(0);
      }
    });
  });

  describe('realm isolation', () => {
    it('keeps the same email in two realms as two unrelated identities', async () => {
      const email = uniqueEmail('shared');
      await createIdentity(t.app, { realm: 'customer', email, password: TEST_PASSWORD });
      await createIdentity(t.app, { realm: 'crew', email, password: OTHER_TEST_PASSWORD });

      const customerCookie = await loginCookie(t.app, 'customer', email, TEST_PASSWORD);
      const crewCookie = await loginCookie(t.app, 'crew', email, OTHER_TEST_PASSWORD);
      const customerMe = await client(t.app, 'customer').get(
        '/v1/auth/customer/me',
        customerCookie,
      );
      const crewMe = await client(t.app, 'crew').get('/v1/auth/crew/me', crewCookie);
      expect(customerMe.body.id).not.toBe(crewMe.body.id);

      // A password from one realm does not open the other.
      const crossed = await client(t.app, 'crew').post('/v1/auth/crew/login', {
        email,
        password: TEST_PASSWORD,
      });
      expect(crossed.status).toBe(401);
    });

    it('never accepts a customer session in another realm', async () => {
      const email = uniqueEmail('isolated');
      await createIdentity(t.app, { realm: 'customer', email });
      await createIdentity(t.app, { realm: 'staff', email });
      const customerCookie = await loginCookie(t.app, 'customer', email);
      const token = customerCookie.split('=')[1] as string;

      // Customer cookie sent to the staff realm: no staff cookie at all.
      expect((await client(t.app, 'staff').get('/v1/auth/staff/me', customerCookie)).status).toBe(
        401,
      );
      // Customer token placed under the staff cookie name: realm mismatch.
      expect(
        (await client(t.app, 'staff').get('/v1/auth/staff/me', `et_staff_session=${token}`)).status,
      ).toBe(401);
      expect(
        (await client(t.app, 'crew').get('/v1/auth/crew/me', `et_crew_session=${token}`)).status,
      ).toBe(401);
    });

    it('refuses a staff session obtained from a password alone', async () => {
      const staff = await createIdentity(t.app, { realm: 'staff' });
      const response = await client(t.app, 'staff').post('/v1/auth/staff/login', {
        email: staff.email,
        password: staff.password,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED' });
      expect(cookiesOf(response).et_staff_session).toBeUndefined();
      expect(await db(t.app).authSession.count({ where: { identityId: staff.id } })).toBe(0);
    });
  });

  describe('session lifecycle', () => {
    async function session(realm: 'customer' | 'crew' = 'customer') {
      const user = await createIdentity(t.app, { realm });
      const cookie = await loginCookie(t.app, realm, user.email);
      return { user, cookie, http: client(t.app, realm) };
    }

    it('expires idle sessions', async () => {
      const { user, cookie, http } = await session();
      await db(t.app).authSession.updateMany({
        where: { identityId: user.id },
        data: { idleExpiresAt: new Date(Date.now() - 1000) },
      });
      expect((await http.get('/v1/auth/customer/me', cookie)).status).toBe(401);
    });

    it('expires sessions at their absolute lifetime', async () => {
      const { user, cookie, http } = await session('crew');
      await db(t.app).authSession.updateMany({
        where: { identityId: user.id },
        data: {
          idleExpiresAt: new Date(Date.now() - 2000),
          absoluteExpiresAt: new Date(Date.now() - 1000),
        },
      });
      expect((await http.get('/v1/auth/crew/me', cookie)).status).toBe(401);
    });

    it('invalidates every session when authVersion changes', async () => {
      const { user, cookie, http } = await session();
      await db(t.app).authIdentity.update({
        where: { id: user.id },
        data: { authVersion: { increment: 1 } },
      });
      expect((await http.get('/v1/auth/customer/me', cookie)).status).toBe(401);
    });

    it('invalidates sessions of an identity that becomes disabled', async () => {
      const { user, cookie, http } = await session();
      await db(t.app).authIdentity.update({
        where: { id: user.id },
        data: { status: AuthIdentityStatus.DISABLED },
      });
      expect((await http.get('/v1/auth/customer/me', cookie)).status).toBe(401);
    });

    it('refreshes lastSeenAt at most once per five minutes', async () => {
      const { user, cookie, http } = await session();
      const read = () =>
        db(t.app).authSession.findFirstOrThrow({
          where: { identityId: user.id },
          select: { lastSeenAt: true },
        });

      const initial = (await read()).lastSeenAt;
      await http.get('/v1/auth/customer/me', cookie);
      expect((await read()).lastSeenAt).toEqual(initial);

      const old = new Date(Date.now() - 6 * 60_000);
      await db(t.app).authSession.updateMany({
        where: { identityId: user.id },
        data: { lastSeenAt: old },
      });
      await http.get('/v1/auth/customer/me', cookie);
      expect((await read()).lastSeenAt.getTime()).toBeGreaterThan(old.getTime() + 60_000);
    });

    it('exposes minimal session details', async () => {
      const { cookie, http } = await session();
      const response = await http.get('/v1/auth/customer/session', cookie);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object).sort()).toEqual([
        'absoluteExpiresAt',
        'createdAt',
        'idleExpiresAt',
      ]);
    });

    it('logs out idempotently and clears the cookie', async () => {
      const { cookie, http } = await session();
      const csrf = await csrfToken(t.app, 'customer', cookie);
      const first = await http.post('/v1/auth/customer/logout', {}, cookie, csrf);
      expect(first.status).toBe(204);
      expect(first.headers['set-cookie']?.[0]).toMatch(/^et_customer_session=;/);
      const again = await http.post('/v1/auth/customer/logout', {}, cookie, csrf);
      expect(again.status).toBe(204);
      expect((await http.get('/v1/auth/customer/me', cookie)).status).toBe(401);
    });

    it('revokes every session of the caller', async () => {
      const user = await createIdentity(t.app, { realm: 'customer' });
      const a = await loginCookie(t.app, 'customer', user.email);
      const b = await loginCookie(t.app, 'customer', user.email);
      const http = client(t.app, 'customer');
      const response = await http.post(
        '/v1/auth/customer/sessions/revoke-all',
        {},
        a,
        await csrfToken(t.app, 'customer', a),
      );
      expect(response.status).toBe(204);
      expect((await http.get('/v1/auth/customer/me', a)).status).toBe(401);
      expect((await http.get('/v1/auth/customer/me', b)).status).toBe(401);
    });
  });

  describe('password change', () => {
    it('rotates the session: old sessions and CSRF tokens die, the new cookie works', async () => {
      const user = await createIdentity(t.app, { realm: 'customer' });
      const current = await loginCookie(t.app, 'customer', user.email);
      const other = await loginCookie(t.app, 'customer', user.email);
      const http = client(t.app, 'customer');
      const csrf = await csrfToken(t.app, 'customer', current);

      const changed = await http.post(
        '/v1/auth/customer/password/change',
        { currentPassword: TEST_PASSWORD, newPassword: OTHER_TEST_PASSWORD },
        current,
        csrf,
      );
      expect(changed.status).toBe(200);
      const rotated = `et_customer_session=${cookiesOf(changed).et_customer_session}`;

      expect((await http.get('/v1/auth/customer/me', current)).status).toBe(401);
      expect((await http.get('/v1/auth/customer/me', other)).status).toBe(401);
      expect((await http.get('/v1/auth/customer/me', rotated)).status).toBe(200);
      // The CSRF token of the old session is useless on the new one.
      expect((await http.post('/v1/auth/customer/logout', {}, rotated, csrf)).status).toBe(403);
      // Old password no longer works, new one does.
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
    });

    it('rejects a wrong current password and a weak new one', async () => {
      const user = await createIdentity(t.app, { realm: 'crew' });
      const cookie = await loginCookie(t.app, 'crew', user.email);
      const http = client(t.app, 'crew');
      const csrf = await csrfToken(t.app, 'crew', cookie);
      const wrong = await http.post(
        '/v1/auth/crew/password/change',
        { currentPassword: OTHER_TEST_PASSWORD, newPassword: 'a brand new long passphrase 42' },
        cookie,
        csrf,
      );
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('CURRENT_PASSWORD_INVALID');
      const weak = await http.post(
        '/v1/auth/crew/password/change',
        { currentPassword: TEST_PASSWORD, newPassword: 'aaaaaaaaaaaaaaaaaaaa' },
        cookie,
        csrf,
      );
      expect(weak.status).toBe(422);
    });
  });

  describe('CSRF', () => {
    it('requires a valid token bound to the current session', async () => {
      const user = await createIdentity(t.app, { realm: 'customer' });
      const a = await loginCookie(t.app, 'customer', user.email);
      const b = await loginCookie(t.app, 'customer', user.email);
      const http = client(t.app, 'customer');
      const tokenA = await csrfToken(t.app, 'customer', a);

      const missing = await http.post('/v1/auth/customer/logout', {}, a);
      expect(missing.status).toBe(403);
      expect(missing.body.code).toBe('CSRF_TOKEN_INVALID');
      expect((await http.post('/v1/auth/customer/logout', {}, a, 'v1.9999999999.x.y')).status).toBe(
        403,
      );
      const tampered = `${tokenA.slice(0, -2)}${tokenA.endsWith('AA') ? 'BB' : 'AA'}`;
      expect((await http.post('/v1/auth/customer/logout', {}, a, tampered)).status).toBe(403);
      // Token of session A used with session B.
      expect((await http.post('/v1/auth/customer/logout', {}, b, tokenA)).status).toBe(403);
      // Session B is still alive after those refusals; the right token works.
      expect((await http.get('/v1/auth/customer/me', b)).status).toBe(200);
      expect((await http.post('/v1/auth/customer/logout', {}, a, tokenA)).status).toBe(204);
    });

    it('requires a session to obtain a CSRF token', async () => {
      expect((await client(t.app, 'customer').get('/v1/auth/customer/csrf')).status).toBe(401);
    });
  });
});
