import { randomBytes } from 'node:crypto';
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
const at = (hours: number) => new Date(Date.UTC(2030, 0, 20, 8) + hours * HOUR).toISOString();

describe('CONVOY-1 support vehicle assignment (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let admin: StaffActor;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
    countryId = (
      await db(t.app).country.create({
        data: { iso2: 'CV', iso3: 'CNV', name: 'Pays convoi' },
      })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const api = () => adminApi(admin);
  const suffix = () => randomBytes(4).toString('hex').toUpperCase();

  async function routeVersion() {
    const route = await db(t.app).route.create({
      data: { code: `CV_${suffix()}`, name: 'Route convoi' },
    });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    const origin = await db(t.app).stop.create({
      data: {
        code: `CVO_${suffix()}`,
        name: 'Origine',
        countryId,
        locality: 'Origine',
        latitude: 10,
        longitude: 10,
        timezone: 'Etc/UTC',
      },
    });
    const destination = await db(t.app).stop.create({
      data: {
        code: `CVD_${suffix()}`,
        name: 'Destination',
        countryId,
        locality: 'Destination',
        latitude: 11,
        longitude: 11,
        timezone: 'Etc/UTC',
      },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        {
          routeVersionId: version.id,
          sequence: 1,
          stopId: origin.id,
          boardingAllowed: true,
        },
        {
          routeVersionId: version.id,
          sequence: 2,
          stopId: destination.id,
          alightingAllowed: true,
        },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(Date.now() - 1000) },
    });
    const waypoints = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: version.id },
      orderBy: { sequence: 'asc' },
      select: { id: true },
    });
    return { id: version.id, waypoints };
  }

  async function vehicle(
    role: 'PASSENGER_COACH' | 'CARGO_SUPPORT',
    capacity = role === 'CARGO_SUPPORT',
    activate = true,
  ) {
    const created = await api().post('/fleet/vehicles', {
      code: `CV_${suffix()}`,
      manufacturer: 'Mercedes',
      model: role === 'CARGO_SUPPORT' ? 'Sprinter' : 'Tourismo',
      role,
      ...(capacity ? { payloadCapacityKg: 1200, cargoVolumeLiters: 20000 } : {}),
    });
    expect(created.status, created.text).toBe(201);
    if (activate) {
      const activated = await api().post(`/fleet/vehicles/${created.body.id}/status`, {
        status: 'ACTIVE',
        reason: 'Mise en service convoi',
      });
      expect(activated.status, activated.text).toBe(200);
    }
    return created.body as { id: string; code: string };
  }

  async function draftTrip(primaryVehicleId: string | null, start = 0) {
    const version = await routeVersion();
    const created = await api().post('/trips', {
      reference: `ET-CONVOY-${suffix()}`,
      routeVersionId: version.id,
      vehicleId: primaryVehicleId,
    });
    expect(created.status, created.text).toBe(201);
    const timetable = await api().post(`/trips/${created.body.id}/timetable`, {
      timings: [
        {
          routeWaypointId: version.waypoints[0]!.id,
          plannedArrivalAt: null,
          plannedDepartureAt: at(start),
        },
        {
          routeWaypointId: version.waypoints[1]!.id,
          plannedArrivalAt: at(start + 4),
          plannedDepartureAt: null,
        },
      ],
    });
    expect(timetable.status, timetable.text).toBe(200);
    return created.body as { id: string; reference: string };
  }

  it('validates support role/capacity, optimistic concurrency and lifecycle', async () => {
    const primary = await vehicle('PASSENGER_COACH');
    const support = await vehicle('CARGO_SUPPORT');
    const passengerVehicle = await vehicle('PASSENGER_COACH');
    const trip = await draftTrip(primary.id);

    const wrongRole = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: passengerVehicle.id,
    });
    expect(wrongRole.status).toBe(422);
    expect(wrongRole.body.code).toBe('TRIP_SUPPORT_VEHICLE_ROLE_INVALID');

    const sameAsPrimary = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: primary.id,
    });
    expect(sameAsPrimary.status).toBe(422);
    expect(sameAsPrimary.body.code).toBe('TRIP_SUPPORT_VEHICLE_SAME_AS_PRIMARY');

    const withoutCapacity = await vehicle('CARGO_SUPPORT', false);
    const missingCapacity = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: withoutCapacity.id,
    });
    expect(missingCapacity.status).toBe(422);
    expect(missingCapacity.body.code).toBe('TRIP_SUPPORT_VEHICLE_CAPACITY_MISSING');

    const inactiveSupport = await vehicle('CARGO_SUPPORT', true, false);
    const inactive = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: inactiveSupport.id,
    });
    expect(inactive.status).toBe(422);
    expect(inactive.body.code).toBe('TRIP_VEHICLE_UNAVAILABLE');

    const assigned = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: support.id,
      expectedSupportVehicleId: null,
    });
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body).toMatchObject({
      supportVehicleId: support.id,
      supportVehicle: {
        id: support.id,
        code: support.code,
        role: 'CARGO_SUPPORT',
        payloadCapacityKg: 1200,
        cargoVolumeLiters: 20000,
      },
    });

    const conflict = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: null,
      expectedSupportVehicleId: primary.id,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('TRIP_SUPPORT_VEHICLE_CONFLICT');

    expect((await api().post(`/trips/${trip.id}/schedule`, {})).status).toBe(200);

    const withoutReason = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: null,
    });
    expect(withoutReason.status).toBe(422);
    expect(withoutReason.body.code).toBe('TRIP_REASON_REQUIRED');

    const removed = await api().post(`/trips/${trip.id}/support-vehicle`, {
      supportVehicleId: null,
      expectedSupportVehicleId: support.id,
      reason: 'Fourgon non nécessaire',
    });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.body.supportVehicle).toBeNull();

    expect(
      await db(t.app).auditEvent.count({
        where: { resourceId: trip.id, action: 'TRIP_SUPPORT_VEHICLE_CHANGED' },
      }),
    ).toBe(2);
  });

  it('prevents overlapping use of one support vehicle and allows back-to-back use', async () => {
    const primaryA = await vehicle('PASSENGER_COACH');
    const primaryB = await vehicle('PASSENGER_COACH');
    const primaryC = await vehicle('PASSENGER_COACH');
    const support = await vehicle('CARGO_SUPPORT');

    const first = await draftTrip(primaryA.id, 0);
    expect(
      (
        await api().post(`/trips/${first.id}/support-vehicle`, {
          supportVehicleId: support.id,
        })
      ).status,
    ).toBe(200);
    expect((await api().post(`/trips/${first.id}/schedule`, {})).status).toBe(200);

    const overlap = await draftTrip(primaryB.id, 2);
    expect(
      (
        await api().post(`/trips/${overlap.id}/support-vehicle`, {
          supportVehicleId: support.id,
        })
      ).status,
    ).toBe(200);
    const refused = await api().post(`/trips/${overlap.id}/schedule`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TRIP_VEHICLE_OVERLAP');
    expect(refused.body.details).toEqual({ conflictingTripReference: first.reference });

    const backToBack = await draftTrip(primaryC.id, 4);
    expect(
      (
        await api().post(`/trips/${backToBack.id}/support-vehicle`, {
          supportVehicleId: support.id,
        })
      ).status,
    ).toBe(200);
    expect((await api().post(`/trips/${backToBack.id}/schedule`, {})).status).toBe(200);
  });

  it('rejects CARGO_SUPPORT as the primary passenger vehicle', async () => {
    const support = await vehicle('CARGO_SUPPORT');
    const version = await routeVersion();
    const created = await api().post('/trips', {
      reference: `ET-CONVOY-${suffix()}`,
      routeVersionId: version.id,
      vehicleId: support.id,
    });
    expect(created.status).toBe(422);
    expect(created.body.code).toBe('TRIP_PRIMARY_VEHICLE_ROLE_INVALID');
  });
});
