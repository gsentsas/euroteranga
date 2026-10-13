import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  createTestRole,
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
  pricedTrip,
  publishedFareTable,
  type PricedRoute,
} from '../../support/pricing-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';

/**
 * Historical pricing of trips (fare-table version assignment) and server fare
 * resolution. Own database; routes and trips are synthetic fixtures written
 * directly, fare tables and assignments go through the API.
 */
describe('trip pricing and fare resolution (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let dispatcher: StaffActor;
  let countryId: string;
  let route: PricedRoute;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, dispatcher] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QP', iso3: 'QPP', name: 'Pays P' } })
    ).id;
    route = await pricedRoute(t.app, countryId);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const assign = (actor: StaffActor, id: string, body: Record<string, unknown>) =>
    adminApi(actor).post(`/trips/${id}/fare-table`, body);
  const resolve = (actor: StaffActor, id: string, origin: string, destination: string) =>
    adminApi(actor).get(
      `/trips/${id}/fare?originRouteWaypointId=${origin}&destinationRouteWaypointId=${destination}`,
    );
  const stored = (id: string) => db(t.app).trip.findUniqueOrThrow({ where: { id } });

  describe('permissions', () => {
    it('needs trip.manage AND pricing.read plus CSRF to assign; pricing.manage is not required', async () => {
      const { versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      // A synthetic role with trip.manage but without pricing.read.
      const tripOnly = adminApi(
        await staffActor(t.app, [
          await createTestRole(t.app, ['ops.access', 'trip.manage', 'trip.read']),
        ]),
      );
      const denied = await tripOnly.post(`/trips/${trip.id}/fare-table`, {
        fareTableVersionId: versionId,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      // pricing.read without trip.manage.
      const finance = adminApi(await staffActor(t.app, ['FINANCE']));
      expect(
        (await finance.post(`/trips/${trip.id}/fare-table`, { fareTableVersionId: versionId }))
          .status,
      ).toBe(403);
      expect(
        (
          await adminApi(admin).post(
            `/trips/${trip.id}/fare-table`,
            { fareTableVersionId: versionId },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect((await stored(trip.id)).fareTableVersionId).toBeNull();
      // DISPATCHER holds trip.manage + pricing.read, not pricing.manage.
      expect((await assign(dispatcher, trip.id, { fareTableVersionId: versionId })).status).toBe(
        200,
      );
    });

    it('needs trip.read AND pricing.read to resolve a fare', async () => {
      const { versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      await assign(admin, trip.id, { fareTableVersionId: versionId });
      // COMPLIANCE_AGENT reads trips but not prices.
      const compliance = await staffActor(t.app, ['COMPLIANCE_AGENT']);
      expect((await adminApi(compliance).get(`/trips/${trip.id}`)).status).toBe(200);
      expect((await resolve(compliance, trip.id, route.A, route.B)).status).toBe(403);
      const readOnly = await staffActor(t.app, ['AUDITOR']);
      expect((await resolve(readOnly, trip.id, route.A, route.B)).status).toBe(200);
    });
  });

  describe('assignment', () => {
    it('assigns, replaces and removes the fare table of a DRAFT trip, with history and audit', async () => {
      const first = await publishedFareTable(admin, route);
      const second = await publishedFareTable(admin, route, [fare(route.A, route.D, 30000)]);
      const trip = await pricedTrip(t.app, route);
      const assigned = await assign(admin, trip.id, {
        fareTableVersionId: first.versionId,
        expectedFareTableVersionId: null,
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body).toMatchObject({
        fareTableVersionId: first.versionId,
        fareTableVersion: {
          id: first.versionId,
          version: 1,
          status: 'PUBLISHED',
          entryCount: 2,
          fareTable: { code: first.table.code, currencyCode: 'EUR', currencyMinorUnit: 2 },
        },
      });
      expect(assigned.body.history[0]).toMatchObject({
        action: 'TRIP_FARE_TABLE_CHANGED',
        fromFareTable: null,
        toFareTable: `${first.table.code} v1 (EUR)`,
      });
      const stale = await assign(admin, trip.id, {
        fareTableVersionId: second.versionId,
        expectedFareTableVersionId: null,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('TRIP_FARE_TABLE_CONFLICT');
      const replaced = await assign(admin, trip.id, {
        fareTableVersionId: second.versionId,
        expectedFareTableVersionId: first.versionId,
      });
      expect(replaced.body.fareTableVersion).toMatchObject({ id: second.versionId, entryCount: 1 });
      // Same value: no-op, no audit.
      expect((await assign(admin, trip.id, { fareTableVersionId: second.versionId })).status).toBe(
        200,
      );
      const removed = await assign(admin, trip.id, { fareTableVersionId: null });
      expect(removed.body).toMatchObject({ fareTableVersionId: null, fareTableVersion: null });
      // No implicit pricing: trip creation never accepts it.
      const implicit = await adminApi(admin).post('/trips', {
        reference: 'ET-TEST-2030-IMPLICIT',
        routeVersionId: route.routeVersionId,
        fareTableVersionId: first.versionId,
      });
      expect(implicit.status).toBe(400);
      expect(await db(t.app).trip.count({ where: { reference: 'ET-TEST-2030-IMPLICIT' } })).toBe(0);

      const events = await db(t.app).auditEvent.findMany({
        where: { resourceId: trip.id, action: 'TRIP_FARE_TABLE_CHANGED' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(
        events.map((event) => [
          (event.before as { fareTable: string | null }).fareTable,
          (event.after as { fareTable: string | null }).fareTable,
        ]),
      ).toEqual([
        [null, `${first.table.code} v1 (EUR)`],
        [`${first.table.code} v1 (EUR)`, `${second.table.code} v1 (EUR)`],
        [`${second.table.code} v1 (EUR)`, null],
      ]);
      expect(events[0]?.actorIdentityId).toBe(admin.id);
    });

    it('refuses draft, retired, inactive, unknown and incompatible versions', async () => {
      const api = adminApi(admin);
      const trip = await pricedTrip(t.app, route);
      const table = await createFareTable(api, route.routeId);
      const draft = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
        fares: [fare(route.A, route.B)],
      });
      const notPublished = await assign(admin, trip.id, { fareTableVersionId: draft.id });
      expect(notPublished.status).toBe(422);
      expect(notPublished.body.code).toBe('FARE_TABLE_VERSION_NOT_PUBLISHED');

      await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`, {});
      const next = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/fares`, {
        fares: [fare(route.A, route.D)],
      });
      await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/publish`, {});
      const retired = await assign(admin, trip.id, { fareTableVersionId: draft.id });
      expect(retired.status).toBe(422);
      expect(retired.body.code).toBe('FARE_TABLE_VERSION_RETIRED');

      await api.post(`/pricing/fare-tables/${table.id}`, { active: false });
      const inactive = await assign(admin, trip.id, { fareTableVersionId: next.id });
      expect(inactive.status).toBe(422);
      expect(inactive.body.code).toBe('FARE_TABLE_INACTIVE');

      const unknown = await assign(admin, trip.id, { fareTableVersionId: UNKNOWN_ID });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('FARE_TABLE_VERSION_NOT_FOUND');

      // Another route, then another version of the same route.
      const other = await pricedRoute(t.app, countryId);
      const foreign = await publishedFareTable(admin, other, [fare(other.A, other.B)]);
      const incompatible = await assign(admin, trip.id, { fareTableVersionId: foreign.versionId });
      expect(incompatible.status).toBe(422);
      expect(incompatible.body.code).toBe('TRIP_FARE_TABLE_INCOMPATIBLE');
      const laterRouteVersion = await db(t.app).routeVersion.create({
        data: { routeId: other.routeId, version: 2 },
      });
      const waypoints = await db(t.app).routeWaypoint.findMany({
        where: { routeVersionId: other.routeVersionId },
        orderBy: { sequence: 'asc' },
      });
      await db(t.app).routeWaypoint.createMany({
        data: waypoints.map(
          ({ sequence, stopId, checkpointId, boardingAllowed, alightingAllowed }) => ({
            routeVersionId: laterRouteVersion.id,
            sequence,
            stopId,
            checkpointId,
            boardingAllowed,
            alightingAllowed,
          }),
        ),
      });
      await db(t.app).routeVersion.update({
        where: { id: other.routeVersionId },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      await db(t.app).routeVersion.update({
        where: { id: laterRouteVersion.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      const otherTrip = await pricedTrip(t.app, {
        ...other,
        routeVersionId: other.routeVersionId,
      });
      const laterTable = await createFareTable(api, other.routeId);
      const laterDraft = await createFareDraft(api, laterTable.id, laterRouteVersion.id);
      const [la, , lb] = await db(t.app).routeWaypoint.findMany({
        where: { routeVersionId: laterRouteVersion.id },
        orderBy: { sequence: 'asc' },
      });
      await api.post(`/pricing/fare-tables/${laterTable.id}/versions/${laterDraft.id}/fares`, {
        fares: [fare(la!.id, lb!.id)],
      });
      await api.post(`/pricing/fare-tables/${laterTable.id}/versions/${laterDraft.id}/publish`, {});
      const otherVersion = await assign(admin, otherTrip.id, { fareTableVersionId: laterDraft.id });
      expect(otherVersion.status).toBe(422);
      expect(otherVersion.body.code).toBe('TRIP_FARE_TABLE_INCOMPATIBLE');
      expect((await stored(trip.id)).fareTableVersionId).toBeNull();
      expect((await stored(otherTrip.id)).fareTableVersionId).toBeNull();
    });

    it('is DRAFT-only: frozen once scheduled or cancelled; pricing stays optional for scheduling', async () => {
      const { versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      await assign(admin, trip.id, { fareTableVersionId: versionId });
      expect((await adminApi(admin).post(`/trips/${trip.id}/schedule`, {})).status).toBe(200);
      const frozen = await assign(admin, trip.id, { fareTableVersionId: null });
      expect(frozen.status).toBe(409);
      expect(frozen.body.code).toBe('TRIP_NOT_DRAFT');
      await adminApi(admin).post(`/trips/${trip.id}/cancel`, { reason: 'Annulation' });
      expect((await assign(admin, trip.id, { fareTableVersionId: null })).body.code).toBe(
        'TRIP_CANCELLED',
      );
      expect((await stored(trip.id)).fareTableVersionId).toBe(versionId);

      const unpriced = await pricedTrip(t.app, route);
      const scheduled = await adminApi(admin).post(`/trips/${unpriced.id}/schedule`, {});
      expect(scheduled.status).toBe(200);
      expect(scheduled.body).toMatchObject({ fareTableVersionId: null, fareTableVersion: null });
    });

    it('rolls the assignment back when the audit insert fails', async () => {
      const { versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_trip_fare_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'TRIP_FARE_TABLE_CHANGED' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_trip_fare_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_trip_fare_audit()',
      );
      try {
        expect((await assign(admin, trip.id, { fareTableVersionId: versionId })).status).toBe(500);
        expect((await stored(trip.id)).fareTableVersionId).toBeNull();
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_trip_fare_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_trip_fare_audit()');
      }
      expect((await assign(admin, trip.id, { fareTableVersionId: versionId })).status).toBe(200);
    });
  });

  describe('fare resolution', () => {
    it('resolves the exact amount, currency and identifiers from the trip version', async () => {
      const { table, versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      await assign(admin, trip.id, { fareTableVersionId: versionId });
      const response = await resolve(admin, trip.id, route.A, route.B);
      expect(response.status).toBe(200);
      const entry = await db(t.app).fareEntry.findFirstOrThrow({
        where: {
          fareTableVersionId: versionId,
          originRouteWaypointId: route.A,
          destinationRouteWaypointId: route.B,
        },
      });
      expect(response.body).toEqual({
        tripId: trip.id,
        fareTableId: table.id,
        fareTableCode: table.code,
        fareTableVersionId: versionId,
        fareTableVersion: 1,
        fareEntryId: entry.id,
        originRouteWaypointId: route.A,
        destinationRouteWaypointId: route.B,
        amountMinor: 12345,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
      });
      expect(Number.isInteger(response.body.amountMinor)).toBe(true);
      expect((await resolve(admin, trip.id, route.A, route.D)).body.amountMinor).toBe(20000);
    });

    it('reports unpriced trips, missing pairs and invalid waypoints without any fallback', async () => {
      const { versionId } = await publishedFareTable(admin, route);
      const unpriced = await pricedTrip(t.app, route);
      const none = await resolve(admin, unpriced.id, route.A, route.B);
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('TRIP_PRICING_NOT_CONFIGURED');

      const trip = await pricedTrip(t.app, route);
      await assign(admin, trip.id, { fareTableVersionId: versionId });
      // B -> D is a valid pair but not priced: no interpolation from A -> B and A -> D.
      const missing = await resolve(admin, trip.id, route.B, route.D);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('FARE_NOT_CONFIGURED');

      const other = await pricedRoute(t.app, countryId);
      for (const [origin, destination] of [
        [route.A, route.C],
        [route.D, route.B],
        [route.B, route.A],
        [route.B, route.B],
        [other.A, other.B],
        [UNKNOWN_ID, route.B],
      ] as const) {
        const response = await resolve(admin, trip.id, origin, destination);
        expect(response.status, `${origin}->${destination}`).toBe(422);
        expect(response.body.code).toBe('FARE_WAYPOINT_INVALID');
      }
      expect(
        (await adminApi(admin).get(`/trips/${trip.id}/fare?originRouteWaypointId=${route.A}`))
          .status,
      ).toBe(400);
      expect((await resolve(admin, UNKNOWN_ID, route.A, route.B)).status).toBe(404);
      const raw = await resolve(admin, trip.id, 'not-a-uuid', route.B);
      expect(raw.status).toBe(400);
      expect(JSON.stringify(raw.body)).not.toMatch(/prisma|postgres|SQL/i);
    });

    it('keeps resolving a historical trip after its version is retired and its table deactivated', async () => {
      const { api, table, versionId } = await publishedFareTable(admin, route);
      const trip = await pricedTrip(t.app, route);
      await assign(admin, trip.id, { fareTableVersionId: versionId });
      await adminApi(admin).post(`/trips/${trip.id}/schedule`, {});
      const next = await createFareDraft(api, table.id, route.routeVersionId);
      await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/fares`, {
        fares: [fare(route.A, route.B, 99999)],
      });
      await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/publish`, {});
      await api.post(`/pricing/fare-tables/${table.id}`, { active: false });

      const detail = await adminApi(admin).get(`/trips/${trip.id}`);
      expect(detail.body.fareTableVersion).toMatchObject({
        id: versionId,
        status: 'RETIRED',
        fareTable: { active: false },
      });
      expect((await resolve(admin, trip.id, route.A, route.B)).body).toMatchObject({
        amountMinor: 12345,
        fareTableVersionId: versionId,
      });
      expect(
        (await adminApi(admin).post(`/trips/${trip.id}/cancel`, { reason: 'Fin' })).status,
      ).toBe(200);
      const usage = await adminApi(admin).get(`/pricing/fare-tables/${table.id}`);
      expect(
        usage.body.versions.find((version: { id: string }) => version.id === versionId),
      ).toMatchObject({
        status: 'RETIRED',
        tripCount: 1,
      });
    });
  });

  describe('concurrency', () => {
    it('two concurrent assignments decided on the same state: exactly one applies', async () => {
      const [a, b] = [
        await publishedFareTable(admin, route),
        await publishedFareTable(admin, route),
      ];
      const trip = await pricedTrip(t.app, route);
      const results = await Promise.all([
        assign(admin, trip.id, {
          fareTableVersionId: a.versionId,
          expectedFareTableVersionId: null,
        }),
        assign(dispatcher, trip.id, {
          fareTableVersionId: b.versionId,
          expectedFareTableVersionId: null,
        }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = results.find((response) => response.status === 200)?.body.fareTableVersionId;
      expect((await stored(trip.id)).fareTableVersionId).toBe(winner);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: trip.id, action: 'TRIP_FARE_TABLE_CHANGED' },
        }),
      ).toBe(1);
    });

    it('assignment racing scheduling ends in one historical state', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { versionId } = await publishedFareTable(admin, route);
        const trip = await pricedTrip(t.app, route);
        const [assigned, schedule] = await Promise.all([
          assign(admin, trip.id, { fareTableVersionId: versionId }),
          adminApi(dispatcher).post(`/trips/${trip.id}/schedule`, {}),
        ]);
        expect(schedule.status).toBe(200);
        expect([200, 409]).toContain(assigned.status);
        expect(await stored(trip.id)).toMatchObject({
          status: 'SCHEDULED',
          fareTableVersionId: assigned.status === 200 ? versionId : null,
        });
      }
    });

    it('assignment racing the supersession of its version is serialized (no deadlock)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { api, table, versionId } = await publishedFareTable(admin, route);
        const next = await createFareDraft(api, table.id, route.routeVersionId);
        await api.post(`/pricing/fare-tables/${table.id}/versions/${next.id}/fares`, {
          fares: [fare(route.A, route.B, 1)],
        });
        const trip = await pricedTrip(t.app, route);
        const [assigned, publish] = await Promise.all([
          assign(dispatcher, trip.id, { fareTableVersionId: versionId }),
          adminApi(admin).post(`/pricing/fare-tables/${table.id}/versions/${next.id}/publish`, {}),
        ]);
        expect(publish.status).toBe(200);
        // Either the version was still PUBLISHED when assigned, or it was refused as retired.
        expect([200, 422]).toContain(assigned.status);
        if (assigned.status === 422) expect(assigned.body.code).toBe('FARE_TABLE_VERSION_RETIRED');
        expect((await stored(trip.id)).fareTableVersionId).toBe(
          assigned.status === 200 ? versionId : null,
        );
      }
    });
  });
});
