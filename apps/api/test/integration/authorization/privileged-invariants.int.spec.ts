import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/authorization/permissions.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import {
  adminApi,
  createTestRole,
  isolatedDatabase,
  staffActor,
} from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Global invariants run against a dedicated database: the number of usable
 * privileged administrators is a database-wide property that parallel test
 * files would otherwise change.
 */
describe('privileged invariants and transactional audit (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('never leaves the platform without a usable privileged administrator', async () => {
    // privileged.manage on a non-privileged test role: the only way an actor
    // can target a SUPER_ADMIN without being one (defence in depth).
    // It carries every permission, so revoking SUPER_ADMIN passes the
    // anti-escalation rule and reaches the last-administrator guard.
    const manager = await createTestRole(t.app, Object.values(PERMISSIONS));
    const superAdmin = await staffActor(t.app, ['SUPER_ADMIN']);
    const actor = adminApi(await staffActor(t.app, [manager]));

    for (const status of ['SUSPENDED', 'DISABLED']) {
      const response = await actor.post(`/identities/${superAdmin.id}/status`, { status });
      expect(response.status, status).toBe(409);
      expect(response.body.code).toBe('LAST_PRIVILEGED_ADMIN');
    }
    const revoke = await actor.post(`/identities/${superAdmin.id}/roles/revoke`, {
      roleKey: 'SUPER_ADMIN',
    });
    expect(revoke.status).toBe(409);
    expect(
      (await db(t.app).authIdentity.findUniqueOrThrow({ where: { id: superAdmin.id } })).status,
    ).toBe('ACTIVE');

    // With two usable SUPER_ADMINs, concurrent suspensions: exactly one wins.
    const second = await staffActor(t.app, ['SUPER_ADMIN']);
    const actorA = await staffActor(t.app, [manager]);
    const actorB = await staffActor(t.app, [manager]);
    const results = await Promise.all([
      adminApi(actorA).post(`/identities/${superAdmin.id}/status`, { status: 'SUSPENDED' }),
      adminApi(actorB).post(`/identities/${second.id}/status`, { status: 'SUSPENDED' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const usable = await db(t.app).authIdentity.count({
      where: { id: { in: [superAdmin.id, second.id] }, status: 'ACTIVE' },
    });
    expect(usable).toBe(1);
  });

  it('rolls the role grant back when its audit event cannot be written', async () => {
    const admin = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
    const target = await createIdentity(t.app, { realm: 'staff' });
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION test_fail_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'ROLE_GRANTED' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await db(t.app).$executeRawUnsafe(
      'CREATE TRIGGER test_fail_role_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_role_audit()',
    );
    try {
      const response = await admin.post(`/identities/${target.id}/roles`, {
        roleKey: 'DISPATCHER',
      });
      expect(response.status).toBe(500);
      expect(
        await db(t.app).authorizationRoleAssignment.count({ where: { identityId: target.id } }),
      ).toBe(0);
    } finally {
      await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_role_audit ON audit_event');
      await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_role_audit()');
    }
    expect(
      (await admin.post(`/identities/${target.id}/roles`, { roleKey: 'DISPATCHER' })).status,
    ).toBe(200);
  });
});
