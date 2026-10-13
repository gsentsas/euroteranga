import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/authorization/permissions.js';
import { client, createIdentity, db, loginCookie } from '../../support/auth-helpers.js';
import { adminApi, createTestRole, staffActor } from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/** The role matrix documented in docs/security/authorization.md. */
const EXPECTED_MATRIX: Record<
  string,
  { realm: string; privileged: boolean; permissions: string[] }
> = {
  SUPER_ADMIN: {
    realm: 'STAFF',
    privileged: true,
    permissions: [
      'audit.read',
      'identity.read',
      'identity.staff.provision',
      'identity.status.manage',
      'mfa.enrollment.authorize',
      'network.manage',
      'network.read',
      'ops.access',
      'privileged.manage',
      'role.assign',
      'role.read',
      'session.revoke.any',
    ],
  },
  DIRECTOR: {
    realm: 'STAFF',
    privileged: false,
    permissions: [
      'audit.read',
      'identity.read',
      'identity.staff.provision',
      'identity.status.manage',
      'mfa.enrollment.authorize',
      'network.manage',
      'network.read',
      'ops.access',
      'role.assign',
      'role.read',
      'session.revoke.any',
    ],
  },
  OPS_MANAGER: {
    realm: 'STAFF',
    privileged: false,
    permissions: ['identity.read', 'network.manage', 'network.read', 'ops.access', 'role.read'],
  },
  DISPATCHER: { realm: 'STAFF', privileged: false, permissions: ['network.read', 'ops.access'] },
  BOOKING_AGENT: { realm: 'STAFF', privileged: false, permissions: ['network.read', 'ops.access'] },
  COMPLIANCE_AGENT: {
    realm: 'STAFF',
    privileged: false,
    permissions: ['network.read', 'ops.access'],
  },
  // FINANCE has no network permission by default (PR-04 matrix).
  FINANCE: { realm: 'STAFF', privileged: false, permissions: ['ops.access'] },
  CUSTOMER_SUPPORT: {
    realm: 'STAFF',
    privileged: false,
    permissions: ['network.read', 'ops.access'],
  },
  AUDITOR: {
    realm: 'STAFF',
    privileged: false,
    permissions: ['audit.read', 'identity.read', 'network.read', 'ops.access', 'role.read'],
  },
  DRIVER: { realm: 'CREW', privileged: false, permissions: [] },
  CREW: { realm: 'CREW', privileged: false, permissions: [] },
};

const ADMIN_ROUTES: Array<['GET' | 'POST', string]> = [
  ['GET', '/v1/admin/access/me'],
  ['GET', '/v1/admin/roles'],
  ['GET', '/v1/admin/identities'],
  ['GET', '/v1/admin/identities/01900000-0000-7000-8000-000000000000/access'],
  ['POST', '/v1/admin/identities/01900000-0000-7000-8000-000000000000/roles'],
  ['POST', '/v1/admin/identities/01900000-0000-7000-8000-000000000000/roles/revoke'],
  ['POST', '/v1/admin/identities/01900000-0000-7000-8000-000000000000/status'],
  ['POST', '/v1/admin/identities/01900000-0000-7000-8000-000000000000/sessions/revoke-all'],
  ['POST', '/v1/admin/staff/invitations'],
  ['POST', '/v1/admin/staff/01900000-0000-7000-8000-000000000000/mfa/enrollment-authorization'],
  ['GET', '/v1/admin/audit'],
  ['GET', '/v1/admin/network/countries'],
  ['POST', '/v1/admin/network/countries'],
  ['GET', '/v1/admin/network/stops'],
  ['GET', '/v1/admin/network/checkpoints'],
  ['GET', '/v1/admin/network/routes'],
  ['POST', '/v1/admin/network/routes'],
  ['POST', '/v1/admin/network/routes/01900000-0000-7000-8000-000000000000/versions'],
];

