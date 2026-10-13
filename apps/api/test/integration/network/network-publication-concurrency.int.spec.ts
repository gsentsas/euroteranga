import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { createDraft, publishableDraft, stopWaypoint } from '../../support/network-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Publication under concurrency and partial failure. Runs on its own
 * database: the audit-failure test installs a temporary trigger on
 * audit_event that must not affect other test files.
 */
describe('route publication: concurrency and atomicity (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let actorA: StaffActor;
  let actorB: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    actorA = await staffActor(t.app, ['SUPER_ADMIN']);
    actorB = await staffActor(t.app, ['OPS_MANAGER']);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('two concurrent publications of the same draft: exactly one succeeds', async () => {
    const { route, draft } = await publishableDraft(actorA);
    const path = `/network/routes/${route.id}/versions/${draft.id}/publish`;
    const results = await Promise.all([
      adminApi(actorA).post(path, {}),
      adminApi(actorB).post(path, {}),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(results.find((response) => response.status === 409)?.body.code).toBe(
      'ROUTE_VERSION_NOT_DRAFT',
    );
    expect(
      await db(t.app).routeVersion.count({ where: { routeId: route.id, status: 'PUBLISHED' } }),
    ).toBe(1);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'ROUTE_VERSION_PUBLISHED', resourceId: draft.id },
      }),
    ).toBe(1);
  });

  it('concurrent supersession leaves exactly one PUBLISHED and one RETIRED', async () => {
    const { api, route, draft, origin, destination } = await publishableDraft(actorA);
    expect(
      (await api.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {})).status,
    ).toBe(200);
    const next = await createDraft(api, route.id);
    await api.post(`/network/routes/${route.id}/versions/${next.id}/waypoints`, {
      waypoints: [stopWaypoint(destination.id), stopWaypoint(origin.id)],
    });
    const path = `/network/routes/${route.id}/versions/${next.id}/publish`;
    const results = await Promise.all([
      adminApi(actorA).post(path, {}),
      adminApi(actorB).post(path, {}),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const versions = await db(t.app).routeVersion.findMany({
      where: { routeId: route.id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.status)).toEqual(['RETIRED', 'PUBLISHED']);
    expect(
      await db(t.app).auditEvent.count({
        where: { action: 'ROUTE_VERSION_RETIRED', resourceId: draft.id },
      }),
    ).toBe(1);
  });

  it('publication and waypoint replacement are serialized: published geometry never changes', async () => {
    const { api, route, draft, origin, destination } = await publishableDraft(actorA);
    const results = await Promise.all([
      adminApi(actorA).post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {}),
      adminApi(actorB).post(`/network/routes/${route.id}/versions/${draft.id}/waypoints`, {
        waypoints: [stopWaypoint(destination.id), stopWaypoint(origin.id)],
      }),
    ]);
    expect(results[0]?.status).toBe(200);
    const published = await api.get(`/network/routes/${route.id}`);
    const version = published.body.versions[0] as {
      status: string;
      waypoints: Array<{ stopId: string | null }>;
    };
    expect(version.status).toBe('PUBLISHED');
    if (results[1]?.status === 200) {
      // The replacement committed first: what was published is the new order.
      expect(version.waypoints.map((w) => w.stopId)).toEqual([destination.id, origin.id]);
    } else {
      expect(results[1]?.body.code).toBe('ROUTE_VERSION_NOT_DRAFT');
      expect(version.waypoints).toHaveLength(3);
    }
  });

  it('two concurrent draft creations for one route: exactly one draft', async () => {
    const { api, route, draft } = await publishableDraft(actorA);
    await api.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {});
    const results = await Promise.all([
      adminApi(actorA).post(`/network/routes/${route.id}/versions`, {}),
      adminApi(actorB).post(`/network/routes/${route.id}/versions`, {}),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      await db(t.app).routeVersion.count({ where: { routeId: route.id, status: 'DRAFT' } }),
    ).toBe(1);
  });

  it('rolls the whole publication back when an audit event cannot be written', async () => {
    const { api, route, draft, origin, destination } = await publishableDraft(actorA);
    expect(
      (await api.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {})).status,
    ).toBe(200);
    const next = await createDraft(api, route.id);
    await api.post(`/network/routes/${route.id}/versions/${next.id}/waypoints`, {
      waypoints: [stopWaypoint(destination.id), stopWaypoint(origin.id)],
    });

    // The retirement audit succeeds, the publication audit fails: both
    // status changes and the retirement audit event must be rolled back.
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION test_fail_publish_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'ROUTE_VERSION_PUBLISHED' THEN
          RAISE EXCEPTION 'simulated audit failure';
        END IF;
        RETURN NEW;
      END; $$`);
    await db(t.app).$executeRawUnsafe(
      'CREATE TRIGGER test_fail_publish_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_publish_audit()',
    );
    try {
      const response = await api.post(
        `/network/routes/${route.id}/versions/${next.id}/publish`,
        {},
      );
      expect(response.status).toBe(500);
      const versions = await db(t.app).routeVersion.findMany({
        where: { routeId: route.id },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((v) => [v.status, v.retiredAt])).toEqual([
        ['PUBLISHED', null],
        ['DRAFT', null],
      ]);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'ROUTE_VERSION_RETIRED', resourceId: draft.id },
        }),
      ).toBe(0);
    } finally {
      await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_publish_audit ON audit_event');
      await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_publish_audit()');
    }
    expect(
      (await api.post(`/network/routes/${route.id}/versions/${next.id}/publish`, {})).status,
    ).toBe(200);
  });

  it('rolls a reference-data mutation back when its audit event cannot be written', async () => {
    const api = adminApi(actorA);
    await db(t.app).$executeRawUnsafe(`
      CREATE FUNCTION test_fail_country_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'COUNTRY_CREATED' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await db(t.app).$executeRawUnsafe(
      'CREATE TRIGGER test_fail_country_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_country_audit()',
    );
    try {
      const response = await api.post('/network/countries', {
        iso2: 'QZ',
        iso3: 'QZZ',
        name: 'Pays jamais créé',
        active: true,
      });
      expect(response.status).toBe(500);
      expect(await db(t.app).country.count({ where: { iso2: 'QZ' } })).toBe(0);
    } finally {
      await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_country_audit ON audit_event');
      await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_country_audit()');
    }
  });
});
