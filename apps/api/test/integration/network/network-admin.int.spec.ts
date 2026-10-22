import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  checkpointWaypoint,
  createCheckpoint,
  createCountry,
  createDraft,
  createRoute,
  createStop,
  publishableDraft,
  stopWaypoint,
  syntheticCode,
  syntheticIso,
} from '../../support/network-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/**
 * Network administration through the HTTP API. Runs on its own database so
 * that synthetic ISO codes and pagination are not affected by other files.
 */
describe('network administration API (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  // One read-only actor shared by the tests (each actor costs Argon2 work).
  let dispatcher: StaffActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
    dispatcher = await staffActor(t.app, ['DISPATCHER']);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  describe('authorization', () => {
    it('lets network.read holders read every list, and refuses others with 403', async () => {
      const reader = adminApi(dispatcher);
      for (const path of ['countries', 'stops', 'checkpoints', 'routes']) {
        expect((await reader.get(`/network/${path}`)).status, path).toBe(200);
      }
      const finance = adminApi(await staffActor(t.app, ['FINANCE']));
      for (const path of ['countries', 'stops', 'checkpoints', 'routes']) {
        const response = await finance.get(`/network/${path}`);
        expect(response.status, path).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
      }
    });

    it('lets network.manage holders mutate, and refuses read-only roles with 403', async () => {
      const manager = adminApi(await staffActor(t.app, ['OPS_MANAGER']));
      expect(
        (
          await manager.post('/network/countries', {
            ...syntheticIso(),
            name: 'Pays du gestionnaire',
            active: true,
          })
        ).status,
      ).toBe(201);

      const before = await db(t.app).country.count();
      const reader = adminApi(await staffActor(t.app, ['AUDITOR']));
      const denied = await reader.post('/network/countries', {
        ...syntheticIso(),
        name: 'Mutation interdite',
        active: true,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      expect(await db(t.app).country.count()).toBe(before);
    });

    it('requires a valid session-bound CSRF token on every mutation', async () => {
      const api = adminApi(admin);
      const body = { ...syntheticIso(), name: 'Sans CSRF', active: true };
      expect((await api.post('/network/countries', body, { csrf: null })).status).toBe(403);
      expect(
        (await api.post('/network/countries', body, { csrf: 'v1.9999999999.x.y' })).status,
      ).toBe(403);
      const route = await createRoute(api);
      expect(
        (await api.post(`/network/routes/${route.id}/versions`, {}, { csrf: null })).status,
      ).toBe(403);
      expect(await db(t.app).routeVersion.count({ where: { routeId: route.id } })).toBe(0);
    });
  });

  describe('reference data', () => {
    it('creates and updates countries with normalized, unique ISO codes', async () => {
      const api = adminApi(admin);
      const created = await api.post('/network/countries', {
        iso2: 'zq',
        iso3: 'zqa',
        name: '  Pays normalisé  ',
        active: true,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ iso2: 'ZQ', iso3: 'ZQA', name: 'Pays normalisé' });

      const duplicate = await api.post('/network/countries', {
        iso2: 'ZQ',
        iso3: 'ZQB',
        name: 'Doublon',
        active: true,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('NETWORK_IDENTIFIER_CONFLICT');
      expect(
        (await api.post('/network/countries', { iso2: 'Z1', iso3: 'ZQC', name: 'x', active: true }))
          .status,
      ).toBe(400);

      const updated = await api.post(`/network/countries/${created.body.id}`, {
        name: 'Pays renommé',
        active: false,
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Pays renommé', active: false, iso2: 'ZQ' });
      expect((await api.post(`/network/countries/${created.body.id}`, {})).status).toBe(400);
      expect((await api.post(`/network/countries/${UNKNOWN_ID}`, { name: 'x' })).status).toBe(404);
      expect((await api.post('/network/countries/not-a-uuid', { name: 'x' })).status).toBe(400);
    });

    it('creates and updates stops with validated coordinates and country', async () => {
      const api = adminApi(admin);
      const country = await createCountry(api);
      const stop = await api.post('/network/stops', {
        code: 'stop_lower_case',
        name: 'Arrêt A',
        countryId: country.id,
        locality: 'Localité',
        latitude: 45.123456,
        longitude: -1.5,
        timezone: 'Etc/UTC',
        active: true,
      });
      expect(stop.status).toBe(201);
      expect(stop.body).toMatchObject({
        code: 'STOP_LOWER_CASE',
        latitude: 45.123456,
        longitude: -1.5,
        country: { id: country.id },
      });
      expect(
        (
          await api.post('/network/stops', {
            ...stop.body,
            code: syntheticCode('S'),
            latitude: 90.5,
          })
        ).status,
      ).toBe(400);
      const orphan = await api.post('/network/stops', {
        code: syntheticCode('S'),
        name: 'Arrêt orphelin',
        countryId: UNKNOWN_ID,
        locality: 'Localité',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
        active: true,
      });
      expect(orphan.status).toBe(404);
      expect(orphan.body.code).toBe('COUNTRY_NOT_FOUND');

      const updated = await api.post(`/network/stops/${stop.body.id}`, {
        longitude: 179.999999,
        active: false,
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ longitude: 179.999999, active: false });
      expect((await api.post(`/network/stops/${UNKNOWN_ID}`, { name: 'x' })).status).toBe(404);
    });

    it('creates and updates checkpoints of every type', async () => {
      const api = adminApi(admin);
      const country = await createCountry(api);
      const expectedKinds = {
        BORDER: 'BORDER',
        FERRY_TERMINAL: 'FERRY',
        PORT: 'FERRY',
        TECHNICAL: 'TECHNICAL',
      } as const;
      for (const type of ['BORDER', 'FERRY_TERMINAL', 'PORT', 'TECHNICAL'] as const) {
        const created = await createCheckpoint(api, country.id, { type });
        expect(created).toMatchObject({
          type,
          terangaKind: expectedKinds[type],
          travellerVisible: type !== 'TECHNICAL',
          facilities: [],
          suggestedDwellMinutes: null,
        });
      }
      const checkpoint = await createCheckpoint(api, country.id, {
        terangaKind: 'REST',
        travellerVisible: true,
        suggestedDwellMinutes: 45,
        facilities: ['SHOWER', 'RESTROOM', 'SHOWER', 'SECURE_PARKING'],
      });
      expect(checkpoint).toMatchObject({
        type: 'TECHNICAL',
        terangaKind: 'REST',
        travellerVisible: true,
        suggestedDwellMinutes: 45,
        facilities: ['RESTROOM', 'SHOWER', 'SECURE_PARKING'],
      });
      expect(
        (await api.post('/network/checkpoints', { code: syntheticCode('C'), type: 'AIRPORT' }))
          .status,
      ).toBe(400);
      const invalidKind = await api.post('/network/checkpoints', {
        code: syntheticCode('C'),
        name: 'Nature incompatible',
        countryId: country.id,
        type: 'TECHNICAL',
        terangaKind: 'BORDER',
        locality: 'Localité',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
        active: true,
      });
      expect(invalidKind.status).toBe(422);
      expect(invalidKind.body.code).toBe('NETWORK_INVARIANT_VIOLATION');

      const sameType = await api.post(`/network/checkpoints/${checkpoint.id}`, {
        type: 'TECHNICAL',
        name: 'Repos renommé',
      });
      expect(sameType.status).toBe(200);
      expect(sameType.body).toMatchObject({
        type: 'TECHNICAL',
        terangaKind: 'REST',
        name: 'Repos renommé',
      });

      const updated = await api.post(`/network/checkpoints/${checkpoint.id}`, {
        type: 'PORT',
        name: 'Port synthétique',
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        type: 'PORT',
        terangaKind: 'FERRY',
        name: 'Port synthétique',
      });
      const duplicate = await api.post(`/network/checkpoints/${checkpoint.id}`, {
        code: (await createCheckpoint(api, country.id)).code,
      });
      expect(duplicate.status).toBe(409);
    });

    it('creates and updates routes; a route has at most one DRAFT', async () => {
      const api = adminApi(admin);
      const route = await createRoute(api);
      const updated = await api.post(`/network/routes/${route.id}`, { name: 'Route renommée' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Route renommée', code: route.code });

      const draft = await createDraft(api, route.id);
      expect(draft).toMatchObject({ version: 1, status: 'DRAFT' });
      const second = await api.post(`/network/routes/${route.id}/versions`, {});
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ROUTE_DRAFT_ALREADY_EXISTS');
      expect((await api.post(`/network/routes/${UNKNOWN_ID}/versions`, {})).status).toBe(404);
    });

    it('paginates lists newest first with a bounded keyset cursor', async () => {
      const api = adminApi(admin);
      for (let index = 0; index < 3; index += 1) await createRoute(api);
      const first = await api.get('/network/routes?limit=2');
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBe(first.body.items[1].id);
      const second = await api.get(`/network/routes?limit=2&cursor=${first.body.nextCursor}`);
      const firstIds = first.body.items.map((item: { id: string }) => item.id);
      for (const item of second.body.items as Array<{ id: string }>) {
        expect(firstIds).not.toContain(item.id);
        expect(item.id < first.body.nextCursor).toBe(true);
      }
      expect((await api.get('/network/routes?limit=101')).status).toBe(400);
      expect((await api.get('/network/routes?cursor=nope')).status).toBe(400);
    });
  });

  describe('draft waypoints', () => {
    it('replaces the whole ordered list atomically, with server-assigned sequences', async () => {
      const api = adminApi(admin);
      const country = await createCountry(api);
      const a = await createStop(api, country.id);
      const b = await createStop(api, country.id);
      const checkpoint = await createCheckpoint(api, country.id);
      const route = await createRoute(api);
      const draft = await createDraft(api, route.id);
      const path = `/network/routes/${route.id}/versions/${draft.id}/waypoints`;

      const replaced = await api.post(path, {
        waypoints: [stopWaypoint(a.id), checkpointWaypoint(checkpoint.id), stopWaypoint(b.id)],
      });
      expect(replaced.status).toBe(200);
      expect(
        replaced.body.waypoints.map((w: { sequence: number; kind: string }) => [
          w.sequence,
          w.kind,
        ]),
      ).toEqual([
        [1, 'STOP'],
        [2, 'CHECKPOINT'],
        [3, 'STOP'],
      ]);
      expect(replaced.body.waypoints[1]).toMatchObject({
        boardingAllowed: false,
        alightingAllowed: false,
      });

      // One invalid reference: nothing changes (no partial replacement).
      const invalid = await api.post(path, {
        waypoints: [stopWaypoint(b.id), stopWaypoint(UNKNOWN_ID)],
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('NETWORK_REFERENCE_INVALID');
      const stored = await db(t.app).routeWaypoint.findMany({
        where: { routeVersionId: draft.id },
        orderBy: { sequence: 'asc' },
      });
      expect(stored.map((w) => w.stopId ?? w.checkpointId)).toEqual([a.id, checkpoint.id, b.id]);

      // A checkpoint cannot carry passenger flags, even if a client sends them.
      expect(
        (
          await api.post(path, {
            waypoints: [{ ...checkpointWaypoint(checkpoint.id), boardingAllowed: true }],
          })
        ).status,
      ).toBe(400);

      // Reordering is a full replacement as well.
      const reordered = await api.post(path, {
        waypoints: [stopWaypoint(b.id), checkpointWaypoint(checkpoint.id), stopWaypoint(a.id)],
      });
      expect(reordered.body.waypoints.map((w: { stopId: string | null }) => w.stopId)).toEqual([
        b.id,
        null,
        a.id,
      ]);
    });

    it('refuses a version that belongs to another route', async () => {
      const api = adminApi(admin);
      const first = await createRoute(api);
      const other = await createRoute(api);
      const draft = await createDraft(api, other.id);
      const response = await api.post(
        `/network/routes/${first.id}/versions/${draft.id}/waypoints`,
        {
          waypoints: [],
        },
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('ROUTE_VERSION_NOT_FOUND');
    });
  });

  describe('publication', () => {
    async function expectNotPublishable(
      waypoints: unknown[],
      setup?: (api: ReturnType<typeof adminApi>) => Promise<void>,
    ) {
      const api = adminApi(admin);
      const route = await createRoute(api);
      const draft = await createDraft(api, route.id);
      if (setup) await setup(api);
      expect(
        (
          await api.post(`/network/routes/${route.id}/versions/${draft.id}/waypoints`, {
            waypoints,
          })
        ).status,
      ).toBe(200);
      const response = await api.post(
        `/network/routes/${route.id}/versions/${draft.id}/publish`,
        {},
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('ROUTE_VERSION_NOT_PUBLISHABLE');
      expect(
        await db(t.app).routeVersion.findUniqueOrThrow({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'DRAFT', publishedAt: null });
    }

    it('refuses drafts that break the publication rules', async () => {
      const api = adminApi(admin);
      const country = await createCountry(api);
      const a = await createStop(api, country.id);
      const b = await createStop(api, country.id);
      const checkpoint = await createCheckpoint(api, country.id);
      const inactive = await createStop(api, country.id, { active: true });

      await expectNotPublishable([]);
      await expectNotPublishable([stopWaypoint(a.id)]);
      await expectNotPublishable([
        checkpointWaypoint(checkpoint.id),
        stopWaypoint(a.id),
        stopWaypoint(b.id),
      ]);
      await expectNotPublishable([
        stopWaypoint(a.id),
        stopWaypoint(b.id),
        checkpointWaypoint(checkpoint.id),
      ]);
      await expectNotPublishable([stopWaypoint(a.id), checkpointWaypoint(checkpoint.id)]);
      // Referenced stop deactivated after it was placed in the draft.
      await expectNotPublishable(
        [stopWaypoint(a.id), stopWaypoint(inactive.id)],
        async (client) => {
          expect(
            (await client.post(`/network/stops/${inactive.id}`, { active: false })).status,
          ).toBe(200);
        },
      );
      // Country deactivated: its stops are not publishable either.
      const closed = await createCountry(api);
      const closedStop = await createStop(api, closed.id);
      expect((await api.post(`/network/countries/${closed.id}`, { active: false })).status).toBe(
        200,
      );
      await expectNotPublishable([stopWaypoint(a.id), stopWaypoint(closedStop.id)]);
    });

    it('publishes, then supersedes: the previous PUBLISHED becomes RETIRED', async () => {
      const { api, route, draft, origin, destination } = await publishableDraft(admin);
      const first = await api.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {});
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: 'PUBLISHED', version: 1, retiredAt: null });
      expect(first.body.publishedAt).toEqual(expect.any(String));

      // A published version is no longer editable or publishable.
      expect(
        (
          await api.post(`/network/routes/${route.id}/versions/${draft.id}/waypoints`, {
            waypoints: [stopWaypoint(destination.id), stopWaypoint(origin.id)],
          })
        ).body.code,
      ).toBe('ROUTE_VERSION_NOT_DRAFT');
      expect(
        (await api.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {})).body.code,
      ).toBe('ROUTE_VERSION_NOT_DRAFT');

      const next = await createDraft(api, route.id);
      expect(next.version).toBe(2);
      await api.post(`/network/routes/${route.id}/versions/${next.id}/waypoints`, {
        waypoints: [stopWaypoint(destination.id), stopWaypoint(origin.id)],
      });
      expect(
        (await api.post(`/network/routes/${route.id}/versions/${next.id}/publish`, {})).status,
      ).toBe(200);

      const detail = await api.get(`/network/routes/${route.id}`);
      expect(detail.status).toBe(200);
      const versions = detail.body.versions as Array<{
        version: number;
        status: string;
        retiredAt: string | null;
        waypoints: Array<{ stopId: string | null }>;
      }>;
      expect(versions.map((v) => [v.version, v.status])).toEqual([
        [2, 'PUBLISHED'],
        [1, 'RETIRED'],
      ]);
      expect(versions[1]?.retiredAt).toEqual(expect.any(String));
      // The retired geometry is preserved exactly as published.
      expect(versions[1]?.waypoints.map((w) => w.stopId)).toEqual([
        origin.id,
        null,
        destination.id,
      ]);
    });

    it('audits every network mutation in its transaction, with the request id', async () => {
      const {
        api,
        route,
        draft,
        country,
        origin: stop,
        checkpoint,
      } = await publishableDraft(admin);
      // Updates made here so that the test does not depend on the others.
      await api.post(`/network/countries/${country.id}`, { name: 'Pays audité' });
      await api.post(`/network/stops/${stop.id}`, { name: 'Arrêt audité' });
      await api.post(`/network/checkpoints/${checkpoint.id}`, { name: 'Checkpoint audité' });
      await api.post(`/network/routes/${route.id}`, { name: 'Route auditée' });
      const published = await admin.http
        .post(
          `/v1/admin/network/routes/${route.id}/versions/${draft.id}/publish`,
          {},
          admin.cookie,
          await admin.csrf(),
        )
        .set('X-Request-Id', 'network-publish-0001');
      expect(published.status).toBe(200);
      const event = await db(t.app).auditEvent.findFirstOrThrow({
        where: { action: 'ROUTE_VERSION_PUBLISHED', resourceId: draft.id },
      });
      expect(event).toMatchObject({
        requestId: 'network-publish-0001',
        actorIdentityId: admin.id,
        actorRealm: 'STAFF',
        resourceType: 'route_version',
        before: { status: 'DRAFT' },
        after: { status: 'PUBLISHED' },
      });

      const next = await createDraft(api, route.id);
      const { origin, destination } = await publishableDraft(admin);
      await api.post(`/network/routes/${route.id}/versions/${next.id}/waypoints`, {
        waypoints: [stopWaypoint(origin.id), stopWaypoint(destination.id)],
      });
      await api.post(`/network/routes/${route.id}/versions/${next.id}/publish`, {});
      const retired = await db(t.app).auditEvent.findFirstOrThrow({
        where: { action: 'ROUTE_VERSION_RETIRED', resourceId: draft.id },
      });
      expect(retired).toMatchObject({
        before: { status: 'PUBLISHED' },
        after: { status: 'RETIRED' },
      });

      const actions = (
        await db(t.app).auditEvent.findMany({
          where: { actorIdentityId: admin.id },
          select: { action: true },
          distinct: ['action'],
        })
      ).map((row) => row.action);
      for (const action of [
        'COUNTRY_CREATED',
        'COUNTRY_UPDATED',
        'STOP_CREATED',
        'STOP_UPDATED',
        'CHECKPOINT_CREATED',
        'CHECKPOINT_UPDATED',
        'ROUTE_CREATED',
        'ROUTE_UPDATED',
        'ROUTE_VERSION_CREATED',
        'ROUTE_WAYPOINTS_REPLACED',
        'ROUTE_VERSION_PUBLISHED',
        'ROUTE_VERSION_RETIRED',
      ]) {
        expect(actions, action).toContain(action);
      }
    });

    it('refuses to publish without network.manage, leaving the draft untouched', async () => {
      const { route, draft } = await publishableDraft(admin);
      const reader = adminApi(dispatcher);
      expect(
        (await reader.post(`/network/routes/${route.id}/versions/${draft.id}/publish`, {})).status,
      ).toBe(403);
      expect(
        await db(t.app).routeVersion.findUniqueOrThrow({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'DRAFT' });
    });
  });
});
