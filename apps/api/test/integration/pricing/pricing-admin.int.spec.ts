import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  createFareDraft,
  createFareTable,
  fare,
  pricedRoute,
  publishedFareTable,
  type PricedRoute,
} from '../../support/pricing-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/**
 * Fare-table catalogue through the HTTP API, on its own database (one test
 * installs a temporary failing trigger on audit_event).
 */
describe('pricing administration API (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let manager: StaffActor;
  let reader: StaffActor;
  let countryId: string;
  let route: PricedRoute;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, manager, reader] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['FINANCE']),
    ]);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QF', iso3: 'QFF', name: 'Pays F' } })
    ).id;
    route = await pricedRoute(t.app, countryId);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const versionOf = (id: string) => db(t.app).fareTableVersion.findUniqueOrThrow({ where: { id } });
  const faresOf = (versionId: string) =>
    db(t.app).fareEntry.findMany({
      where: { fareTableVersionId: versionId },
      orderBy: [{ originRouteWaypointId: 'asc' }, { destinationRouteWaypointId: 'asc' }],
      select: { originRouteWaypointId: true, destinationRouteWaypointId: true, amountMinor: true },
    });

  describe('authorization', () => {
    it('lets pricing.read holders read and refuses others with 403', async () => {
      const { table } = await publishedFareTable(admin, route);
      const api = adminApi(reader);
      expect((await api.get('/pricing/fare-tables')).status).toBe(200);
      expect((await api.get(`/pricing/fare-tables/${table.id}`)).status).toBe(200);
      const compliance = adminApi(await staffActor(t.app, ['COMPLIANCE_AGENT']));
      for (const path of ['/pricing/fare-tables', `/pricing/fare-tables/${table.id}`]) {
        const response = await compliance.get(path);
        expect(response.status, path).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
      }
    });

    it('lets pricing.manage holders mutate and refuses read-only roles with 403', async () => {
      const table = await createFareTable(adminApi(manager), route.routeId);
      const draft = await createFareDraft(adminApi(manager), table.id, route.routeVersionId);
      const api = adminApi(reader);
      const attempts = [
        await api.post('/pricing/fare-tables', {
          code: 'FT_DENIED',
          name: 'x',
          routeId: route.routeId,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          active: true,
        }),
        await api.post(`/pricing/fare-tables/${table.id}`, { name: 'Interdit' }),
        await api.post(`/pricing/fare-tables/${table.id}/versions`, {
          routeVersionId: route.routeVersionId,
        }),
        await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
          fares: [fare(route.A, route.B)],
        }),
        await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}),
      ];
      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.code).toBe('FORBIDDEN');
      }
      expect(await faresOf(draft.id)).toHaveLength(0);
    });

    it('requires a valid CSRF token on every mutation', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      const calls: Array<[string, unknown]> = [
        [
          '/pricing/fare-tables',
          {
            code: 'FT_NO_CSRF',
            name: 'x',
            routeId: route.routeId,
            currencyCode: 'EUR',
            currencyMinorUnit: 2,
            active: true,
          },
        ],
        [`/pricing/fare-tables/${table.id}`, { name: 'Sans CSRF' }],
        [`/pricing/fare-tables/${table.id}/versions`, { routeVersionId: route.routeVersionId }],
        [
          `/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`,
          { fares: [fare(route.A, route.B)] },
        ],
        [`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}],
      ];
      for (const [path, body] of calls) {
        expect((await api.post(path, body, { csrf: null })).status, path).toBe(403);
        expect((await api.post(path, body, { csrf: 'v1.9999999999.x.y' })).status, path).toBe(403);
      }
      expect((await versionOf(draft.id)).status).toBe('DRAFT');
    });

    it('exposes no delete endpoint', async () => {
      const { table } = await publishedFareTable(admin, route);
      const csrf = await admin.csrf();
      const response = await request(t.app.getHttpServer())
        .delete(`/v1/admin/pricing/fare-tables/${table.id}`)
        .set('Origin', admin.http.origin)
        .set('Cookie', admin.cookie)
        .set('X-CSRF-Token', csrf);
      expect(response.status).toBe(404);
      expect(await db(t.app).fareTable.count({ where: { id: table.id } })).toBe(1);
    });
  });

  describe('fare tables', () => {
    it('creates with normalized code and currency; route and currency never change', async () => {
      const api = adminApi(admin);
      const created = await api.post('/pricing/fare-tables', {
        code: ' route_test_eur ',
        name: ' Tarif test ',
        routeId: route.routeId,
        currencyCode: 'eur',
        currencyMinorUnit: 2,
        active: true,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        code: 'ROUTE_TEST_EUR',
        name: 'Tarif test',
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        route: { id: route.routeId },
        versions: [],
      });
      const duplicate = await api.post('/pricing/fare-tables', {
        code: 'ROUTE_TEST_EUR',
        name: 'Doublon',
        routeId: route.routeId,
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
        active: true,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('FARE_TABLE_CODE_CONFLICT');
      const unknownRoute = await api.post('/pricing/fare-tables', {
        code: 'FT_NO_ROUTE',
        name: 'x',
        routeId: UNKNOWN_ID,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        active: true,
      });
      expect(unknownRoute.status).toBe(404);
      expect(unknownRoute.body.code).toBe('ROUTE_NOT_FOUND');

      const updated = await api.post(`/pricing/fare-tables/${created.body.id}`, {
        name: 'Renommé',
        active: false,
      });
      expect(updated.body).toMatchObject({ name: 'Renommé', active: false, currencyCode: 'EUR' });
      for (const forbidden of [
        { currencyCode: 'XOF' },
        { currencyMinorUnit: 0 },
        { routeId: route.routeId },
      ]) {
        expect((await api.post(`/pricing/fare-tables/${created.body.id}`, forbidden)).status).toBe(
          400,
        );
      }
      expect((await api.post(`/pricing/fare-tables/${UNKNOWN_ID}`, { name: 'x' })).status).toBe(
        404,
      );
    });

    it('creates versions only on a published version of its own route, one draft at a time', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const other = await pricedRoute(t.app, countryId);
      const mismatch = await api.post(`/pricing/fare-tables/${table.id}/versions`, {
        routeVersionId: other.routeVersionId,
      });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('FARE_TABLE_ROUTE_MISMATCH');
      const draftRouteVersion = await db(t.app).routeVersion.create({
        data: { routeId: route.routeId, version: 2 },
      });
      const unpublished = await api.post(`/pricing/fare-tables/${table.id}/versions`, {
        routeVersionId: draftRouteVersion.id,
      });
      expect(unpublished.status).toBe(422);
      expect(unpublished.body.code).toBe('FARE_TABLE_ROUTE_VERSION_NOT_PUBLISHED');
      expect(
        (
          await api.post(`/pricing/fare-tables/${table.id}/versions`, {
            routeVersionId: UNKNOWN_ID,
          })
        ).status,
      ).toBe(404);

      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      expect(draft).toMatchObject({ version: 1, status: 'DRAFT' });
      const second = await api.post(`/pricing/fare-tables/${table.id}/versions`, {
        routeVersionId: route.routeVersionId,
      });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('FARE_TABLE_DRAFT_ALREADY_EXISTS');
    });

    it('paginates with a bounded keyset cursor and filters', async () => {
      const api = adminApi(admin);
      for (let index = 0; index < 3; index += 1) await createFareTable(api, route.routeId);
      const first = await api.get('/pricing/fare-tables?limit=2');
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBe(first.body.items[1].id);
      const second = await api.get(`/pricing/fare-tables?limit=2&cursor=${first.body.nextCursor}`);
      for (const item of second.body.items as Array<{ id: string }>)
        expect(item.id < first.body.nextCursor).toBe(true);
      const byRoute = await api.get(`/pricing/fare-tables?routeId=${route.routeId}&limit=100`);
      expect(
        (byRoute.body.items as Array<{ routeId: string }>).every(
          (item) => item.routeId === route.routeId,
        ),
      ).toBe(true);
      expect((await api.get('/pricing/fare-tables?limit=101')).status).toBe(400);
      expect((await api.get(`/pricing/fare-tables/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });

  describe('fares', () => {
    it('replaces the complete partial matrix atomically, in exact minor units', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      const path = `/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`;
      const first = await api.post(path, { fares: [fare(route.A, route.B, 12345)] });
      expect(first.status).toBe(200);
      const version = (
        first.body.versions as Array<{
          id: string;
          entryCount: number;
          entries: Array<{ amountMinor: number }>;
        }>
      ).find((candidate) => candidate.id === draft.id);
      expect(version).toMatchObject({ entryCount: 1, entries: [{ amountMinor: 12345 }] });
      // A->D and B->D priced, A->B no longer: the matrix is partial on purpose.
      await api.post(path, {
        fares: [fare(route.A, route.D, 20000), fare(route.B, route.D, 7500)],
      });
      expect((await faresOf(draft.id)).map((row) => row.amountMinor).sort()).toEqual(
        [20000, 7500].sort(),
      );
    });

    it('refuses invalid matrices and leaves the stored one untouched', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      const path = `/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`;
      await api.post(path, { fares: [fare(route.A, route.B, 12345)] });
      const before = await faresOf(draft.id);
      const other = await pricedRoute(t.app, countryId);
      const invalid: Array<[string, unknown[]]> = [
        ['waypoint of another route', [fare(other.A, other.B)]],
        ['checkpoint', [fare(route.A, route.C)]],
        ['origin without boarding', [fare(route.D, route.B)]],
        ['destination without alighting', [fare(route.B, route.A)]],
        ['same waypoint', [fare(route.B, route.B)]],
        ['duplicated pair', [fare(route.A, route.B), fare(route.A, route.B, 1)]],
      ];
      for (const [label, fares] of invalid) {
        const response = await api.post(path, { fares });
        expect(response.status, label).toBe(422);
        expect(response.body.code, label).toBe('FARE_ENTRIES_INVALID');
      }
      for (const amountMinor of [0, -1, 123.45, '12345']) {
        expect(
          (await api.post(path, { fares: [fare(route.A, route.B, amountMinor as number)] })).status,
        ).toBe(400);
      }
      expect(await faresOf(draft.id)).toEqual(before);
    });
  });

  describe('publication', () => {
    it('refuses an empty version or an inactive table', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      const empty = await api.post(
        `/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`,
        {},
      );
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('FARE_TABLE_VERSION_NOT_PUBLISHABLE');
      await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
        fares: [fare(route.A, route.B)],
      });
      await api.post(`/pricing/fare-tables/${table.id}`, { active: false });
      expect(
        (await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}))
          .status,
      ).toBe(422);
      expect((await versionOf(draft.id)).status).toBe('DRAFT');
    });

    it('publishes, supersedes and freezes prices', async () => {
      const { api, table, versionId } = await publishedFareTable(admin, route);
      expect(
        (await api.post(`/pricing/fare-tables/${table.id}/versions/${versionId}/publish`, {})).body
          .code,
      ).toBe('FARE_TABLE_VERSION_NOT_DRAFT');
      const frozen = await api.post(
        `/pricing/fare-tables/${table.id}/versions/${versionId}/fares`,
        { fares: [fare(route.A, route.B, 1)] },
      );
      expect(frozen.status).toBe(409);
      expect(frozen.body.code).toBe('FARE_TABLE_VERSION_NOT_DRAFT');

      const next = await createFareDraft(api, table.id, route.routeVersionId);
      expect(next.version).toBe(2);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/fares`, {
        fares: [fare(route.A, route.B, 13000)],
      });
      expect(
        (await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/publish`, {})).status,
      ).toBe(200);
      const detail = await adminApi(reader).get(`/pricing/fare-tables/${table.id}`);
      expect(
        (
          detail.body.versions as Array<{ version: number; status: string; entryCount: number }>
        ).map((version) => [version.version, version.status, version.entryCount]),
      ).toEqual([
        [2, 'PUBLISHED', 1],
        [1, 'RETIRED', 2],
      ]);
      // The retired prices are preserved exactly.
      expect((await faresOf(versionId)).map((row) => row.amountMinor).sort()).toEqual([
        12345, 20000,
      ]);
    });
  });

  describe('audit', () => {
    it('audits every catalogue mutation with the request id', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      await api.post(`/pricing/fare-tables/${table.id}`, { name: 'Tarif audité' });
      const first = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${first.id}/fares`, {
        fares: [fare(route.A, route.B)],
      });
      await api.post(`/pricing/fare-tables/${table.id}/versions/${first.id}/publish`, {});
      const second = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${second.id}/fares`, {
        fares: [fare(route.A, route.D)],
      });
      const response = await admin.http
        .post(
          `/v1/admin/pricing/fare-tables/${table.id}/versions/${second.id}/publish`,
          {},
          admin.cookie,
          await admin.csrf(),
        )
        .set('X-Request-Id', 'fare-publish-0001');
      expect(response.status).toBe(200);
      const events = await db(t.app).auditEvent.findMany({
        where: { resourceId: { in: [table.id, first.id, second.id] } },
        orderBy: { occurredAt: 'asc' },
        select: {
          action: true,
          resourceId: true,
          requestId: true,
          actorIdentityId: true,
          before: true,
          after: true,
        },
      });
      expect(events.map((event) => event.action)).toEqual([
        'FARE_TABLE_CREATED',
        'FARE_TABLE_UPDATED',
        'FARE_TABLE_VERSION_CREATED',
        'FARE_ENTRIES_REPLACED',
        'FARE_TABLE_VERSION_PUBLISHED',
        'FARE_TABLE_VERSION_CREATED',
        'FARE_ENTRIES_REPLACED',
        'FARE_TABLE_VERSION_RETIRED',
        'FARE_TABLE_VERSION_PUBLISHED',
      ]);
      expect(events.at(-1)).toMatchObject({
        resourceId: second.id,
        requestId: 'fare-publish-0001',
        actorIdentityId: admin.id,
        after: { status: 'PUBLISHED', fareCount: 1 },
      });
      expect(events[3]).toMatchObject({
        before: { count: 0 },
        after: { count: 1, fares: [{ amountMinor: 12345 }] },
      });
    });

    it('rolls fare replacement and publication back when the audit insert fails', async () => {
      const api = adminApi(admin);
      const { table, versionId: published } = await publishedFareTable(admin, route);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
        fares: [fare(route.A, route.B, 15000)],
      });
      const before = await faresOf(draft.id);
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_fare_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('FARE_ENTRIES_REPLACED', 'FARE_TABLE_VERSION_PUBLISHED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_fare_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_fare_audit()',
      );
      try {
        expect(
          (
            await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
              fares: [fare(route.A, route.D, 1)],
            })
          ).status,
        ).toBe(500);
        expect(await faresOf(draft.id)).toEqual(before);
        expect(
          (await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}))
            .status,
        ).toBe(500);
        expect((await versionOf(published)).status).toBe('PUBLISHED');
        expect((await versionOf(draft.id)).status).toBe('DRAFT');
        expect(
          await db(t.app).auditEvent.count({
            where: { resourceId: published, action: 'FARE_TABLE_VERSION_RETIRED' },
          }),
        ).toBe(0);
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_fare_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_fare_audit()');
      }
      expect(
        (await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}))
          .status,
      ).toBe(200);
    });
  });

  describe('concurrency', () => {
    it('two concurrent draft creations: exactly one draft, refused by the service', async () => {
      const table = await createFareTable(adminApi(admin), route.routeId);
      const results = await Promise.all([
        adminApi(admin).post(`/pricing/fare-tables/${table.id}/versions`, {
          routeVersionId: route.routeVersionId,
        }),
        adminApi(manager).post(`/pricing/fare-tables/${table.id}/versions`, {
          routeVersionId: route.routeVersionId,
        }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(results.find((response) => response.status === 409)?.body.code).toBe(
        'FARE_TABLE_DRAFT_ALREADY_EXISTS',
      );
      expect(
        await db(t.app).fareTableVersion.count({
          where: { fareTableId: table.id, status: 'DRAFT' },
        }),
      ).toBe(1);
    });

    it('two concurrent publications: one PUBLISHED, one consistent retirement', async () => {
      const { api, table, versionId } = await publishedFareTable(admin, route);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
        fares: [fare(route.A, route.B, 16000)],
      });
      const path = `/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`;
      const results = await Promise.all([
        adminApi(admin).post(path, {}),
        adminApi(manager).post(path, {}),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const versions = await db(t.app).fareTableVersion.findMany({
        where: { fareTableId: table.id },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((version) => version.status)).toEqual(['RETIRED', 'PUBLISHED']);
      expect(versions[0]?.id).toBe(versionId);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: versionId, action: 'FARE_TABLE_VERSION_RETIRED' },
        }),
      ).toBe(1);
    });

    it('two concurrent fare replacements never produce a mix', async () => {
      const api = adminApi(admin);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      const path = `/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`;
      const results = await Promise.all([
        adminApi(admin).post(path, {
          fares: [fare(route.A, route.B, 1111), fare(route.A, route.D, 2222)],
        }),
        adminApi(manager).post(path, {
          fares: [fare(route.A, route.B, 3333), fare(route.B, route.D, 4444)],
        }),
      ]);
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const amounts = (await faresOf(draft.id)).map((row) => row.amountMinor).sort((a, b) => a - b);
      expect([
        [1111, 2222],
        [3333, 4444],
      ]).toContainEqual(amounts);
    });

    it('publication racing a fare replacement publishes exactly one complete matrix', async () => {
      for (let round = 0; round < 3; round += 1) {
        const api = adminApi(admin);
        const table = await createFareTable(api, route.routeId);
        const draft = await createFareDraft(api, table.id, route.routeVersionId);
        await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
          fares: [fare(route.A, route.B, 5000)],
        });
        const [publish, replace] = await Promise.all([
          adminApi(admin).post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {}),
          adminApi(manager).post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
            fares: [fare(route.A, route.D, 9000)],
          }),
        ]);
        expect(publish.status).toBe(200);
        expect([200, 409]).toContain(replace.status);
        expect((await faresOf(draft.id)).map((row) => row.amountMinor)).toEqual(
          replace.status === 200 ? [9000] : [5000],
        );
        expect((await versionOf(draft.id)).status).toBe('PUBLISHED');
      }
    });
  });
});
