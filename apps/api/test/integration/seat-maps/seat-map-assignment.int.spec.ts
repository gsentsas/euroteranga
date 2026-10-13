import { randomBytes } from 'node:crypto';
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
  basicLayout,
  createDraft,
  createSeatMap,
  publishedSeatMap,
} from '../../support/seat-map-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Seat maps on vehicles (current configuration) and trips (historical
 * layout): assignment rules, compatibility, concurrency and history. Own
 * database; routes, vehicles and trips are synthetic fixtures written
 * directly, assignments go through the API.
 */
describe('seat-map assignment to vehicles and trips (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let dispatcher: StaffActor;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, dispatcher] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QA', iso3: 'QAA', name: 'Pays A' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();

  async function vehicle(seatMapVersionId?: string) {
    const created = await db(t.app).vehicle.create({
      data: { code: `VH_${suffix()}`, manufacturer: 'Constructeur', model: 'Modèle' },
    });
    await db(t.app).vehicle.update({ where: { id: created.id }, data: { status: 'ACTIVE' } });
    if (seatMapVersionId) {
      await db(t.app).vehicle.update({ where: { id: created.id }, data: { seatMapVersionId } });
    }
    return created;
  }

  /** A DRAFT trip with a complete timetable (2-stop published route). */
  async function draftTrip(vehicleId?: string) {
    const stop = () =>
      db(t.app).stop.create({
        data: {
          code: `S_${suffix()}`,
          name: 'Arrêt',
          countryId,
          locality: 'L',
          latitude: 1,
          longitude: 1,
          timezone: 'Etc/UTC',
        },
      });
    const [a, b] = [await stop(), await stop()];
    const route = await db(t.app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: a.id },
        { routeVersionId: version.id, sequence: 2, stopId: b.id },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    const waypoints = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: version.id },
      orderBy: { sequence: 'asc' },
    });
    const trip = await db(t.app).trip.create({
      data: {
        reference: `ET-TEST-2030-${suffix()}`,
        routeVersionId: version.id,
        ...(vehicleId ? { vehicleId } : {}),
      },
    });
    const departure = new Date('2030-03-01T08:00:00Z');
    const arrival = new Date('2030-03-01T12:00:00Z');
    await db(t.app).tripWaypointTiming.createMany({
      data: [
        {
          tripId: trip.id,
          routeWaypointId: waypoints[0]!.id,
          sequence: 1,
          plannedDepartureAt: departure,
        },
        {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: arrival,
        },
      ],
    });
    await db(t.app).trip.update({
      where: { id: trip.id },
      data: { plannedDepartureAt: departure, plannedArrivalAt: arrival },
    });
    return trip;
  }

  const vehicleSeatMap = (actor: StaffActor, id: string, body: Record<string, unknown>) =>
    adminApi(actor).post(`/fleet/vehicles/${id}/seat-map`, body);
  const tripSeatMap = (actor: StaffActor, id: string, body: Record<string, unknown>) =>
    adminApi(actor).post(`/trips/${id}/seat-map`, body);
  const stored = (id: string) => db(t.app).trip.findUniqueOrThrow({ where: { id } });

  describe('permissions', () => {
    it('needs fleet.manage or trip.manage AND seatmap.read, plus CSRF', async () => {
      const { versionId } = await publishedSeatMap(admin);
      const bus = await vehicle();
      const trip = await draftTrip();
      const fleetOnly = adminApi(
        await staffActor(t.app, [
          await createTestRole(t.app, ['ops.access', 'fleet.manage', 'fleet.read']),
        ]),
      );
      const tripOnly = adminApi(
        await staffActor(t.app, [
          await createTestRole(t.app, ['ops.access', 'trip.manage', 'trip.read']),
        ]),
      );
      expect(
        (
          await fleetOnly.post(`/fleet/vehicles/${bus.id}/seat-map`, {
            seatMapVersionId: versionId,
          })
        ).status,
      ).toBe(403);
      expect(
        (await tripOnly.post(`/trips/${trip.id}/seat-map`, { seatMapVersionId: versionId })).status,
      ).toBe(403);
      const reader = adminApi(await staffActor(t.app, ['BOOKING_AGENT']));
      expect(
        (await reader.post(`/fleet/vehicles/${bus.id}/seat-map`, { seatMapVersionId: versionId }))
          .status,
      ).toBe(403);
      expect(
        (await reader.post(`/trips/${trip.id}/seat-map`, { seatMapVersionId: versionId })).status,
      ).toBe(403);
      const api = adminApi(admin);
      expect(
        (
          await api.post(
            `/fleet/vehicles/${bus.id}/seat-map`,
            { seatMapVersionId: versionId },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await api.post(
            `/trips/${trip.id}/seat-map`,
            { seatMapVersionId: versionId },
            { csrf: null },
          )
        ).status,
      ).toBe(403);
      expect(
        (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: bus.id } })).seatMapVersionId,
      ).toBeNull();
      expect((await stored(trip.id)).seatMapVersionId).toBeNull();
      // seatmap.manage is not required: DISPATCHER (trip.manage + seatmap.read) may assign.
      expect((await tripSeatMap(dispatcher, trip.id, { seatMapVersionId: versionId })).status).toBe(
        200,
      );
    });
  });

  describe('vehicles', () => {
    it('assigns, replaces and removes a published seat map, exposing its capacity', async () => {
      const [first, second] = [
        await publishedSeatMap(admin),
        await publishedSeatMap(admin, [
          ...basicLayout(),
          { deck: 1, row: 3, column: 1, kind: 'SEAT', seatLabel: '2A' },
        ]),
      ];
      const bus = await vehicle();
      const assigned = await vehicleSeatMap(admin, bus.id, {
        seatMapVersionId: first.versionId,
        expectedSeatMapVersionId: null,
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.seatMapVersion).toMatchObject({
        id: first.versionId,
        version: 1,
        seatCount: 2,
        seatMap: { code: first.map.code },
      });
      const replaced = await vehicleSeatMap(admin, bus.id, {
        seatMapVersionId: second.versionId,
        expectedSeatMapVersionId: first.versionId,
      });
      expect(replaced.body.seatMapVersion).toMatchObject({ id: second.versionId, seatCount: 3 });
      const removed = await vehicleSeatMap(admin, bus.id, { seatMapVersionId: null });
      expect(removed.body.seatMapVersion).toBeNull();
      // The general update never accepts it.
      expect(
        (
          await adminApi(admin).post(`/fleet/vehicles/${bus.id}`, {
            seatMapVersionId: first.versionId,
          })
        ).status,
      ).toBe(400);
      const events = await db(t.app).auditEvent.findMany({
        where: { resourceId: bus.id, action: 'VEHICLE_SEAT_MAP_CHANGED' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(
        events.map((event) => [
          (event.before as { seatMap: string | null }).seatMap,
          (event.after as { seatMap: string | null }).seatMap,
        ]),
      ).toEqual([
        [null, `${first.map.code} v1`],
        [`${first.map.code} v1`, `${second.map.code} v1`],
        [`${second.map.code} v1`, null],
      ]);
    });

    it('refuses draft, retired and inactive versions, stale decisions and retired vehicles', async () => {
      const api = adminApi(admin);
      const bus = await vehicle();
      const map = await createSeatMap(api);
      const draft = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, { cells: basicLayout() });
      const notPublished = await vehicleSeatMap(admin, bus.id, { seatMapVersionId: draft.id });
      expect(notPublished.status).toBe(422);
      expect(notPublished.body.code).toBe('SEAT_MAP_VERSION_NOT_PUBLISHED');

      await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {});
      const next = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${next.id}/cells`, { cells: basicLayout('2') });
      await api.post(`/seat-maps/${map.id}/versions/${next.id}/publish`, {});
      const retired = await vehicleSeatMap(admin, bus.id, { seatMapVersionId: draft.id });
      expect(retired.status).toBe(422);
      expect(retired.body.code).toBe('SEAT_MAP_VERSION_RETIRED');

      await api.post(`/seat-maps/${map.id}`, { active: false });
      const inactive = await vehicleSeatMap(admin, bus.id, { seatMapVersionId: next.id });
      expect(inactive.status).toBe(422);
      expect(inactive.body.code).toBe('SEAT_MAP_INACTIVE');
      await api.post(`/seat-maps/${map.id}`, { active: true });

      const stale = await vehicleSeatMap(admin, bus.id, {
        seatMapVersionId: next.id,
        expectedSeatMapVersionId: draft.id,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VEHICLE_SEAT_MAP_CONFLICT');
      expect(
        (
          await vehicleSeatMap(admin, bus.id, {
            seatMapVersionId: '01900000-0000-7000-8000-000000000000',
          })
        ).status,
      ).toBe(404);

      const old = await vehicle();
      await db(t.app).vehicle.update({
        where: { id: old.id },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      const frozen = await vehicleSeatMap(admin, old.id, { seatMapVersionId: next.id });
      expect(frozen.status).toBe(409);
      expect(frozen.body.code).toBe('VEHICLE_RETIRED');
    });

    it('two concurrent assignments decided on the same state: exactly one applies', async () => {
      const [a, b] = [await publishedSeatMap(admin), await publishedSeatMap(admin)];
      const bus = await vehicle();
      const results = await Promise.all([
        vehicleSeatMap(admin, bus.id, {
          seatMapVersionId: a.versionId,
          expectedSeatMapVersionId: null,
        }),
        vehicleSeatMap(admin, bus.id, {
          seatMapVersionId: b.versionId,
          expectedSeatMapVersionId: null,
        }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = results.find((response) => response.status === 200)?.body.seatMapVersion.id;
      expect(
        (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: bus.id } })).seatMapVersionId,
      ).toBe(winner);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: bus.id, action: 'VEHICLE_SEAT_MAP_CHANGED' },
        }),
      ).toBe(1);
    });

    it('an assignment racing the supersession of its version is serialized (no deadlock)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { api, map, versionId } = await publishedSeatMap(admin);
        const next = await createDraft(api, map.id);
        await api.post(`/seat-maps/${map.id}/versions/${next.id}/cells`, {
          cells: basicLayout('2'),
        });
        const bus = await vehicle();
        const [assign, publish] = await Promise.all([
          vehicleSeatMap(admin, bus.id, { seatMapVersionId: versionId }),
          adminApi(admin).post(`/seat-maps/${map.id}/versions/${next.id}/publish`, {}),
        ]);
        expect(publish.status).toBe(200);
        // Either the version was still PUBLISHED when assigned, or it was refused as retired.
        expect([200, 422]).toContain(assign.status);
        expect(
          (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: bus.id } })).seatMapVersionId,
        ).toBe(assign.status === 200 ? versionId : null);
      }
    });
  });

  describe('trips', () => {
    it('assigns the historical seat map of a DRAFT trip; frozen once scheduled', async () => {
      const { versionId, map } = await publishedSeatMap(admin);
      const trip = await draftTrip();
      const assigned = await tripSeatMap(admin, trip.id, {
        seatMapVersionId: versionId,
        expectedSeatMapVersionId: null,
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.seatMapVersion).toMatchObject({
        id: versionId,
        seatCount: 2,
        seatMap: { code: map.code },
      });
      expect(assigned.body.history[0]).toMatchObject({
        action: 'TRIP_SEAT_MAP_CHANGED',
        fromSeatMap: null,
        toSeatMap: `${map.code} v1`,
      });
      const stale = await tripSeatMap(admin, trip.id, {
        seatMapVersionId: null,
        expectedSeatMapVersionId: null,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('TRIP_SEAT_MAP_CONFLICT');

      expect((await adminApi(admin).post(`/trips/${trip.id}/schedule`, {})).status).toBe(200);
      const frozen = await tripSeatMap(admin, trip.id, { seatMapVersionId: null });
      expect(frozen.status).toBe(409);
      expect(frozen.body.code).toBe('TRIP_NOT_DRAFT');
      await adminApi(admin).post(`/trips/${trip.id}/cancel`, { reason: 'Annulation' });
      expect((await tripSeatMap(admin, trip.id, { seatMapVersionId: null })).body.code).toBe(
        'TRIP_CANCELLED',
      );
      expect((await stored(trip.id)).seatMapVersionId).toBe(versionId);
    });

    it('requires the vehicle to carry exactly the trip seat map, in both orders and at scheduling', async () => {
      const [layout, other] = [await publishedSeatMap(admin), await publishedSeatMap(admin)];
      const matching = await vehicle(layout.versionId);
      const different = await vehicle(other.versionId);
      const bare = await vehicle();

      // Vehicle first: the seat map must be the vehicle's.
      const withBare = await draftTrip(bare.id);
      const incompatible = await tripSeatMap(admin, withBare.id, {
        seatMapVersionId: layout.versionId,
      });
      expect(incompatible.status).toBe(422);
      expect(incompatible.body.code).toBe('TRIP_SEAT_MAP_INCOMPATIBLE');
      const withMatching = await draftTrip(matching.id);
      expect(
        (await tripSeatMap(admin, withMatching.id, { seatMapVersionId: layout.versionId })).status,
      ).toBe(200);

      // Seat map first: only a vehicle configured with it is accepted.
      const trip = await draftTrip();
      await tripSeatMap(admin, trip.id, { seatMapVersionId: layout.versionId });
      for (const candidate of [different, bare]) {
        const response = await adminApi(admin).post(`/trips/${trip.id}/vehicle`, {
          vehicleId: candidate.id,
        });
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('TRIP_SEAT_MAP_INCOMPATIBLE');
      }
      expect(
        (await adminApi(admin).post(`/trips/${trip.id}/vehicle`, { vehicleId: matching.id }))
          .status,
      ).toBe(200);
      // No implicit change on either side.
      expect(
        (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: bare.id } })).seatMapVersionId,
      ).toBeNull();

      // The vehicle is reconfigured while the trip is DRAFT: scheduling is refused.
      await vehicleSeatMap(admin, matching.id, { seatMapVersionId: other.versionId });
      const refused = await adminApi(admin).post(`/trips/${trip.id}/schedule`, {});
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('TRIP_SEAT_MAP_INCOMPATIBLE');
      await vehicleSeatMap(admin, matching.id, { seatMapVersionId: layout.versionId });
      expect((await adminApi(admin).post(`/trips/${trip.id}/schedule`, {})).status).toBe(200);
    });

    it('lets trips without a seat map be scheduled (PR-06 behaviour)', async () => {
      const trip = await draftTrip((await vehicle()).id);
      const response = await adminApi(admin).post(`/trips/${trip.id}/schedule`, {});
      expect(response.status).toBe(200);
      expect(response.body.seatMapVersion).toBeNull();
    });

    it('two concurrent seat-map assignments decided on the same state: exactly one applies', async () => {
      const [a, b] = [await publishedSeatMap(admin), await publishedSeatMap(admin)];
      const trip = await draftTrip();
      const results = await Promise.all([
        tripSeatMap(admin, trip.id, {
          seatMapVersionId: a.versionId,
          expectedSeatMapVersionId: null,
        }),
        tripSeatMap(dispatcher, trip.id, {
          seatMapVersionId: b.versionId,
          expectedSeatMapVersionId: null,
        }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: trip.id, action: 'TRIP_SEAT_MAP_CHANGED' },
        }),
      ).toBe(1);
    });

    it('seat-map assignment racing scheduling ends in one historical state', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { versionId } = await publishedSeatMap(admin);
        const trip = await draftTrip();
        const [assign, schedule] = await Promise.all([
          tripSeatMap(admin, trip.id, { seatMapVersionId: versionId }),
          adminApi(dispatcher).post(`/trips/${trip.id}/schedule`, {}),
        ]);
        expect(schedule.status).toBe(200);
        expect([200, 409]).toContain(assign.status);
        expect(await stored(trip.id)).toMatchObject({
          status: 'SCHEDULED',
          seatMapVersionId: assign.status === 200 ? versionId : null,
        });
      }
    });

    it('vehicle change racing seat-map assignment never leaves an incompatible trip', async () => {
      for (let round = 0; round < 3; round += 1) {
        const [layout, other] = [await publishedSeatMap(admin), await publishedSeatMap(admin)];
        const bus = await vehicle(other.versionId);
        const trip = await draftTrip();
        const [assign, change] = await Promise.all([
          tripSeatMap(admin, trip.id, { seatMapVersionId: layout.versionId }),
          adminApi(dispatcher).post(`/trips/${trip.id}/vehicle`, { vehicleId: bus.id }),
        ]);
        // Exactly one of the two can apply: they are incompatible.
        expect([assign.status, change.status].sort()).toEqual([200, 422]);
        const final = await stored(trip.id);
        expect(final.seatMapVersionId !== null && final.vehicleId !== null).toBe(false);
      }
    });
  });

  describe('history', () => {
    it('keeps vehicles and trips on a version retired later', async () => {
      const { api, map, versionId } = await publishedSeatMap(admin);
      const bus = await vehicle(versionId);
      const trip = await draftTrip(bus.id);
      await tripSeatMap(admin, trip.id, { seatMapVersionId: versionId });
      await adminApi(admin).post(`/trips/${trip.id}/schedule`, {});
      const next = await createDraft(api, map.id);
      await api.post(`/seat-maps/${map.id}/versions/${next.id}/cells`, { cells: basicLayout('2') });
      await api.post(`/seat-maps/${map.id}/versions/${next.id}/publish`, {});

      const detail = await adminApi(admin).get(`/trips/${trip.id}`);
      expect(detail.body.seatMapVersion).toMatchObject({
        id: versionId,
        status: 'RETIRED',
        seatCount: 2,
      });
      const fleet = await adminApi(admin).get(`/fleet/vehicles/${bus.id}`);
      expect(fleet.body.seatMapVersion).toMatchObject({ id: versionId, status: 'RETIRED' });
      // Fleet is not blocked: the vehicle moves to the new version, the trip keeps its own.
      expect((await vehicleSeatMap(admin, bus.id, { seatMapVersionId: next.id })).status).toBe(200);
      expect((await stored(trip.id)).seatMapVersionId).toBe(versionId);
      expect(
        (await adminApi(admin).post(`/trips/${trip.id}/cancel`, { reason: 'Fin' })).status,
      ).toBe(200);
      const usage = await adminApi(admin).get(`/seat-maps/${map.id}`);
      expect(
        usage.body.versions.find((version: { id: string }) => version.id === versionId),
      ).toMatchObject({
        status: 'RETIRED',
        tripCount: 1,
        vehicleCount: 0,
      });
    });

    it('rolls vehicle and trip seat-map changes back when the audit insert fails', async () => {
      const { versionId } = await publishedSeatMap(admin);
      const bus = await vehicle();
      const trip = await draftTrip();
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_layout_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('VEHICLE_SEAT_MAP_CHANGED', 'TRIP_SEAT_MAP_CHANGED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_layout_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_layout_audit()',
      );
      try {
        expect((await vehicleSeatMap(admin, bus.id, { seatMapVersionId: versionId })).status).toBe(
          500,
        );
        expect((await tripSeatMap(admin, trip.id, { seatMapVersionId: versionId })).status).toBe(
          500,
        );
        expect(
          (await db(t.app).vehicle.findUniqueOrThrow({ where: { id: bus.id } })).seatMapVersionId,
        ).toBeNull();
        expect((await stored(trip.id)).seatMapVersionId).toBeNull();
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_layout_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_layout_audit()');
      }
    });
  });
});
