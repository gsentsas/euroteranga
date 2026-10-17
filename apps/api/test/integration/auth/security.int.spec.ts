import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OTHER_TEST_PASSWORD,
  TEST_PASSWORD,
  client,
  cookiesOf,
  createIdentity,
  setCookieLine,
  uniqueEmail,
  uniqueIp,
  withoutRequestId,
} from '../../support/auth-helpers.js';
import {
  TEST_ORIGINS,
  integrationEnv,
  productionLikeEnv,
  startTestApp,
  type TestApp,
} from '../../support/test-app.js';

describe('authentication security controls', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('CORS and origin checks', () => {
    it('allows credentialed CORS for an exact realm origin only', async () => {
      const allowed = await request(t.app.getHttpServer())
        .options('/v1/auth/customer/login')
        .set('Origin', TEST_ORIGINS.customer)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGINS.customer);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const denied = await request(t.app.getHttpServer())
        .options('/v1/auth/customer/login')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects an unknown origin and a customer origin on the staff realm', async () => {
      const staff = await createIdentity(t.app, { realm: 'staff', enrollmentGrant: true });
      const body = JSON.stringify({ email: staff.email, password: staff.password });
      const send = (origin: string) =>
        request(t.app.getHttpServer())
          .post('/v1/auth/staff/login')
          .set('Origin', origin)
          .set('X-Forwarded-For', uniqueIp())
          .set('Content-Type', 'application/json')
          .send(body);

      const foreign = await send('https://evil.example');
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('ORIGIN_NOT_ALLOWED');
      const crossRealm = await send(TEST_ORIGINS.customer);
      expect(crossRealm.status).toBe(403);
      expect(crossRealm.body.code).toBe('ORIGIN_NOT_ALLOWED');
      expect((await send(TEST_ORIGINS.staff)).status).toBe(200);
    });

    it('refuses non-JSON bodies (no HTML-form CSRF)', async () => {
      const response = await request(t.app.getHttpServer())
        .post('/v1/auth/customer/login')
        .set('Origin', TEST_ORIGINS.customer)
        .type('form')
        .send({ email: uniqueEmail(), password: TEST_PASSWORD });
      expect(response.status).toBe(415);
    });
  });

  describe('rate limiting', () => {
    it('throttles failed logins per identity, identically for unknown accounts', async () => {
      const known = await createIdentity(t.app, { realm: 'customer' });
      const unknown = uniqueEmail('ghost');
      const responses: Record<string, number[]> = { known: [], unknown: [] };
      for (let i = 0; i < 6; i += 1) {
        // A new client address per attempt: only the identity bucket applies.
        const k = await client(t.app, 'customer').post('/v1/auth/customer/login', {
          email: known.email,
          password: OTHER_TEST_PASSWORD,
        });
        const u = await client(t.app, 'customer').post('/v1/auth/customer/login', {
          email: unknown,
          password: OTHER_TEST_PASSWORD,
        });
        responses.known!.push(k.status);
        responses.unknown!.push(u.status);
      }
      expect(responses.known).toEqual([401, 401, 401, 401, 401, 429]);
      expect(responses.unknown).toEqual(responses.known);

      const blocked = await client(t.app, 'customer').post('/v1/auth/customer/login', {
        email: known.email,
        password: known.password,
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(t.logs.lines.some((line) => line.security_event === 'AUTH_RATE_LIMITED')).toBe(true);
    });

    it('throttles registrations per client address', async () => {
      const http = client(t.app, 'customer');
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push(
          (
            await http.post('/v1/auth/customer/register', {
              email: uniqueEmail('bulk'),
              password: TEST_PASSWORD,
            })
          ).status,
        );
      }
      expect(statuses.slice(0, 10).every((status) => status === 202)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('throttles password reset requests per identity hint', async () => {
      const email = uniqueEmail('reset-spam');
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push(
          (await client(t.app, 'customer').post('/v1/auth/customer/password/forgot', { email }))
            .status,
        );
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    });

    it('ignores X-Forwarded-For unless a proxy is trusted', async () => {
      const direct = await startTestApp(integrationEnv({ API_TRUST_PROXY: 'none' }));
      try {
        const email = uniqueEmail('spoof');
        const statuses: number[] = [];
        // 31 login attempts with a different spoofed address each time: the
        // per-address limit (30) still applies because the header is ignored.
        for (let i = 0; i < 31; i += 1) {
          const response = await request(direct.app.getHttpServer())
            .post('/v1/auth/crew/login')
            .set('Origin', TEST_ORIGINS.crew)
            .set('X-Forwarded-For', uniqueIp())
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ email: `${i}.${email}`, password: OTHER_TEST_PASSWORD }));
          statuses.push(response.status);
        }
        expect(statuses[30]).toBe(429);
      } finally {
        await direct.app.close();
      }
      // 31 sequential logins, each costing an Argon2id verification (64 MiB,
      // t=3): CPU-bound by design, so it gets its own budget instead of the
      // 20 s default when the suite runs files in parallel.
    }, 60_000);
  });

  describe('production cookies', () => {
    it('sets __Host- cookies: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain', async () => {
      const prod = await startTestApp(productionLikeEnv());
      try {
        const user = await createIdentity(prod.app, { realm: 'customer' });
        const response = await request(prod.app.getHttpServer())
          .post('/v1/auth/customer/login')
          .set('Origin', 'https://client.example.test')
          .set('X-Forwarded-For', uniqueIp())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ email: user.email, password: user.password }));
        expect(response.status).toBe(200);

        const line = setCookieLine(response, '__Host-et_customer_session');
        expect(line).toBeDefined();
        const attributes = (line as string)
          .split(';')
          .slice(1)
          .map((part) => part.trim());
        expect(attributes).toEqual(
          expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']),
        );
        expect(attributes.some((attribute) => /^domain=/i.test(attribute))).toBe(false);
        expect(cookiesOf(response).et_customer_session).toBeUndefined();

        const staff = await createIdentity(prod.app, { realm: 'staff', enrollmentGrant: true });
        const challenge = await request(prod.app.getHttpServer())
          .post('/v1/auth/staff/login')
          .set('Origin', 'https://ops.example.test')
          .set('X-Forwarded-For', uniqueIp())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ email: staff.email, password: staff.password }));
        const challengeLine = setCookieLine(challenge, '__Host-et_staff_mfa') as string;
        expect(challengeLine).toMatch(/; Path=\//);
        expect(challengeLine).toMatch(/; HttpOnly/);
        expect(challengeLine).toMatch(/; Secure/);
        expect(challengeLine).toMatch(/; SameSite=Strict/);
        expect(challengeLine).not.toMatch(/domain=/i);
      } finally {
        await prod.app.close();
      }
    });

    it('marks every auth response as not cacheable', async () => {
      const response = await client(t.app, 'customer').post('/v1/auth/customer/password/forgot', {
        email: uniqueEmail(),
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('security logging', () => {
    it('logs a failed login without email, password or token', async () => {
      const email = uniqueEmail('logcheck');
      const password = 'unique synthetic passphrase for log check 11';
      await client(t.app, 'customer').post('/v1/auth/customer/login', { email, password });
      const event = t.logs.lines.find(
        (line) =>
          line.security_event === 'AUTH_LOGIN_FAILURE' && line.reason === 'unknown_identity',
      );
      expect(event).toMatchObject({
        realm: 'customer',
        subject_ref: expect.any(String),
        ip_ref: expect.any(String),
      });
      const all = t.logs.raw.join('\n');
      expect(all).not.toContain(email);
      expect(all).not.toContain(password);
    });
  });

  describe('malformed input', () => {
    it('never logs the raw body of a malformed JSON request', async () => {
      // V8 quotes only a short window around the error, so the canary is
      // checked by its distinctive first characters.
      const canary = 'zqx7';
      const secret = `${canary}-canary-passphrase-0001`;
      const response = await request(t.app.getHttpServer())
        .post('/v1/auth/customer/login')
        .set('Origin', TEST_ORIGINS.customer)
        .set('X-Forwarded-For', uniqueIp())
        .set('Content-Type', 'application/json')
        // An unquoted value: V8 quotes the surrounding payload in its error message.
        .send(`{"email":"a@example.test","password": ${secret}}`);
      expect(response.status).toBe(400);
      expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
      expect(response.text).not.toContain(canary);
      expect(t.logs.raw.join('\n')).not.toContain(canary);
    });

    it('limits registrations per address, not only per client address', async () => {
      const email = uniqueEmail('mail-bomb');
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await client(t.app, 'customer').post('/v1/auth/customer/register', {
          email,
          password: TEST_PASSWORD,
        });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    });
  });

  describe('database unavailable', () => {
    it('reports a service error, never INVALID_CREDENTIALS or an authenticated session', async () => {
      const down = await startTestApp(
        integrationEnv({
          DATABASE_URL: 'postgresql://ghost_user:ghost-password@127.0.0.1:1/ghost_database',
        }),
      );
      try {
        const http = client(down.app, 'customer');
        const login = await http.post('/v1/auth/customer/login', {
          email: uniqueEmail(),
          password: TEST_PASSWORD,
        });
        expect(login.status).toBeGreaterThanOrEqual(500);
        expect(withoutRequestId(login.body)).toEqual({
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        });
        expect(login.text).not.toContain('ghost');

        const me = await http.get('/v1/auth/customer/me', `et_customer_session=${'A'.repeat(43)}`);
        expect(me.status).toBeGreaterThanOrEqual(500);
      } finally {
        await down.app.close();
      }
    });
  });
});
