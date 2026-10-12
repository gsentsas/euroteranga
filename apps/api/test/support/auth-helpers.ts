import { randomBytes, randomInt } from 'node:crypto';
import { AuthIdentityStatus, AuthRealm, type PrismaClient } from '@euroteranga/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { hashPassword } from '../../src/auth/crypto/password-hasher.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { TEST_ORIGINS } from './test-app.js';

export type TestRealm = 'customer' | 'staff' | 'crew';

/** Synthetic passphrases (test-only, never real credentials). */
export const TEST_PASSWORD = 'synthetic passphrase for tests only 7';
export const OTHER_TEST_PASSWORD = 'another synthetic passphrase for tests 9';

export function uniqueEmail(label = 'user'): string {
  return `${label}.${randomBytes(6).toString('hex')}@example.test`;
}

/** A distinct client address per test keeps rate-limit buckets isolated. */
export function uniqueIp(): string {
  return `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

export function db(app: NestExpressApplication): PrismaClient {
  return app.get(DatabaseService).client;
}

const DB_REALMS: Record<TestRealm, AuthRealm> = {
  customer: AuthRealm.CUSTOMER,
  staff: AuthRealm.STAFF,
  crew: AuthRealm.CREW,
};

/**
 * Test fixture: creates an identity directly in the database (STAFF and CREW
 * have no public registration; this is the controlled fixture path).
 */
export async function createIdentity(
  app: NestExpressApplication,
  options: {
    realm: TestRealm;
    email?: string;
    password?: string;
    status?: AuthIdentityStatus;
    /**
     * STAFF only: an administrator's first-MFA-enrollment authorization
     * (PR-03). Without it, a STAFF identity without TOTP cannot enroll.
     */
    enrollmentGrant?: boolean | { expiresAt?: Date; consumedAt?: Date | null };
  },
): Promise<{ id: string; email: string; password: string }> {
  const email = options.email ?? uniqueEmail(options.realm);
  const password = options.password ?? TEST_PASSWORD;
  const status = options.status ?? AuthIdentityStatus.ACTIVE;
  const identity = await db(app).authIdentity.create({
    data: {
      realm: DB_REALMS[options.realm],
      email,
      normalizedEmail: email.toLowerCase(),
      status,
      emailVerifiedAt: status === AuthIdentityStatus.PENDING_VERIFICATION ? null : new Date(),
      passwordCredential: { create: { passwordHash: await hashPassword(password) } },
    },
    select: { id: true },
  });
  if (options.enrollmentGrant) {
    const grant = options.enrollmentGrant === true ? {} : options.enrollmentGrant;
    await db(app).staffEnrollmentGrant.create({
      data: {
        identityId: identity.id,
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: grant.expiresAt ?? new Date(Date.now() + 3_600_000),
        consumedAt: grant.consumedAt ?? null,
      },
    });
  }
  return { id: identity.id, email, password };
}

/** Extracts `name=value` pairs from Set-Cookie headers. */
export function cookiesOf(response: Response): Record<string, string> {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  const cookies: Record<string, string> = {};
  for (const line of header ?? []) {
    const [pair] = line.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return cookies;
}

export function setCookieLine(response: Response, name: string): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((line) => line.startsWith(`${name}=`));
}

/** Small HTTP client bound to one app, one origin and one client address. */
export function client(app: NestExpressApplication, realm: TestRealm, ip = uniqueIp()) {
  const server = app.getHttpServer();
  const origin = TEST_ORIGINS[realm];
  const post = (path: string, body: unknown = {}, cookie?: string, csrf?: string) => {
    let call = request(server)
      .post(path)
      .set('Origin', origin)
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json');
    if (cookie) call = call.set('Cookie', cookie);
    if (csrf) call = call.set('X-CSRF-Token', csrf);
    return call.send(JSON.stringify(body));
  };
  const get = (path: string, cookie?: string) => {
    let call = request(server).get(path).set('Origin', origin).set('X-Forwarded-For', ip);
    if (cookie) call = call.set('Cookie', cookie);
    return call;
  };
  return { post, get, ip, origin };
}

/** Logs in (non-MFA realm) and returns the session cookie header value. */
export async function loginCookie(
  app: NestExpressApplication,
  realm: 'customer' | 'crew',
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await client(app, realm).post(`/v1/auth/${realm}/login`, { email, password });
  if (response.status !== 200) throw new Error(`login failed: ${response.status} ${response.text}`);
  const name = `et_${realm}_session`;
  const value = cookiesOf(response)[name];
  if (!value) throw new Error('no session cookie');
  return `${name}=${value}`;
}

export async function csrfToken(
  app: NestExpressApplication,
  realm: TestRealm,
  cookie: string,
): Promise<string> {
  const response = await client(app, realm).get(`/v1/auth/${realm}/csrf`, cookie);
  if (response.status !== 200) throw new Error(`csrf failed: ${response.status}`);
  return (response.body as { csrfToken: string }).csrfToken;
}

/** Public error bodies minus the per-request id, for equality checks. */
export function withoutRequestId(body: unknown): unknown {
  const { requestId: _requestId, ...rest } = body as Record<string, unknown>;
  return rest;
}
