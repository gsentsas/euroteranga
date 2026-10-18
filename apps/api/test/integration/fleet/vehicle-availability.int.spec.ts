import { randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const HOUR = 3_600_000;
/** Synthetic base date: 2030-01-15 08:00 UTC, shifted by days and hours. */
const at = (day: number, hours: number) =>
  new Date(Date.UTC(2030, 0, 15 + day, 8) + hours * HOUR).toISOString();

interface Waypoint {
  id: string;
  sequence: number;
}

/**
 * FLEET-1: operational vehicle names, and a vehicle never serving two trips
 * whose planned windows overlap (API and PostgreSQL). Own database: one test
 * temporarily disables the trigger to build a legacy overlap.
 */
describe('vehicle names and availability across trips (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QA', iso3: 'QAV', name: 'Pays dispo' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();
  const api = () => adminApi(admin);

  async function routeVersion() {
    const place = (code: string) =>
      db(t.app).stop.create({
        data: {
          code,
          name: `Arrêt ${code}`,
          countryId,
          locality: 'Localité',
          latitude: 10,
          longitude: 10,
          timezone: 'Etc/UTC',
        },
      });
    const [a, b] = [await place(`S_${suffix()}`), await place(`S_${suffix()}`)];
    const route = await db(t.app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: a.id, boardingAllowed: true },
        { routeVersionId: version.id, sequence: 2, stopId: b.id, alightingAllowed: true },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(Date.now() - 1000) },
    });
    const waypoints: Waypoint[] = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: version.id },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true },
    });
    return { versionId: version.id, waypoints };
  }

  async function activeVehicle() {
    const created = await api().post('/fleet/vehicles', {
      code: `VH_${suffix()}`,
      manufacturer: 'Constructeur synthétique',
      model: 'Modèle synthétique',
    });
    expect(created.status).toBe(201);
    const activated = await api().post(`/fleet/vehicles/${created.body.id}/status`, {
      status: 'ACTIVE',
      reason: 'Mise en service de test',
    });
    expect(activated.status).toBe(200);
    return created.body as { id: string; code: string };
  }

  /** A DRAFT trip with a timetable from `start` to `start + 4h` (hours from the base date). */
  async function draftTrip(vehicleId: string | null, start: number) {
    const version = await routeVersion();
    const created = await api().post('/trips', {
      reference: `ET-TEST-2030-${suffix()}`,
      routeVersionId: version.versionId,
      vehicleId,
    });
    expect(created.status, created.text).toBe(201);
    const timetable = await api().post(`/trips/${created.body.id}/timetable`, {
      timings: [
        {
          routeWaypointId: version.waypoints[0]!.id,
          plannedArrivalAt: null,
          plannedDepartureAt: at(0, start),
        },
        {
          routeWaypointId: version.waypoints[1]!.id,
          plannedArrivalAt: at(0, start + 4),
          plannedDepartureAt: null,
        },
      ],
    });
    expect(timetable.status, timetable.text).toBe(200);
    return created.body as { id: string; reference: string };
  }

  const schedule = (id: string) => api().post(`/trips/${id}/schedule`, {});
  const tripStatus = async (id: string) =>
    (await db(t.app).trip.findUniqueOrThrow({ where: { id } })).status;

  describe('operational vehicle name', () => {
    it('stores a normalized optional name, shows it on trips and keeps it unique', async () => {
      const name = `Teranga ${suffix()}`;
      const created = await api().post('/fleet/vehicles', {
        code: `VH_${suffix()}`,
        name: `  ${name.replace(' ', '   ')} `,
        manufacturer: 'Constructeur synthétique',
        model: 'Modèle synthétique',
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe(name);

      const duplicate = await api().post('/fleet/vehicles', {
        code: `VH_${suffix()}`,
        name,
        manufacturer: 'Constructeur synthétique',
        model: 'Modèle synthétique',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('VEHICLE_IDENTIFIER_CONFLICT');

      for (const invalid of ['', '   ', 'x'.repeat(81)]) {
        const response = await api().post(`/fleet/vehicles/${created.body.id}`, { name: invalid });
        expect(response.status, JSON.stringify(invalid)).toBe(400);
      }
      const renamed = await api().post(`/fleet/vehicles/${created.body.id}`, {
        name: `${name} bis`,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe(`${name} bis`);
      const cleared = await api().post(`/fleet/vehicles/${created.body.id}`, { name: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.name).toBeNull();

      const audit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: created.body.id, action: 'VEHICLE_CREATED' },
      });
      expect(audit.after).toMatchObject({ name });

      await api().post(`/fleet/vehicles/${created.body.id}`, { name });
      await api().post(`/fleet/vehicles/${created.body.id}/status`, {
        status: 'ACTIVE',
        reason: 'Mise en service de test',
      });
      const trip = await draftTrip(created.body.id, 0);
      const detail = await api().get(`/trips/${trip.id}`);
      expect(detail.body.vehicle).toMatchObject({ code: created.body.code, name });
    });

    it('rejects a blank or untrimmed name in PostgreSQL as well', async () => {
      const vehicle = await activeVehicle();
      for (const name of ['', ' Teranga', 'Teranga ']) {
        await expect(
          db(t.app).vehicle.update({ where: { id: vehicle.id }, data: { name } }),
        ).rejects.toThrow();
      }
    });
  });

  describe('vehicle availability', () => {
    it('refuses to schedule an overlapping trip and accepts back-to-back trips', async () => {
      const vehicle = await activeVehicle();
      const first = await draftTrip(vehicle.id, 0);
      expect((await schedule(first.id)).status).toBe(200);

      const overlapping = await draftTrip(vehicle.id, 2);
      const refused = await schedule(overlapping.id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('TRIP_VEHICLE_OVERLAP');
      expect(refused.body.details).toEqual({ conflictingTripReference: first.reference });
      expect(refused.body.message).toContain(first.reference);
      expect(await tripStatus(overlapping.id)).toBe('DRAFT');
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: overlapping.id, action: 'TRIP_SCHEDULED' },
        }),
      ).toBe(0);

      const contained = await draftTrip(vehicle.id, 1);
      expect((await schedule(contained.id)).body.code).toBe('TRIP_VEHICLE_OVERLAP');

      const backToBack = await draftTrip(vehicle.id, 4);
      expect((await schedule(backToBack.id)).status).toBe(200);
      const before = await draftTrip(vehicle.id, -4);
      expect((await schedule(before.id)).status).toBe(200);

      const otherVehicle = await activeVehicle();
      const elsewhere = await draftTrip(otherVehicle.id, 2);
      expect((await schedule(elsewhere.id)).status).toBe(200);
      const withoutVehicle = await draftTrip(null, 2);
      expect((await schedule(withoutVehicle.id)).status).toBe(200);
    });

    it('frees the vehicle when the conflicting trip is cancelled', async () => {
      const vehicle = await activeVehicle();
      const first = await draftTrip(vehicle.id, 0);
      expect((await schedule(first.id)).status).toBe(200);
      const second = await draftTrip(vehicle.id, 1);
      expect((await schedule(second.id)).status).toBe(409);

      const cancelled = await api().post(`/trips/${first.id}/cancel`, {
        reason: 'Annulation de test',
      });
      expect(cancelled.status).toBe(200);
      expect((await schedule(second.id)).status).toBe(200);
    });

    it('refuses an overlapping vehicle on a SCHEDULED trip but lets a DRAFT trip carry it', async () => {
      const vehicle = await activeVehicle();
      const first = await draftTrip(vehicle.id, 0);
      expect((await schedule(first.id)).status).toBe(200);

      const scheduled = await draftTrip(null, 2);
      expect((await schedule(scheduled.id)).status).toBe(200);
      const refused = await api().post(`/trips/${scheduled.id}/vehicle`, {
        vehicleId: vehicle.id,
        reason: 'Changement de test',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('TRIP_VEHICLE_OVERLAP');
      expect(
        (await db(t.app).trip.findUniqueOrThrow({ where: { id: scheduled.id } })).vehicleId,
      ).toBeNull();

      const later = await draftTrip(null, 6);
      expect((await schedule(later.id)).status).toBe(200);
      const accepted = await api().post(`/trips/${later.id}/vehicle`, {
        vehicleId: vehicle.id,
        reason: 'Changement de test',
      });
      expect(accepted.status).toBe(200);

      const draft = await draftTrip(null, 1);
      const draftAssignment = await api().post(`/trips/${draft.id}/vehicle`, {
        vehicleId: vehicle.id,
      });
      expect(draftAssignment.status).toBe(200);
      expect((await schedule(draft.id)).body.code).toBe('TRIP_VEHICLE_OVERLAP');
    });

    it('two overlapping trips scheduled concurrently: exactly one is scheduled', async () => {
      const vehicle = await activeVehicle();
      const left = await draftTrip(vehicle.id, 0);
      const right = await draftTrip(vehicle.id, 1);

      // Hold the per-vehicle availability lock so that both requests queue on it.
      const gate = createDatabaseClient({ databaseUrl: database.url });
      let pending: Array<Promise<{ status: number }>> = [];
      try {
        await gate.$transaction(
          async (tx) => {
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(hashtextextended(${'trip-vehicle:' + vehicle.id}, 0))
            `;
            pending = [schedule(left.id), schedule(right.id)];
            const deadline = Date.now() + 15_000;
            for (;;) {
              const rows = await tx.$queryRaw<Array<{ waiting: bigint }>>`
                SELECT count(*) AS waiting FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock' AND wait_event = 'advisory'
              `;
              if (Number(rows[0]?.waiting ?? 0) >= 2) break;
              if (Date.now() > deadline) throw new Error('requests never queued on the lock');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          },
          { timeout: 30_000 },
        );
      } finally {
        await gate.$disconnect();
      }
      const responses = await Promise.all(pending);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const statuses = [await tripStatus(left.id), await tripStatus(right.id)].sort();
      expect(statuses).toEqual(['DRAFT', 'SCHEDULED']);
    });

    it('PostgreSQL refuses an overlap written around the API and ignores legacy overlaps', async () => {
      const vehicle = await activeVehicle();
      const first = await draftTrip(vehicle.id, 0);
      expect((await schedule(first.id)).status).toBe(200);
      const second = await draftTrip(vehicle.id, 2);

      await expect(
        db(t.app).trip.update({
          where: { id: second.id },
          data: {
            status: 'SCHEDULED',
            scheduledAt: new Date(),
            plannedDepartureAt: new Date(at(0, 2)),
            plannedArrivalAt: new Date(at(0, 6)),
          },
        }),
      ).rejects.toThrow(/overlapping trip/);
      expect(await tripStatus(second.id)).toBe('DRAFT');

      // A legacy overlap (written before FLEET-1) never blocks unrelated updates.
      await db(t.app).$executeRawUnsafe(
        'ALTER TABLE "trip" DISABLE TRIGGER "trip_vehicle_availability_guard"',
      );
      try {
        await db(t.app).trip.update({
          where: { id: second.id },
          data: {
            status: 'SCHEDULED',
            scheduledAt: new Date(),
            plannedDepartureAt: new Date(at(0, 2)),
            plannedArrivalAt: new Date(at(0, 6)),
          },
        });
      } finally {
        await db(t.app).$executeRawUnsafe(
          'ALTER TABLE "trip" ENABLE TRIGGER "trip_vehicle_availability_guard"',
        );
      }
      await expect(
        db(t.app).trip.update({ where: { id: second.id }, data: { updatedAt: new Date() } }),
      ).resolves.toMatchObject({ status: 'SCHEDULED' });
    });
  });
});