describe('server-side RBAC', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv());
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('seeds exactly the documented catalogue (no wildcard, every permission explicit)', async () => {
    const roles = await db(t.app).authorizationRole.findMany({
      where: { system: true },
      select: {
        key: true,
        realm: true,
        privileged: true,
        permissions: { select: { permissionKey: true } },
      },
    });
    const actual = Object.fromEntries(
      roles.map((role) => [
        role.key,
        {
          realm: role.realm,
          privileged: role.privileged,
          permissions: role.permissions.map((p) => p.permissionKey).sort(),
        },
      ]),
    );
    expect(actual).toEqual(EXPECTED_MATRIX);
    const catalogue = (
      await db(t.app).authorizationPermission.findMany({ select: { key: true } })
    ).map((p) => p.key);
    expect(catalogue.sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  it('mounts every admin endpoint and refuses them without a session', async () => {
    const http = client(t.app, 'staff');
    for (const [method, path] of ADMIN_ROUTES) {
      const response = method === 'GET' ? await http.get(path) : await http.post(path, {});
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses customer and crew sessions, and staff without roles', async () => {
    const customer = await createIdentity(t.app, { realm: 'customer' });
    const customerCookie = await loginCookie(t.app, 'customer', customer.email);
    expect((await client(t.app, 'staff').get('/v1/admin/roles', customerCookie)).status).toBe(401);

    const crew = await createIdentity(t.app, { realm: 'crew' });
    await db(t.app).authorizationRoleAssignment.create({
      data: { identityId: crew.id, roleKey: 'DRIVER' },
    });
    const crewCookie = await loginCookie(t.app, 'crew', crew.email);
    expect((await client(t.app, 'staff').get('/v1/admin/roles', crewCookie)).status).toBe(401);

    const noRole = adminApi(await staffActor(t.app));
    const denied = await noRole.get('/roles');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    // Its own (empty) access remains readable, for the OPS UI.
    expect((await noRole.get('/access/me')).body).toEqual({ roles: [], permissions: [] });
  });

  it.each(Object.keys(EXPECTED_MATRIX).filter((role) => EXPECTED_MATRIX[role]?.realm === 'STAFF'))(
    '%s: effective permissions and HTTP access match the matrix',
    async (roleKey) => {
      const expected = EXPECTED_MATRIX[roleKey]!.permissions;
      const api = adminApi(await staffActor(t.app, [roleKey]));
      expect((await api.get('/access/me')).body).toEqual({
        roles: [roleKey],
        permissions: expected,
      });

      const allowed = (permission: string) =>
        expected.includes('ops.access') && expected.includes(permission);
      expect((await api.get('/roles')).status).toBe(allowed('role.read') ? 200 : 403);
      expect((await api.get('/identities')).status).toBe(allowed('identity.read') ? 200 : 403);
      expect((await api.get('/audit')).status).toBe(allowed('audit.read') ? 200 : 403);
      expect((await api.get('/network/countries')).status).toBe(
        allowed('network.read') ? 200 : 403,
      );
    },
  );

  it('AUDITOR reads but cannot change roles, invite or change status', async () => {
    const auditor = adminApi(await staffActor(t.app, ['AUDITOR']));
    const target = await createIdentity(t.app, { realm: 'staff' });
    expect((await auditor.get('/audit')).status).toBe(200);
    expect(
      (await auditor.post(`/identities/${target.id}/roles`, { roleKey: 'DISPATCHER' })).status,
    ).toBe(403);
    expect(
      (await auditor.post('/staff/invitations', { email: 'x@example.test', roleKey: 'DISPATCHER' }))
        .status,
    ).toBe(403);
    expect(
      (await auditor.post(`/identities/${target.id}/status`, { status: 'SUSPENDED' })).status,
    ).toBe(403);
  });

  it('requires ops.access in addition to the method permission (class + method)', async () => {
    const roleReadOnly = await createTestRole(t.app, [PERMISSIONS.ROLE_READ]);
    const api = adminApi(await staffActor(t.app, [roleReadOnly]));
    expect((await api.get('/roles')).status).toBe(403);
  });

  it('requires a valid CSRF token on admin mutations', async () => {
    const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
    const target = await createIdentity(t.app, { realm: 'staff' });
    const path = `/identities/${target.id}/roles`;
    expect((await admin.post(path, { roleKey: 'DISPATCHER' }, { csrf: null })).status).toBe(403);
    expect(
      (await admin.post(path, { roleKey: 'DISPATCHER' }, { csrf: 'v1.9999999999.x.y' })).status,
    ).toBe(403);
    expect((await admin.post(path, { roleKey: 'DISPATCHER' })).status).toBe(200);
  });

  it('enforces role realms in the service and in the database', async () => {
    const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
    const customer = await createIdentity(t.app, { realm: 'customer' });
    const crew = await createIdentity(t.app, { realm: 'crew' });
    const staff = await createIdentity(t.app, { realm: 'staff' });
    const cases: Array<[string, string, number]> = [
      [customer.id, 'SUPER_ADMIN', 400],
      [crew.id, 'DIRECTOR', 400],
      [staff.id, 'DRIVER', 400],
      [staff.id, 'OPS_MANAGER', 200],
      [crew.id, 'DRIVER', 200],
    ];
    for (const [identityId, roleKey, status] of cases) {
      const response = await admin.post(`/identities/${identityId}/roles`, { roleKey });
      expect(response.status, `${roleKey}`).toBe(status);
      if (status === 400) expect(response.body.code).toBe('ROLE_REALM_MISMATCH');
    }
    await expect(
      db(t.app).authorizationRoleAssignment.create({
        data: { identityId: customer.id, roleKey: 'SUPER_ADMIN' },
      }),
    ).rejects.toThrow(/another realm/);
  });

  it('blocks privilege escalation', async () => {
    const director = adminApi(await staffActor(t.app, ['DIRECTOR']));
    const target = await createIdentity(t.app, { realm: 'staff' });
    // Privileged role without privileged.manage.
    expect(
      (await director.post(`/identities/${target.id}/roles`, { roleKey: 'SUPER_ADMIN' })).status,
    ).toBe(403);
    // A role carrying a permission the actor does not hold.
    const escalation = await createTestRole(t.app, [
      PERMISSIONS.OPS_ACCESS,
      PERMISSIONS.PRIVILEGED_MANAGE,
    ]);
    expect(
      (await director.post(`/identities/${target.id}/roles`, { roleKey: escalation })).status,
    ).toBe(403);
    // Acting on a privileged holder without privileged.manage.
    const superAdmin = await staffActor(t.app, ['SUPER_ADMIN']);
    expect(
      (await director.post(`/identities/${superAdmin.id}/status`, { status: 'SUSPENDED' })).status,
    ).toBe(403);
    expect((await director.post(`/identities/${superAdmin.id}/sessions/revoke-all`)).status).toBe(
      403,
    );
  });

  it('forbids self role changes and self status changes', async () => {
    const actor = await staffActor(t.app, ['SUPER_ADMIN', 'AUDITOR']);
    const api = adminApi(actor);
    for (const [path, body] of [
      [`/identities/${actor.id}/roles`, { roleKey: 'DIRECTOR' }],
      [`/identities/${actor.id}/roles/revoke`, { roleKey: 'AUDITOR' }],
      [`/identities/${actor.id}/status`, { status: 'SUSPENDED' }],
    ] as const) {
      const response = await api.post(path, body);
      expect(response.status, path).toBe(403);
      expect(response.body.code).toBe('SELF_MODIFICATION_FORBIDDEN');
    }
  });

  it('lets exactly one of two concurrent identical grants succeed', async () => {
    const admin = await staffActor(t.app, ['SUPER_ADMIN']);
    const api = adminApi(admin);
    const target = await createIdentity(t.app, { realm: 'staff' });
    const [csrfA, csrfB] = [await admin.csrf(), await admin.csrf()];
    const results = await Promise.all([
      api.post(`/identities/${target.id}/roles`, { roleKey: 'FINANCE' }, { csrf: csrfA }),
      api.post(`/identities/${target.id}/roles`, { roleKey: 'FINANCE' }, { csrf: csrfB }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      await db(t.app).authorizationRoleAssignment.count({
        where: { identityId: target.id, revokedAt: null },
      }),
    ).toBe(1);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'ROLE_GRANTED', resourceId: target.id },
      }),
    ).toBe(1);
  });

  it('lets exactly one of two concurrent revocations succeed, keeping history', async () => {
    const admin = await staffActor(t.app, ['SUPER_ADMIN']);
    const api = adminApi(admin);
    const target = await createIdentity(t.app, { realm: 'staff' });
    expect(
      (
        await api.post(`/identities/${target.id}/roles`, {
          roleKey: 'FINANCE',
          reason: 'grant reason',
        })
      ).status,
    ).toBe(200);
    const [csrfA, csrfB] = [await admin.csrf(), await admin.csrf()];
    const results = await Promise.all([
      api.post(
        `/identities/${target.id}/roles/revoke`,
        { roleKey: 'FINANCE', reason: 'revoke reason' },
        { csrf: csrfA },
      ),
      api.post(`/identities/${target.id}/roles/revoke`, { roleKey: 'FINANCE' }, { csrf: csrfB }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([204, 409]);
    const rows = await db(t.app).authorizationRoleAssignment.findMany({
      where: { identityId: target.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantReason: 'grant reason', revokedByIdentityId: admin.id });
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('applies a role revocation on the next request of the same session', async () => {
    const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
    const auditor = await staffActor(t.app, ['AUDITOR']);
    const auditorApi = adminApi(auditor);
    expect((await auditorApi.get('/audit')).status).toBe(200);
    expect(
      (await admin.post(`/identities/${auditor.id}/roles/revoke`, { roleKey: 'AUDITOR' })).status,
    ).toBe(204);
    expect((await auditorApi.get('/audit')).status).toBe(403);
    // The session itself is still valid: authentication ≠ authorization.
    expect((await auditor.http.get('/v1/auth/staff/me', auditor.cookie)).status).toBe(200);
  });

  it('lists identities with a minimal view and server-side pagination', async () => {
    const api = adminApi(await staffActor(t.app, ['OPS_MANAGER']));
    const first = await api.get('/identities?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(Object.keys(first.body.items[0]).sort()).toEqual(
      [
        'createdAt',
        'email',
        'emailVerifiedAt',
        'id',
        'mfaEnabled',
        'realm',
        'roles',
        'status',
      ].sort(),
    );
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const next = await api.get(`/identities?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items[0].id).not.toBe(first.body.items[0].id);
    expect((await api.get('/identities?realm=customer')).status).toBe(400);
    expect((await api.get('/identities/not-a-uuid/access')).status).toBe(400);
  });
});
