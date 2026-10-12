import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generateTotpCode } from '../../src/auth/mfa/totp.js';
import { client, cookiesOf, createIdentity, csrfToken, db, uniqueIp } from './auth-helpers.js';

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/, ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

export interface StaffActor {
  id: string;
  email: string;
  password: string;
  cookie: string;
  ip: string;
  http: ReturnType<typeof client>;
  /** Fresh CSRF token bound to the actor's session. */
  csrf: () => Promise<string>;
}

/**
 * Test fixture: a STAFF identity holding the given roles, enrolled in TOTP
 * through the real HTTP flow (grant → challenge → enrollment), with a live
 * STAFF session.
 */
export async function staffActor(
  app: NestExpressApplication,
  roles: readonly string[] = [],
): Promise<StaffActor> {
  const identity = await createIdentity(app, { realm: 'staff', enrollmentGrant: true });
  for (const roleKey of roles) {
    await db(app).authorizationRoleAssignment.create({
      data: { identityId: identity.id, roleKey, grantReason: 'test fixture' },
    });
  }
  const ip = uniqueIp();
  const http = client(app, 'staff', ip);
  const login = await http.post('/v1/auth/staff/login', {
    email: identity.email,
    password: identity.password,
  });
  const challenge = `et_staff_mfa=${cookiesOf(login).et_staff_mfa}`;
  const start = await http.post('/v1/auth/staff/mfa/enrollment/start', {}, challenge);
  const secret = base32Decode(start.body.secret as string);
  const confirm = await http.post(
    '/v1/auth/staff/mfa/enrollment/confirm',
    { code: generateTotpCode(secret) },
    challenge,
  );
  if (confirm.status !== 200)
    throw new Error(`staff enrollment failed: ${confirm.status} ${confirm.text}`);
  const cookie = `et_staff_session=${cookiesOf(confirm).et_staff_session}`;
  return { ...identity, cookie, ip, http, csrf: () => csrfToken(app, 'staff', cookie) };
}

/** Authenticated admin call helpers (session cookie, origin, client address, CSRF). */
export function adminApi(actor: StaffActor) {
  return {
    get: (path: string) => actor.http.get(`/v1/admin${path}`, actor.cookie),
    post: async (path: string, body: unknown = {}, options: { csrf?: string | null } = {}) => {
      const csrf = options.csrf === undefined ? await actor.csrf() : (options.csrf ?? undefined);
      return actor.http.post(`/v1/admin${path}`, body, actor.cookie, csrf);
    },
  };
}

/** Creates a test-only role (realm STAFF unless stated) with the given permissions. */
export async function createTestRole(
  app: NestExpressApplication,
  permissions: readonly string[],
  options: { realm?: 'STAFF' | 'CREW'; privileged?: boolean } = {},
): Promise<string> {
  const key = `TEST_${randomBytes(4).toString('hex').toUpperCase()}`;
  await db(app).authorizationRole.create({
    data: {
      key,
      name: key,
      description: 'test-only role',
      realm: options.realm ?? 'STAFF',
      privileged: options.privileged ?? false,
      system: false,
      permissions: { create: permissions.map((permissionKey) => ({ permissionKey })) },
    },
  });
  return key;
}

const DATABASE_PACKAGE = fileURLToPath(new URL('../../../../packages/database/', import.meta.url));

/**
 * A dedicated, fully migrated database for tests whose invariants are global
 * (e.g. "at least one usable SUPER_ADMIN", bootstrap): other test files run in
 * parallel against the shared database and would interfere.
 */
export async function isolatedDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required');
  const name = `et_iso_${randomBytes(6).toString('hex')}`;
  const admin = createDatabaseClient({ databaseUrl: base });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: DATABASE_PACKAGE,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'ignore',
  });
  return {
    url: url.toString(),
    drop: async () => {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    },
  };
}
