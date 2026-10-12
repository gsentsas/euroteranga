import { createHash } from 'node:crypto';
import { AuthIdentityStatus } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  client,
  createIdentity,
  db,
  uniqueEmail,
} from '../../support/auth-helpers.js';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { tokenFromMail } from '../../support/fake-auth-mail.provider.js';
import {
  TEST_ORIGINS,
  integrationEnv,
  startTestApp,
  type TestApp,
} from '../../support/test-app.js';

const ACCEPT = '/v1/auth/staff/invitation/accept';
const NEW_PASSWORD = 'invited staff synthetic passphrase 31';

describe('controlled STAFF provisioning', () => {
  let t: TestApp;
  let admin: StaffActor;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
  });

  afterAll(async () => {
    await t.app.close();
  });

  async function invite(email: string, roleKey = 'DISPATCHER', actor = admin) {
    return adminApi(actor).post('/staff/invitations', { email, roleKey });
  }

  it('runs the full flow: invite → mail → accept → ACTIVE + role + grant → enrollment', async () => {
    const email = uniqueEmail('invited');
    const invited = await invite(email);
    expect(invited.status).toBe(202);
    expect(invited.body).toMatchObject({
      status: 'INVITATION_SENT',
      identityId: expect.any(String),
    });

    const mail = await t.mail.waitFor(email);
    expect(mail.text).toContain(`${TEST_ORIGINS.staff}/invitation#token=`);
    expect(mail.text).not.toMatch(/[?&]token=/);
    const token = tokenFromMail(mail);
    const stored = await db(t.app).staffInvitation.findFirstOrThrow({
      where: { identityId: invited.body.identityId },
    });
    expect(Buffer.from(stored.tokenHash)).toEqual(createHash('sha256').update(token).digest());
    expect(t.logs.raw.join('\n')).not.toContain(token);

    const http = client(t.app, 'staff');
    const accepted = await http.post(ACCEPT, { token, newPassword: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    expect((await http.post(ACCEPT, { token, newPassword: NEW_PASSWORD })).body.code).toBe(
      'INVALID_OR_EXPIRED_INVITATION',
    );

    const identity = await db(t.app).authIdentity.findUniqueOrThrow({
      where: { id: invited.body.identityId },
      include: {
        passwordCredential: true,
        staffEnrollmentGrant: true,
        roleAssignments: { where: { revokedAt: null } },
      },
    });
    expect(identity.status).toBe(AuthIdentityStatus.ACTIVE);
    expect(identity.passwordCredential?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(identity.roleAssignments.map((assignment) => assignment.roleKey)).toEqual([
      'DISPATCHER',
    ]);
    expect(identity.staffEnrollmentGrant?.consumedAt).toBeNull();
    expect(
      await db(t.app).auditEvent.count({
        where: {
          resourceId: identity.id,
          action: { in: ['STAFF_INVITED', 'STAFF_INVITATION_ACCEPTED'] },
        },
      }),
    ).toBe(2);
    const auditText = JSON.stringify(
      await db(t.app).auditEvent.findMany({ where: { resourceId: identity.id } }),
    );
    expect(auditText).not.toContain(token);
    expect(auditText).not.toContain(NEW_PASSWORD);

    const login = await http.post('/v1/auth/staff/login', { email, password: NEW_PASSWORD });
    expect(login.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED' });
  });

  it('accepts exactly one of two concurrent acceptances of one invitation', async () => {
    const email = uniqueEmail('race');
    await invite(email);
    const token = tokenFromMail(await t.mail.waitFor(email));
    const results = await Promise.all([
      client(t.app, 'staff').post(ACCEPT, { token, newPassword: NEW_PASSWORD }),
      client(t.app, 'staff').post(ACCEPT, { token, newPassword: NEW_PASSWORD }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it('re-invitation of a pending account supersedes the previous link', async () => {
    const email = uniqueEmail('reinvite');
    await invite(email);
    const first = tokenFromMail(await t.mail.waitFor(email));
    expect((await invite(email)).status).toBe(202);
    const second = tokenFromMail(await t.mail.waitFor(email, 2));
    expect(
      (await client(t.app, 'staff').post(ACCEPT, { token: first, newPassword: NEW_PASSWORD }))
        .status,
    ).toBe(400);
    expect(
      (await client(t.app, 'staff').post(ACCEPT, { token: second, newPassword: NEW_PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('refuses to invite an existing active STAFF account and leaves it untouched', async () => {
    const existing = await staffActor(t.app, ['AUDITOR']);
    const before = await db(t.app).passwordCredential.findUniqueOrThrow({
      where: { identityId: existing.id },
    });
    const response = await invite(existing.email, 'DIRECTOR');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STAFF_ALREADY_EXISTS');
    const after = await db(t.app).passwordCredential.findUniqueOrThrow({
      where: { identityId: existing.id },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    const roles = await db(t.app).authorizationRoleAssignment.findMany({
      where: { identityId: existing.id, revokedAt: null },
    });
    expect(roles.map((role) => role.roleKey)).toEqual(['AUDITOR']);
    expect(
      await db(t.app).mfaTotpCredential.count({
        where: { identityId: existing.id, enabledAt: { not: null } },
      }),
    ).toBe(1);
  });

  it('enforces permissions, CSRF and anti-escalation on invitations', async () => {
    const director = await staffActor(t.app, ['DIRECTOR']);
    expect((await invite(uniqueEmail(), 'SUPER_ADMIN', director)).status).toBe(403);
    expect((await invite(uniqueEmail(), 'DRIVER')).status).toBe(400);
    const opsManager = await staffActor(t.app, ['OPS_MANAGER']);
    expect((await invite(uniqueEmail(), 'DISPATCHER', opsManager)).status).toBe(403);
    const noCsrf = await adminApi(admin).post(
      '/staff/invitations',
      { email: uniqueEmail(), roleKey: 'DISPATCHER' },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);
  });

  it('rejects weak passwords and expired invitations', async () => {
    const email = uniqueEmail('weak');
    const invited = await invite(email);
    const token = tokenFromMail(await t.mail.waitFor(email));
    expect(
      (await client(t.app, 'staff').post(ACCEPT, { token, newPassword: 'short' })).status,
    ).toBe(422);
    await db(t.app).staffInvitation.updateMany({
      where: { identityId: invited.body.identityId },
      data: { createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await client(t.app, 'staff').post(ACCEPT, { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(400);
  });

  it('re-authorizes first MFA enrollment after the grant expired, never once MFA is enabled', async () => {
    const staff = await createIdentity(t.app, {
      realm: 'staff',
      enrollmentGrant: { expiresAt: new Date(Date.now() - 1000) },
    });
    const http = client(t.app, 'staff');
    expect(
      (await http.post('/v1/auth/staff/login', { email: staff.email, password: TEST_PASSWORD }))
        .status,
    ).toBe(401);

    const authorized = await adminApi(admin).post(
      `/staff/${staff.id}/mfa/enrollment-authorization`,
    );
    expect(authorized.status).toBe(200);
    expect(
      (await http.post('/v1/auth/staff/login', { email: staff.email, password: TEST_PASSWORD }))
        .body,
    ).toEqual({
      status: 'MFA_ENROLLMENT_REQUIRED',
    });
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'STAFF_MFA_ENROLLMENT_AUTHORIZED', resourceId: staff.id },
      }),
    ).toBe(1);

    const enrolled = await staffActor(t.app, ['DISPATCHER']);
    const refused = await adminApi(admin).post(
      `/staff/${enrolled.id}/mfa/enrollment-authorization`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('MFA_ALREADY_ENABLED');
  });

  it('exposes no public staff/crew registration and no bootstrap endpoint', async () => {
    const http = client(t.app, 'staff');
    for (const path of [
      '/v1/auth/staff/register',
      '/v1/auth/crew/register',
      '/v1/bootstrap',
      '/v1/admin/bootstrap',
      '/v1/super-admin/register',
    ]) {
      expect(
        (await http.post(path, { email: uniqueEmail(), password: NEW_PASSWORD })).status,
        path,
      ).toBe(404);
    }
  });
});
