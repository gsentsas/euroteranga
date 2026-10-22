import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';
const HOUR = 3_600_000;
const iso = (dayOffset: number, hours: number) =>
  new Date(Date.UTC(2030, 0, 15 + dayOffset, 8) + hours * HOUR).toISOString();

interface Waypoint {
  id: string;
  sequence: number;
}

/**
 * Trip administration through the HTTP API, on its own database (one test
 * installs a temporary failing trigger on audit_event). Route versions and
 * vehicles are synthetic fixtures written directly; trip operations go
 * through the API.
 */
describe('trip administration API (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let dispatcher: StaffActor;
  let reader: StaffActor;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    [admin, dispatcher, reader] = await Promise.all([
      staffActor(t.app, ['SUPER_ADMIN']),
      staffActor(t.app, ['DISPATCHER']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QV', iso3: 'QVV', name: 'Pays voyages' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();
  const reference = () => `ET-TEST-2030-${suffix()}`;

  async function place(kind: 'stop' | 'checkpoint') {
    const data = {
      code: `${kind === 'stop' ? 'S' : 'C'}_${suffix()}`,
      name: `Point ${kind}`,
      countryId,
      locality: 'Localité',
      latitude: 10,
      longitude: 10,
      timezone: 'Etc/UTC',
    };
    return kind === 'stop'
      ? db(t.app).stop.create({ data })
      : db(t.app).checkpoint.create({ data: { ...data, type: 'TECHNICAL' } });
  }

  /** stop -> checkpoint -> stop, in the requested lifecycle state. */
  async function routeVersion(state: 'DRAFT' | 'PUBLISHED' | 'RETIRED' = 'PUBLISHED') {
    const [a, c, b] = [await place('stop'), await place('checkpoint'), await place('stop')];
    const route = await db(t.app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: a.id, boardingAllowed: true },
        { routeVersionId: version.id, sequence: 2, checkpointId: c.id },
        { routeVersionId: version.id, sequence: 3, stopId: b.id, alightingAllowed: true },
      ],
    });
    if (state !== 'DRAFT') {
      await db(t.app).routeVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(Date.now() - 1000) },
      });
    }
    if (state === 'RETIRED') {
      await db(t.app).routeVersion.update({
        where: { id: version.id },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
    }
    const waypoints: Waypoint[] = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: version.id },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true },
    });
    return { routeId: route.id, versionId: version.id, waypoints };
  }

  async function vehicle(status: 'PLANNED' | 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED' = 'ACTIVE') {
    const created = await db(t.app).vehicle.create({
      data: { code: `VH_${suffix()}`, manufacturer: 'Constructeur', model: 'Modèle' },
    });
    const steps = {
      PLANNED: [],
      ACTIVE: ['ACTIVE'],
      OUT_OF_SERVICE: ['ACTIVE', 'OUT_OF_SERVICE'],
      RETIRED: ['RETIRED'],
    }[status];
    for (const next of steps) {
      await db(t.app).vehicle.update({
        where: { id: created.id },
        data: { status: next as 'ACTIVE', retiredAt: next === 'RETIRED' ? new Date() : null },
      });
    }
    return created;
  }

  /** A complete valid timetable starting `day` days after the base date. */
  const timetable = (waypoints: Waypoint[], day = 0) => ({
    timings: [
      {
        routeWaypointId: waypoints[0]!.id,
        plannedArrivalAt: null,
        plannedDepartureAt: iso(day, 0),
      },
      {
        routeWaypointId: waypoints[1]!.id,
        plannedArrivalAt: iso(day, 2),
        plannedDepartureAt: iso(day, 2.25),
      },
      {
        routeWaypointId: waypoints[2]!.id,
        plannedArrivalAt: iso(day, 4),
        plannedDepartureAt: null,
      },
    ],
  });

  async function createTrip(actor = admin, body: Record<string, unknown> = {}) {
    const version = (body.routeVersionId as string | undefined) ? null : await routeVersion();
    const response = await adminApi(actor).post('/trips', {
      reference: reference(),
      routeVersionId: version?.versionId,
      ...body,
    });
    if (response.status !== 201) throw new Error(`trip: ${response.status} ${response.text}`);
    return { trip: response.body as { id: string; reference: string }, version };
  }

  async function draftWithTimetable(day = 0) {
    const { trip, version } = await createTrip();
    const response = await adminApi(admin).post(
      `/trips/${trip.id}/timetable`,
      timetable(version!.waypoints, day),
    );
    if (response.status !== 200) throw new Error(`timetable: ${response.status} ${response.text}`);
    return { trip, version: version! };
  }

  const status = async (id: string) => db(t.app).trip.findUniqueOrThrow({ where: { id } });

  describe('authorization', () => {
    it('lets trip.read holders read and refuses others with 403', async () => {
      const { trip } = await createTrip();
      const api = adminApi(reader);
      expect((await api.get('/trips')).status).toBe(200);
      expect((await api.get(`/trips/${trip.id}`)).status).toBe(200);
      const finance = adminApi(await staffActor(t.app, ['FINANCE']));
      for (const path of ['/trips', `/trips/${trip.id}`]) {
        const response = await finance.get(path);
        expect(response.status, path).toBe(403);
        expect(response.body.code).toBe('FORBIDDEN');
      }
    });

    it('lets trip.manage holders mutate and refuses read-only roles with 403', async () => {
      const { trip, version } = await createTrip(dispatcher);
      const api = adminApi(reader);
      const attempts = [
        await api.post('/trips', { reference: reference(), routeVersionId: version!.versionId }),
        await api.post(`/trips/${trip.id}/timetable`, timetable(version!.waypoints)),
        await api.post(`/trips/${trip.id}/schedule`, {}),
        await api.post(`/trips/${trip.id}/cancel`, { reason: 'Interdit' }),
        await api.post(`/trips/${trip.id}/vehicle`, { vehicleId: null }),
        await api.post(`/trips/${trip.id}/costs`, {
          status: 'DRAFT',
          currencyCode: 'EUR',
          items: [],
        }),
      ];
      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.code).toBe('FORBIDDEN');
      }
      expect(await status(trip.id)).toMatchObject({ status: 'DRAFT', plannedDepartureAt: null });
      expect(await db(t.app).tripWaypointTiming.count({ where: { tripId: trip.id } })).toBe(0);
    });

    it('requires a valid CSRF token on every mutation', async () => {
      const { trip, version } = await createTrip();
      const api = adminApi(admin);
      const calls: Array<[string, unknown]> = [
        ['/trips', { reference: reference(), routeVersionId: version!.versionId }],
        [`/trips/${trip.id}/timetable`, timetable(version!.waypoints)],
        [`/trips/${trip.id}/schedule`, {}],
        [`/trips/${trip.id}/cancel`, { reason: 'Sans CSRF' }],
        [`/trips/${trip.id}/vehicle`, { vehicleId: null }],
        [`/trips/${trip.id}/costs`, { status: 'DRAFT', currencyCode: 'EUR', items: [] }],
      ];
      for (const [path, body] of calls) {
        expect((await api.post(path, body, { csrf: null })).status, path).toBe(403);
        expect((await api.post(path, body, { csrf: 'v1.9999999999.x.y' })).status, path).toBe(403);
      }
      expect(await status(trip.id)).toMatchObject({ status: 'DRAFT' });
    });

    it('exposes no delete endpoint', async () => {
      const { trip } = await createTrip();
      const csrf = await admin.csrf();
      const response = await request(t.app.getHttpServer())
        .delete(`/v1/admin/trips/${trip.id}`)
        .set('Origin', admin.http.origin)
        .set('Cookie', admin.cookie)
        .set('X-CSRF-Token', csrf);
      expect(response.status).toBe(404);
      expect(await db(t.app).trip.count({ where: { id: trip.id } })).toBe(1);
    });
  });

  describe('creation', () => {
    it('creates a DRAFT trip with a normalized reference and no implicit timetable', async () => {
      const version = await routeVersion();
      const response = await adminApi(admin).post('/trips', {
        reference: ' et-test-2030-0001 ',
        routeVersionId: version.versionId,
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        reference: 'ET-TEST-2030-0001',
        status: 'DRAFT',
        plannedDepartureAt: null,
        scheduledAt: null,
        vehicle: null,
        timings: [],
        routeVersion: { id: version.versionId, version: 1, status: 'PUBLISHED' },
      });
      expect(response.body.routeVersion.waypoints).toHaveLength(3);

      const duplicate = await adminApi(admin).post('/trips', {
        reference: 'ET-TEST-2030-0001',
        routeVersionId: version.versionId,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('TRIP_REFERENCE_CONFLICT');
    });

    it('refuses unknown, never-published and retired route versions', async () => {
      const api = adminApi(admin);
      const cases: Array<[string, number, string]> = [
        [UNKNOWN_ID, 404, 'ROUTE_VERSION_NOT_FOUND'],
        [(await routeVersion('DRAFT')).versionId, 422, 'TRIP_ROUTE_VERSION_NOT_PUBLISHED'],
        [(await routeVersion('RETIRED')).versionId, 422, 'TRIP_ROUTE_VERSION_RETIRED'],
      ];
      for (const [routeVersionId, code, name] of cases) {
        const response = await api.post('/trips', { reference: reference(), routeVersionId });
        expect(response.status, name).toBe(code);
        expect(response.body.code).toBe(name);
      }
    });

    it('accepts only an existing ACTIVE vehicle', async () => {
      const version = await routeVersion();
      const api = adminApi(admin);
      for (const [vehicleId, code, name] of [
        [UNKNOWN_ID, 404, 'VEHICLE_NOT_FOUND'],
        [(await vehicle('PLANNED')).id, 422, 'TRIP_VEHICLE_UNAVAILABLE'],
        [(await vehicle('OUT_OF_SERVICE')).id, 422, 'TRIP_VEHICLE_UNAVAILABLE'],
        [(await vehicle('RETIRED')).id, 422, 'TRIP_VEHICLE_UNAVAILABLE'],
      ] as const) {
        const response = await api.post('/trips', {
          reference: reference(),
          routeVersionId: version.versionId,
          vehicleId,
        });
        expect(response.status, name).toBe(code);
        expect(response.body.code).toBe(name);
      }
      const active = await vehicle('ACTIVE');
      const created = await api.post('/trips', {
        reference: reference(),
        routeVersionId: version.versionId,
        vehicleId: active.id,
      });
      expect(created.body.vehicle).toMatchObject({ id: active.id, status: 'ACTIVE' });
    });
  });

  describe('timetable', () => {
    it('replaces the complete timetable atomically and derives the trip times', async () => {
      const { trip, version } = await createTrip();
      const api = adminApi(admin);
      const first = await api.post(`/trips/${trip.id}/timetable`, timetable(version!.waypoints));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        plannedDepartureAt: iso(0, 0),
        plannedArrivalAt: iso(0, 4),
      });
      expect(first.body.timings.map((timing: { sequence: number }) => timing.sequence)).toEqual([
        1, 2, 3,
      ]);

      // Input order does not matter; the sequence comes from the route version.
      const shuffled = timetable(version!.waypoints, 1);
      shuffled.timings.reverse();
      const second = await api.post(`/trips/${trip.id}/timetable`, shuffled);
      expect(second.body).toMatchObject({
        plannedDepartureAt: iso(1, 0),
        plannedArrivalAt: iso(1, 4),
      });
      expect(await db(t.app).tripWaypointTiming.count({ where: { tripId: trip.id } })).toBe(3);
    });

    it('refuses invalid timetables and leaves the stored one untouched', async () => {
      const { trip, version } = await draftWithTimetable();
      const other = await routeVersion();
      const api = adminApi(admin);
      const valid = timetable(version.waypoints, 3);
      const cases: Array<[string, unknown]> = [
        ['missing waypoint', { timings: valid.timings.slice(0, 2) }],
        [
          'waypoint of another version',
          {
            timings: [
              valid.timings[0],
              { ...valid.timings[1], routeWaypointId: other.waypoints[1]!.id },
              valid.timings[2],
            ],
          },
        ],
        [
          'unknown waypoint',
          {
            timings: [
              valid.timings[0],
              { ...valid.timings[1], routeWaypointId: UNKNOWN_ID },
              valid.timings[2],
            ],
          },
        ],
        [
          'not chronological',
          {
            timings: [
              valid.timings[0],
              valid.timings[1],
              { ...valid.timings[2], plannedArrivalAt: iso(3, 1) },
            ],
          },
        ],
        [
          'arrival at the first waypoint',
          {
            timings: [
              { ...valid.timings[0], plannedArrivalAt: iso(2, 23) },
              valid.timings[1],
              valid.timings[2],
            ],
          },
        ],
      ];
      for (const [label, body] of cases) {
        const response = await api.post(`/trips/${trip.id}/timetable`, body);
        expect(response.status, label).toBe(422);
        expect(response.body.code, label).toBe('TRIP_TIMETABLE_INVALID');
      }
      expect(
        (
          await api.post(`/trips/${trip.id}/timetable`, {
            timings: [
              { ...valid.timings[0], plannedDepartureAt: '2030-01-18T08:00:00' },
              valid.timings[1],
              valid.timings[2],
            ],
          })
        ).status,
      ).toBe(400);
      expect(await status(trip.id)).toMatchObject({
        plannedDepartureAt: new Date(iso(0, 0)),
        plannedArrivalAt: new Date(iso(0, 4)),
      });
    });
  });

  describe('lifecycle', () => {
    it('schedules a valid DRAFT, then freezes its timetable', async () => {
      const { trip, version } = await draftWithTimetable();
      const api = adminApi(admin);
      const scheduled = await api.post(`/trips/${trip.id}/schedule`, {});
      expect(scheduled.status).toBe(200);
      expect(scheduled.body).toMatchObject({
        status: 'SCHEDULED',
        scheduledAt: expect.any(String),
      });
      const again = await api.post(`/trips/${trip.id}/schedule`, {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('TRIP_NOT_DRAFT');
      const replace = await api.post(
        `/trips/${trip.id}/timetable`,
        timetable(version.waypoints, 5),
      );
      expect(replace.status).toBe(409);
      expect(replace.body.code).toBe('TRIP_NOT_DRAFT');
    });

    it('refuses to schedule without a timetable or with an unavailable vehicle', async () => {
      const { trip } = await createTrip();
      const missing = await adminApi(admin).post(`/trips/${trip.id}/schedule`, {});
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('TRIP_TIMETABLE_INVALID');

      const bus = await vehicle('ACTIVE');
      const { trip: withVehicle } = await draftWithTimetable();
      await adminApi(admin).post(`/trips/${withVehicle.id}/vehicle`, { vehicleId: bus.id });
      // The vehicle becomes unavailable after assignment (fleet is not blocked).
      await db(t.app).vehicle.update({ where: { id: bus.id }, data: { status: 'OUT_OF_SERVICE' } });
      const refused = await adminApi(admin).post(`/trips/${withVehicle.id}/schedule`, {});
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('TRIP_VEHICLE_UNAVAILABLE');
      expect(await status(withVehicle.id)).toMatchObject({ status: 'DRAFT', scheduledAt: null });
    });

    it('cancels DRAFT and SCHEDULED trips with a reason; CANCELLED is terminal', async () => {
      const api = adminApi(admin);
      const { trip: draft } = await createTrip();
      const cancelledDraft = await api.post(`/trips/${draft.id}/cancel`, {
        reason: 'Brouillon abandonné',
      });
      expect(cancelledDraft.body).toMatchObject({
        status: 'CANCELLED',
        scheduledAt: null,
        cancelledAt: expect.any(String),
      });

      const { trip, version } = await draftWithTimetable();
      await api.post(`/trips/${trip.id}/schedule`, {});
      expect((await api.post(`/trips/${trip.id}/cancel`, {})).status).toBe(400);
      const stale = await api.post(`/trips/${trip.id}/cancel`, {
        reason: 'Fiche périmée',
        expectedStatus: 'DRAFT',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('TRIP_STATUS_CONFLICT');
      const cancelled = await api.post(`/trips/${trip.id}/cancel`, {
        reason: 'Annulation synthétique',
        expectedStatus: 'SCHEDULED',
      });
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        scheduledAt: expect.any(String),
      });

      const after: Array<[string, unknown]> = [
        [`/trips/${trip.id}/cancel`, { reason: 'Encore' }],
        [`/trips/${trip.id}/schedule`, {}],
        [`/trips/${trip.id}/vehicle`, { vehicleId: null }],
      ];
      for (const [path, body] of after) {
        const response = await api.post(path, body);
        expect(response.status, path).toBe(409);
        expect(response.body.code, path).toBe('TRIP_CANCELLED');
      }
      expect(
        (await api.post(`/trips/${trip.id}/timetable`, timetable(version.waypoints, 7))).body.code,
      ).toBe('TRIP_NOT_DRAFT');
    });
  });

  describe('vehicle assignment', () => {
    it('assigns, changes and removes an ACTIVE vehicle; a reason is required once SCHEDULED', async () => {
      const api = adminApi(admin);
      const [first, second] = [await vehicle('ACTIVE'), await vehicle('ACTIVE')];
      const { trip } = await draftWithTimetable();
      expect(
        (await api.post(`/trips/${trip.id}/vehicle`, { vehicleId: first.id })).body.vehicle,
      ).toMatchObject({ id: first.id });
      for (const [vehicleId, code, name] of [
        [UNKNOWN_ID, 404, 'VEHICLE_NOT_FOUND'],
        [(await vehicle('OUT_OF_SERVICE')).id, 422, 'TRIP_VEHICLE_UNAVAILABLE'],
        [(await vehicle('RETIRED')).id, 422, 'TRIP_VEHICLE_UNAVAILABLE'],
      ] as const) {
        const response = await api.post(`/trips/${trip.id}/vehicle`, { vehicleId });
        expect(response.status, name).toBe(code);
        expect(response.body.code).toBe(name);
      }
      await api.post(`/trips/${trip.id}/schedule`, {});
      const noReason = await api.post(`/trips/${trip.id}/vehicle`, { vehicleId: second.id });
      expect(noReason.status).toBe(422);
      expect(noReason.body.code).toBe('TRIP_REASON_REQUIRED');
      const stale = await api.post(`/trips/${trip.id}/vehicle`, {
        vehicleId: second.id,
        expectedVehicleId: null,
        reason: 'Décidé sur une fiche périmée',
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('TRIP_VEHICLE_CONFLICT');
      const changed = await api.post(`/trips/${trip.id}/vehicle`, {
        vehicleId: second.id,
        expectedVehicleId: first.id,
        reason: 'Remplacement synthétique',
      });
      expect(changed.body).toMatchObject({ status: 'SCHEDULED', vehicle: { id: second.id } });
      const removed = await api.post(`/trips/${trip.id}/vehicle`, {
        vehicleId: null,
        reason: 'Retrait synthétique',
      });
      expect(removed.body.vehicle).toBeNull();
      // A vehicle assigned to a scheduled trip may still go out of service:
      // the fleet lifecycle is not blocked (Dispatch will handle it).
      await api.post(`/trips/${trip.id}/vehicle`, { vehicleId: first.id, reason: 'Retour' });
      const outOfService = await adminApi(admin).post(`/fleet/vehicles/${first.id}/status`, {
        status: 'OUT_OF_SERVICE',
        reason: 'Panne après affectation',
      });
      expect(outOfService.status).toBe(200);
    });
  });

  describe('audit and history', () => {
    it('audits each mutation with the request id; the history shows no actor', async () => {
      const bus = await vehicle('ACTIVE');
      const { trip } = await draftWithTimetable();
      await adminApi(admin).post(`/trips/${trip.id}/vehicle`, { vehicleId: bus.id });
      const scheduled = await admin.http
        .post(`/v1/admin/trips/${trip.id}/schedule`, {}, admin.cookie, await admin.csrf())
        .set('X-Request-Id', 'trip-schedule-0001');
      expect(scheduled.status).toBe(200);
      await adminApi(admin).post(`/trips/${trip.id}/cancel`, { reason: 'Annulation auditée' });

      const events = await db(t.app).auditEvent.findMany({
        where: { resourceType: 'trip', resourceId: trip.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((event) => event.action)).toEqual([
        'TRIP_CREATED',
        'TRIP_TIMETABLE_REPLACED',
        'TRIP_VEHICLE_CHANGED',
        'TRIP_SCHEDULED',
        'TRIP_CANCELLED',
      ]);
      expect(events[3]).toMatchObject({
        requestId: 'trip-schedule-0001',
        actorIdentityId: admin.id,
        before: { status: 'DRAFT' },
        after: { status: 'SCHEDULED' },
      });
      expect(events[4]).toMatchObject({ metadata: { reason: 'Annulation auditée' } });

      const detail = await adminApi(reader).get(`/trips/${trip.id}`);
      expect(detail.body.history.map((entry: { action: string }) => entry.action)).toEqual([
        'TRIP_CANCELLED',
        'TRIP_SCHEDULED',
        'TRIP_VEHICLE_CHANGED',
        'TRIP_TIMETABLE_REPLACED',
        'TRIP_CREATED',
      ]);
      expect(detail.body.history[0]).toMatchObject({
        fromStatus: 'SCHEDULED',
        toStatus: 'CANCELLED',
        reason: 'Annulation auditée',
      });
      expect(detail.body.history[2]).toMatchObject({
        fromVehicleCode: null,
        toVehicleCode: bus.code,
      });
      expect(JSON.stringify(detail.body.history)).not.toContain(admin.email);
    });

    it('rolls the mutation back when its audit event cannot be written', async () => {
      const { trip, version } = await draftWithTimetable();
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_trip_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('TRIP_SCHEDULED', 'TRIP_TIMETABLE_REPLACED', 'TRIP_CANCELLED', 'TRIP_VEHICLE_CHANGED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_trip_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_trip_audit()',
      );
      const bus = await vehicle('ACTIVE');
      try {
        const api = adminApi(admin);
        expect(
          (await api.post(`/trips/${trip.id}/timetable`, timetable(version.waypoints, 9))).status,
        ).toBe(500);
        expect((await api.post(`/trips/${trip.id}/vehicle`, { vehicleId: bus.id })).status).toBe(
          500,
        );
        expect((await api.post(`/trips/${trip.id}/schedule`, {})).status).toBe(500);
        expect(
          (await api.post(`/trips/${trip.id}/cancel`, { reason: 'Jamais appliqué' })).status,
        ).toBe(500);
        expect(await status(trip.id)).toMatchObject({
          status: 'DRAFT',
          scheduledAt: null,
          cancelledAt: null,
          vehicleId: null,
          plannedDepartureAt: new Date(iso(0, 0)),
        });
        const timings = await db(t.app).tripWaypointTiming.findMany({
          where: { tripId: trip.id },
          orderBy: { sequence: 'asc' },
        });
        expect(timings[0]?.plannedDepartureAt).toEqual(new Date(iso(0, 0)));
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_trip_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_trip_audit()');
      }
      expect((await adminApi(admin).post(`/trips/${trip.id}/schedule`, {})).status).toBe(200);
    });
  });

  describe('concurrency', () => {
    it('two concurrent timetable replacements never produce a mix', async () => {
      const { trip, version } = await createTrip();
      const results = await Promise.all([
        adminApi(admin).post(`/trips/${trip.id}/timetable`, timetable(version!.waypoints, 10)),
        adminApi(dispatcher).post(`/trips/${trip.id}/timetable`, timetable(version!.waypoints, 20)),
      ]);
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const timings = await db(t.app).tripWaypointTiming.findMany({
        where: { tripId: trip.id },
        orderBy: { sequence: 'asc' },
      });
      // All three timings come from the same submission (day 10 or day 20).
      const day = timings[0]?.plannedDepartureAt?.toISOString() === iso(10, 0) ? 10 : 20;
      expect(timings.map((timing) => [timing.plannedArrivalAt, timing.plannedDepartureAt])).toEqual(
        [
          [null, new Date(iso(day, 0))],
          [new Date(iso(day, 2)), new Date(iso(day, 2.25))],
          [new Date(iso(day, 4)), null],
        ],
      );
      const stored = await status(trip.id);
      expect(stored.plannedDepartureAt).toEqual(timings[0]?.plannedDepartureAt);
      expect(stored.plannedArrivalAt).toEqual(timings[2]?.plannedArrivalAt);
    });

    it('scheduling and a timetable replacement: one consistent state wins', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { trip, version } = await draftWithTimetable();
        const [schedule, replace] = await Promise.all([
          adminApi(admin).post(`/trips/${trip.id}/schedule`, {}),
          adminApi(dispatcher).post(
            `/trips/${trip.id}/timetable`,
            timetable(version.waypoints, 30),
          ),
        ]);
        expect(schedule.status).toBe(200);
        expect([200, 409]).toContain(replace.status);
        const stored = await status(trip.id);
        const timings = await db(t.app).tripWaypointTiming.findMany({
          where: { tripId: trip.id },
          orderBy: { sequence: 'asc' },
        });
        expect(stored.status).toBe('SCHEDULED');
        // The scheduled timetable is exactly the one in force when scheduling:
        // the replacement if it committed first, the original otherwise.
        const day = replace.status === 200 ? 30 : 0;
        expect(
          timings.map((timing) => [timing.plannedArrivalAt, timing.plannedDepartureAt]),
        ).toEqual([
          [null, new Date(iso(day, 0))],
          [new Date(iso(day, 2)), new Date(iso(day, 2.25))],
          [new Date(iso(day, 4)), null],
        ]);
        expect(stored.plannedDepartureAt).toEqual(timings[0]?.plannedDepartureAt);
      }
    });

    it('scheduling and cancelling concurrently ends CANCELLED with a valid history', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { trip } = await draftWithTimetable();
        const [schedule, cancel] = await Promise.all([
          adminApi(admin).post(`/trips/${trip.id}/schedule`, {}),
          adminApi(dispatcher).post(`/trips/${trip.id}/cancel`, { reason: 'Course concurrente' }),
        ]);
        expect(cancel.status).toBe(200);
        expect([200, 409]).toContain(schedule.status);
        const stored = await status(trip.id);
        expect(stored.status).toBe('CANCELLED');
        expect(stored.scheduledAt !== null).toBe(schedule.status === 200);
        const actions = (
          await db(t.app).auditEvent.findMany({
            where: { resourceId: trip.id, action: { in: ['TRIP_SCHEDULED', 'TRIP_CANCELLED'] } },
            orderBy: { occurredAt: 'asc' },
          })
        ).map((event) => event.action);
        expect(actions).toEqual(
          schedule.status === 200 ? ['TRIP_SCHEDULED', 'TRIP_CANCELLED'] : ['TRIP_CANCELLED'],
        );
      }
    });

    it('two concurrent vehicle assignments decided on the same state: exactly one applies', async () => {
      const [a, b] = [await vehicle('ACTIVE'), await vehicle('ACTIVE')];
      const { trip } = await draftWithTimetable();
      const results = await Promise.all([
        adminApi(admin).post(`/trips/${trip.id}/vehicle`, {
          vehicleId: a.id,
          expectedVehicleId: null,
        }),
        adminApi(dispatcher).post(`/trips/${trip.id}/vehicle`, {
          vehicleId: b.id,
          expectedVehicleId: null,
        }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = results.find((response) => response.status === 200)?.body.vehicle.id;
      expect((await status(trip.id)).vehicleId).toBe(winner);
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: trip.id, action: 'TRIP_VEHICLE_CHANGED' },
        }),
      ).toBe(1);
    });

    it('an assignment racing a fleet status change is serialized (no deadlock)', async () => {
      for (let round = 0; round < 3; round += 1) {
        const bus = await vehicle('ACTIVE');
        const { trip } = await draftWithTimetable();
        const [assign, fleet] = await Promise.all([
          adminApi(admin).post(`/trips/${trip.id}/vehicle`, { vehicleId: bus.id }),
          adminApi(admin).post(`/fleet/vehicles/${bus.id}/status`, {
            status: 'OUT_OF_SERVICE',
            reason: 'Panne concurrente',
          }),
        ]);
        expect(fleet.status).toBe(200);
        // Either the assignment saw an ACTIVE vehicle first, or it was refused.
        expect([200, 422]).toContain(assign.status);
        expect((await status(trip.id)).vehicleId).toBe(assign.status === 200 ? bus.id : null);
      }
    });
  });

  describe('listing', () => {
    it('paginates with a bounded keyset cursor and filters by status, route and departure', async () => {
      const api = adminApi(admin);
      const { trip, version } = await draftWithTimetable(40);
      await api.post(`/trips/${trip.id}/schedule`, {});
      const sibling = await api.post('/trips', {
        reference: reference(),
        routeVersionId: version.versionId,
      });
      expect(sibling.status).toBe(201);

      const byVersion = await api.get(`/trips?routeVersionId=${version.versionId}`);
      expect(byVersion.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [trip.id, sibling.body.id].sort(),
      );
      const byRoute = await api.get(`/trips?routeId=${version.routeId}&status=SCHEDULED`);
      expect(byRoute.body.items.map((item: { id: string }) => item.id)).toEqual([trip.id]);
      const window = await api.get(
        `/trips?departureFrom=${encodeURIComponent(iso(40, -1))}&departureTo=${encodeURIComponent(iso(40, 1))}`,
      );
      expect(window.body.items.map((item: { id: string }) => item.id)).toEqual([trip.id]);

      const first = await api.get('/trips?limit=2');
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBe(first.body.items[1].id);
      const second = await api.get(`/trips?limit=2&cursor=${first.body.nextCursor}`);
      for (const item of second.body.items as Array<{ id: string }>) {
        expect(item.id < first.body.nextCursor).toBe(true);
      }
      expect((await api.get('/trips?limit=101')).status).toBe(400);
      expect((await api.get('/trips?status=IN_PROGRESS')).status).toBe(200);
      expect((await api.get('/trips?status=COMPLETED')).status).toBe(200);
      expect((await api.get('/trips?status=DEPARTED')).status).toBe(400);
      expect((await api.get('/trips?departureFrom=2030-01-01')).status).toBe(400);
      expect((await api.get(`/trips/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });
});
