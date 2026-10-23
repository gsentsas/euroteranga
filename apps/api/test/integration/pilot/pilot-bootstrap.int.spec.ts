import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../src/authorization/audit.service.js';
import { vehicleCreateSchema, vehicleUpdateSchema } from '../../../src/fleet/fleet.dto.js';
import { FleetService } from '../../../src/fleet/fleet.service.js';
import { vehicleIdentifierCollision } from '../../../src/fleet/vehicle-identifiers.js';
import { NetworkService } from '../../../src/network/network.service.js';
import {
  PILOT_ACTOR,
  PILOT_OPERATOR_EMAIL,
  PilotBootstrap,
  type PilotBootstrapOptions,
  type PilotBootstrapReport,
} from '../../../src/pilot/pilot-bootstrap.js';
import { PILOT_VEHICLES, type PilotVehicle } from '../../../src/pilot/pilot-dataset.js';
import { PricingService } from '../../../src/pricing/pricing.service.js';
import { SeatMapService } from '../../../src/seat-maps/seat-map.service.js';
import { TrackingService } from '../../../src/tracking/tracking.service.js';
import { TripService } from '../../../src/trips/trip.service.js';
import {
  adminApi,
  isolatedDatabase,
  operatorVehicle,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { bookingApi, customerActor } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const today = () => new Date().toISOString().slice(0, 10);
const options = (overrides: Partial<PilotBootstrapOptions> = {}): PilotBootstrapOptions => ({
  anchorDate: today(),
  tripsPerDirection: 4,
  dryRun: false,
  ...overrides,
});

interface Harness {
  t: TestApp;
  drop: () => Promise<void>;
  run: (overrides?: Partial<PilotBootstrapOptions>) => Promise<PilotBootstrapReport>;
}

async function harness(): Promise<Harness> {
  const database = await isolatedDatabase();
  const t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  const run = (overrides: Partial<PilotBootstrapOptions> = {}) =>
    new PilotBootstrap({
      db: db(t.app),
      audit: t.app.get(AuditService),
      network: t.app.get(NetworkService),
      seatMaps: t.app.get(SeatMapService),
      fleet: t.app.get(FleetService),
      pricing: t.app.get(PricingService),
      tracking: t.app.get(TrackingService),
      trips: t.app.get(TripService),
    }).run(options(overrides));
  return {
    t,
    run,
    drop: async () => {
      await t.app.close();
      await database.drop();
    },
  };
}

const outcomes = (report: PilotBootstrapReport) => [...new Set(report.lines.map((l) => l.outcome))];

/** Row counts of every table the bootstrap may write, plus the audit trail. */
async function snapshot(h: Harness) {
  const client = db(h.t.app);
  return {
    countries: await client.country.count(),
    stops: await client.stop.count(),
    checkpoints: await client.checkpoint.count(),
    routes: await client.route.count(),
    routeVersions: await client.routeVersion.count(),
    seatMaps: await client.seatMap.count(),
    seatMapVersions: await client.seatMapVersion.count(),
    vehicles: await client.vehicle.count(),
    fareTables: await client.fareTable.count(),
    fareTableVersions: await client.fareTableVersion.count(),
    trips: await client.trip.count(),
    identities: await client.authIdentity.count(),
    trackingConfigs: await client.tripTrackingConfig.count(),
    audit: await client.auditEvent.count(),
  };
}

describe('pilot data bootstrap: complete dataset (isolated database)', () => {
  let h: Harness;
  let first: PilotBootstrapReport;

  beforeAll(async () => {
    h = await harness();
    first = await h.run();
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('creates the corridor, two coaches, fares and future trips through the domain services', async () => {
    expect(first.hasConflicts).toBe(false);
    expect(outcomes(first)).toEqual(['created']);
    const client = db(h.t.app);

    expect(
      (await client.country.findMany({ orderBy: { iso2: 'asc' } })).map((c) => c.iso2),
    ).toEqual(['ES', 'FR', 'MA', 'MR', 'SN']);
    expect((await client.stop.findMany({ orderBy: { code: 'asc' } })).map((s) => s.code)).toEqual([
      'DKR',
      'PAR',
    ]);
    expect(await client.checkpoint.count()).toBe(5);

    for (const [code, first, last] of [
      ['ET-PAR-DKR', 'PAR', 'DKR'],
      ['ET-DKR-PAR', 'DKR', 'PAR'],
    ] as const) {
      const version = await client.routeVersion.findFirstOrThrow({
        where: { route: { code }, status: 'PUBLISHED' },
        include: {
          waypoints: { orderBy: { sequence: 'asc' }, include: { stop: true, checkpoint: true } },
        },
      });
      expect(version.waypoints).toHaveLength(7);
      expect(version.waypoints[0]).toMatchObject({
        boardingAllowed: true,
        alightingAllowed: false,
      });
      expect(version.waypoints[0]!.stop?.code).toBe(first);
      expect(version.waypoints.at(-1)).toMatchObject({
        boardingAllowed: false,
        alightingAllowed: true,
      });
      expect(version.waypoints.at(-1)!.stop?.code).toBe(last);
      expect(version.waypoints.slice(1, -1).every((w) => w.checkpoint !== null)).toBe(true);
    }

    const seatMap = await client.seatMapVersion.findFirstOrThrow({
      where: { seatMap: { code: 'ET-SM-COACH-53' }, status: 'PUBLISHED' },
      include: { cells: true },
    });
    const kinds = (kind: string) => seatMap.cells.filter((cell) => cell.kind === kind).length;
    expect(kinds('SEAT')).toBe(53);
    expect(kinds('DRIVER')).toBe(1);
    expect(kinds('DOOR')).toBe(2);
    expect(kinds('TOILET')).toBe(1);

    const vehicles = await client.vehicle.findMany({ orderBy: { code: 'asc' } });
    expect(
      vehicles.map((v) => [
        v.code,
        v.name,
        v.status,
        v.registrationPlate,
        v.vin,
        v.seatMapVersionId,
      ]),
    ).toEqual([
      ['ET-COACH-001', 'Teranga Pilote 01', 'ACTIVE', 'DEMO-ET-001', null, seatMap.id],
      ['ET-COACH-002', 'Teranga Pilote 02', 'ACTIVE', 'DEMO-ET-002', null, seatMap.id],
    ]);

    const fares = await client.fareEntry.findMany({
      where: { fareTableVersion: { status: 'PUBLISHED' } },
      include: { fareTableVersion: { include: { fareTable: true } } },
    });
    expect(fares).toHaveLength(2);
    for (const fare of fares) {
      expect(fare.amountMinor).toBe(24_900);
      expect(fare.fareTableVersion.fareTable).toMatchObject({
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
      });
    }

    const trips = await client.trip.findMany({
      orderBy: { plannedDepartureAt: 'asc' },
      include: { vehicle: true, routeVersion: { include: { route: true } } },
    });
    expect(trips).toHaveLength(8);
    for (const trip of trips) {
      expect(trip.status).toBe('SCHEDULED');
      expect(trip.reference).toMatch(/^ET-PILOT-(PARDKR|DKRPAR)-\d{8}$/);
      expect(trip.seatMapVersionId).toBe(seatMap.id);
      expect(trip.fareTableVersionId).not.toBeNull();
      expect(trip.plannedDepartureAt!.getTime()).toBeGreaterThan(Date.now());
    }
    expect(trips.filter((trip) => trip.routeVersion.route.code === 'ET-PAR-DKR')).toHaveLength(4);

    const operator = await client.authIdentity.findUniqueOrThrow({
      where: {
        realm_normalizedEmail: {
          realm: 'STAFF',
          normalizedEmail: PILOT_OPERATOR_EMAIL,
        },
      },
      select: {
        id: true,
        status: true,
        passwordCredential: true,
        mfaTotpCredential: true,
        _count: {
          select: {
            roleAssignments: { where: { revokedAt: null } },
            mfaRecoveryCodes: true,
          },
        },
      },
    });
    expect(operator).toMatchObject({
      status: 'ACTIVE',
      passwordCredential: null,
      mfaTotpCredential: null,
      _count: { roleAssignments: 0, mfaRecoveryCodes: 0 },
    });

    const trackingConfigs = await client.tripTrackingConfig.findMany({
      orderBy: { trip: { reference: 'asc' } },
    });
    expect(trackingConfigs).toHaveLength(8);
    expect(
      trackingConfigs.every(
        (row) =>
          row.enabled &&
          row.visibility === 'CHECKPOINT_ONLY' &&
          row.trackingDeviceId === null &&
          row.createdByIdentityId === operator.id &&
          row.updatedByIdentityId === operator.id,
      ),
    ).toBe(true);

    // Each coach alternates directions and never serves two overlapping trips.
    for (const code of ['ET-COACH-001', 'ET-COACH-002']) {
      const own = trips.filter((trip) => trip.vehicle?.code === code);
      expect(own).toHaveLength(4);
      own.slice(1).forEach((trip, index) => {
        expect(trip.plannedDepartureAt!.getTime()).toBeGreaterThan(
          own[index]!.plannedArrivalAt!.getTime(),
        );
        expect(trip.routeVersion.route.code).not.toBe(own[index]!.routeVersion.route.code);
      });
    }
  });

  it('audits every write with the pilot system actor and no identity', async () => {
    const events = await db(h.t.app).auditEvent.findMany({
      where: {
        resourceType: {
          in: [
            'country',
            'stop',
            'checkpoint',
            'route',
            'route_version',
            'vehicle',
            'trip',
            'auth_identity',
            'trip_tracking_config',
          ],
        },
      },
    });
    expect(events.length).toBeGreaterThan(30);
    for (const event of events) {
      expect(event.actorIdentityId).toBeNull();
      expect(event.sessionId).toBeNull();
      expect(event.metadata).toMatchObject({ systemActor: 'pilot-bootstrap' });
    }
    const statusChange = events.find((event) => event.action === 'VEHICLE_STATUS_CHANGED');
    expect(statusChange?.metadata).toMatchObject({ systemActor: 'pilot-bootstrap' });
  });

  it('is idempotent: a second run reuses everything and writes nothing', async () => {
    const before = await snapshot(h);
    const second = await h.run();
    expect(second.hasConflicts).toBe(false);
    expect(outcomes(second)).toEqual(['existing']);
    expect(await snapshot(h)).toEqual(before);

    // A later run anchored on another date keeps the four upcoming departures.
    const later = await h.run({ anchorDate: '2099-01-01' });
    expect(later.lines.filter((line) => line.entity === 'trip')).toEqual([]);
    expect(await snapshot(h)).toEqual(before);
  });

  it('makes the pilot trips bookable: search, Pricing fares, availability and a customer hold', async () => {
    const http = request(h.t.app.getHttpServer());
    const stops = await http.get('/v1/booking/stops').set('Origin', 'http://localhost:3000');
    const id = (code: string) =>
      (stops.body.items as Array<{ id: string; code: string }>).find((s) => s.code === code)!.id;

    for (const [from, to] of [
      ['PAR', 'DKR'],
      ['DKR', 'PAR'],
    ] as const) {
      const search = await http
        .get(`/v1/booking/trips?originStopId=${id(from)}&destinationStopId=${id(to)}`)
        .set('Origin', 'http://localhost:3000');
      expect(search.status).toBe(200);
      expect(search.body.items).toHaveLength(4);
      for (const item of search.body.items) {
        expect(item.fare).toEqual({
          amountMinor: 24_900,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
        });
        expect(item).toMatchObject({ seatCount: 53, availableSeatCount: 53 });
      }
    }

    const search = await http
      .get(`/v1/booking/trips?originStopId=${id('PAR')}&destinationStopId=${id('DKR')}`)
      .set('Origin', 'http://localhost:3000');
    const journey = search.body.items[0];
    const availability = await http
      .get(
        `/v1/booking/trips/${journey.tripId}/availability?originRouteWaypointId=${journey.origin.routeWaypointId}&destinationRouteWaypointId=${journey.destination.routeWaypointId}`,
      )
      .set('Origin', 'http://localhost:3000');
    expect(availability.status).toBe(200);
    const seat = (availability.body.cells as Array<{ id: string; seatLabel: string | null }>).find(
      (cell) => cell.seatLabel === '1A',
    )!;

    const customer = await customerActor(h.t.app);
    const hold = await bookingApi(customer).post('/bookings', {
      tripId: journey.tripId,
      originRouteWaypointId: journey.origin.routeWaypointId,
      destinationRouteWaypointId: journey.destination.routeWaypointId,
      seatMapCellIds: [seat.id],
    });
    expect(hold.status, hold.text).toBe(201);
  });

  it('refuses to overwrite a pilot tracking configuration changed in OPS', async () => {
    const client = db(h.t.app);
    const trip = await client.trip.findFirstOrThrow({
      where: { reference: { startsWith: 'ET-PILOT-PARDKR-' }, status: 'SCHEDULED' },
      orderBy: { plannedDepartureAt: 'asc' },
      select: { id: true, reference: true },
    });
    const admin = await staffActor(h.t.app, ['OPS_MANAGER']);
    const changed = await adminApi(admin).post(`/tracking/trips/${trip.id}/config`, {
      enabled: true,
      visibility: 'HIDDEN',
      trackingDeviceId: null,
    });
    expect(changed.status, changed.text).toBe(201);

    const before = await client.tripTrackingConfig.findUniqueOrThrow({
      where: { tripId: trip.id },
    });
    expect(before.visibility).toBe('HIDDEN');

    const report = await h.run();
    expect(report.hasConflicts).toBe(true);
    expect(report.lines).toContainEqual(
      expect.objectContaining({
        outcome: 'conflict',
        entity: 'tracking',
        key: trip.reference,
      }),
    );

    const after = await client.tripTrackingConfig.findUniqueOrThrow({
      where: { tripId: trip.id },
    });
    expect(after.visibility).toBe('HIDDEN');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('pilot data bootstrap: dry run, resume and conflicts (isolated databases)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 60_000);

  afterAll(async () => {
    await h.drop();
  });

  it('dry run reports the plan and writes nothing', async () => {
    const before = await snapshot(h);
    const report = await h.run({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(outcomes(report)).toEqual(['planned']);
    expect(report.lines.filter((line) => line.entity === 'trip')).toHaveLength(8);
    expect(await snapshot(h)).toEqual(before);
  });

  it('completes data left half-way and refuses to overwrite operator data', async () => {
    // Half-way state: the pilot coach with every pilot identity field, but
    // still PLANNED and without seat map (the steps the bootstrap performs).
    const country = await adminApi(admin).post('/network/countries', {
      iso2: 'FR',
      iso3: 'FRA',
      name: 'France',
      active: true,
    });
    expect(country.status).toBe(201);
    const coach = await adminApi(admin).post('/fleet/vehicles', {
      code: 'ET-COACH-001',
      name: 'Teranga Pilote 01',
      manufacturer: 'Autocar grand tourisme',
      model: 'Modèle à confirmer',
      registrationPlate: 'DEMO-ET-001',
      registrationCountryId: country.body.id,
    });
    expect(coach.status).toBe(201);
    // Operator data: Dakar -> Paris already exists with another published version.
    const stop = async (code: string, iso2: string) => {
      const countryId =
        iso2 === 'FR'
          ? country.body.id
          : (
              await adminApi(admin).post('/network/countries', {
                iso2,
                iso3: 'SEN',
                name: 'Sénégal',
                active: true,
              })
            ).body.id;
      const response = await adminApi(admin).post('/network/stops', {
        code,
        name: code,
        countryId,
        locality: code,
        latitude: 10,
        longitude: 10,
        timezone: code === 'PAR' ? 'Europe/Paris' : 'Africa/Dakar',
        active: true,
      });
      expect(response.status).toBe(201);
      return response.body.id as string;
    };
    const dakar = await stop('DKR', 'SN');
    const paris = await stop('PAR', 'FR');
    const route = await adminApi(admin).post('/network/routes', {
      code: 'ET-DKR-PAR',
      name: 'Dakar → Paris (opérateur)',
      active: true,
    });
    const version = await adminApi(admin).post(`/network/routes/${route.body.id}/versions`, {});
    await adminApi(admin).post(
      `/network/routes/${route.body.id}/versions/${version.body.id}/waypoints`,
      {
        waypoints: [
          { kind: 'STOP', stopId: dakar, boardingAllowed: true },
          { kind: 'STOP', stopId: paris, alightingAllowed: true },
        ],
      },
    );
    const published = await adminApi(admin).post(
      `/network/routes/${route.body.id}/versions/${version.body.id}/publish`,
      {},
    );
    expect(published.status).toBe(200);
    const operatorWaypoints = await db(h.t.app).routeWaypoint.count({
      where: { routeVersionId: version.body.id },
    });

    const report = await h.run();
    const line = (entity: string, key: string) =>
      report.lines.find((l) => l.entity === entity && l.key === key);
    expect(report.hasConflicts).toBe(true);
    expect(line('vehicle', 'ET-COACH-001')?.outcome).toBe('completed');
    expect(line('country', 'FR')?.outcome).toBe('existing');
    // Operator names and positions of the stops are kept, not rewritten.
    expect(line('stop', 'PAR')).toMatchObject({
      outcome: 'existing',
      detail: 'operator name, locality or position kept',
    });
    expect(line('route', 'ET-PAR-DKR')?.outcome).toBe('created');
    expect(line('route', 'ET-DKR-PAR')).toMatchObject({ outcome: 'conflict' });
    expect(line('fare-table', 'ET-FT-DKR-PAR-EUR')).toMatchObject({
      outcome: 'skipped',
      detail: 'depends on route:ET-DKR-PAR',
    });

    const client = db(h.t.app);
    expect(
      await client.vehicle.findUniqueOrThrow({ where: { code: 'ET-COACH-001' } }),
    ).toMatchObject({ status: 'ACTIVE', name: 'Teranga Pilote 01' });
    // The operator route is untouched and no Dakar -> Paris trip was created.
    expect(await client.routeVersion.count({ where: { routeId: route.body.id } })).toBe(1);
    expect(await client.routeWaypoint.count({ where: { routeVersionId: version.body.id } })).toBe(
      operatorWaypoints,
    );
    expect(
      await client.trip.count({ where: { reference: { startsWith: 'ET-PILOT-DKRPAR-' } } }),
    ).toBe(0);
    expect(
      await client.trip.count({
        where: { reference: { startsWith: 'ET-PILOT-PARDKR-' }, status: 'SCHEDULED' },
      }),
    ).toBe(4);
  });
});

describe('pilot data bootstrap never overwrites operator data (isolated databases)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 60_000);

  afterAll(async () => {
    await h.drop();
  });

  const auditCount = (resourceId: string) =>
    db(h.t.app).auditEvent.count({ where: { resourceId } });

  it('leaves a divergent operator coach and stop untouched and skips what depends on them', async () => {
    const france = await adminApi(admin).post('/network/countries', {
      iso2: 'FR',
      iso3: 'FRA',
      name: 'France',
      active: true,
    });
    // An operator coach that happens to use a pilot code, with its own identity.
    const operatorCoach = await adminApi(admin).post('/fleet/vehicles', {
      code: 'ET-COACH-001',
      name: 'Car exploitant',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
      modelYear: 2021,
      registrationPlate: 'OP-001-ET',
      registrationCountryId: france.body.id,
    });
    expect(operatorCoach.status).toBe(201);
    const coachBefore = await db(h.t.app).vehicle.findUniqueOrThrow({
      where: { id: operatorCoach.body.id },
    });
    const coachAuditBefore = await auditCount(operatorCoach.body.id);

    const first = await h.run();
    const line = (entity: string, key: string) =>
      first.lines.find((l) => l.entity === entity && l.key === key);
    expect(first.hasConflicts).toBe(true);
    expect(line('vehicle', 'ET-COACH-001')).toMatchObject({
      outcome: 'conflict',
      detail: 'existing name differs from the pilot coach',
    });
    expect(line('vehicle', 'ET-COACH-002')?.outcome).toBe('created');
    // Departures of the refused coach are skipped; the other coach still serves its own.
    const tripLines = first.lines.filter((l) => l.entity === 'trip');
    expect(tripLines.filter((l) => l.outcome === 'created')).toHaveLength(4);
    expect(
      tripLines.filter(
        (l) => l.outcome === 'skipped' && l.detail === 'depends on vehicle:ET-COACH-001',
      ),
    ).toHaveLength(4);

    expect(
      await db(h.t.app).vehicle.findUniqueOrThrow({ where: { id: operatorCoach.body.id } }),
    ).toEqual(coachBefore);
    expect(await auditCount(operatorCoach.body.id)).toBe(coachAuditBefore);
    expect(await db(h.t.app).trip.count({ where: { vehicleId: operatorCoach.body.id } })).toBe(0);

    // A second run gives the same answer and still writes nothing on the operator coach.
    const second = await h.run();
    expect(second.hasConflicts).toBe(true);
    expect(
      await db(h.t.app).vehicle.findUniqueOrThrow({ where: { id: operatorCoach.body.id } }),
    ).toEqual(coachBefore);
  });

  it('refuses an upcoming pilot trip changed in OPS and adds nothing next to it', async () => {
    const client = db(h.t.app);
    const trip = await client.trip.findFirstOrThrow({
      where: { reference: { startsWith: 'ET-PILOT-PARDKR-' }, status: 'SCHEDULED' },
      orderBy: { plannedDepartureAt: 'asc' },
    });
    // OPS moves the trip to another coach configured with the same seat map.
    const seatMapVersionId = trip.seatMapVersionId!;
    const replacement = await adminApi(admin).post('/fleet/vehicles', {
      code: 'VH-EXPLOITANT',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
    });
    await adminApi(admin).post(`/fleet/vehicles/${replacement.body.id}/seat-map`, {
      seatMapVersionId,
    });
    await adminApi(admin).post(`/fleet/vehicles/${replacement.body.id}/status`, {
      status: 'ACTIVE',
      reason: 'Mise en service exploitant',
    });
    const moved = await adminApi(admin).post(`/trips/${trip.id}/vehicle`, {
      vehicleId: replacement.body.id,
      reason: 'Changement de car par l’exploitation',
    });
    expect(moved.status, moved.text).toBe(200);

    const tripBefore = await client.trip.findUniqueOrThrow({
      where: { id: trip.id },
      include: { timings: { orderBy: { sequence: 'asc' } } },
    });
    const outboundBefore = await client.trip.count({
      where: { reference: { startsWith: 'ET-PILOT-PARDKR-' } },
    });

    const report = await h.run();
    expect(report.hasConflicts).toBe(true);
    expect(report.lines).toContainEqual({
      outcome: 'conflict',
      entity: 'trip',
      key: trip.reference,
      detail: 'is not served by a pilot coach',
    });
    expect(report.lines).toContainEqual({
      outcome: 'skipped',
      entity: 'trips',
      key: 'ET-PAR-DKR',
      detail: 'depends on the conflicting pilot trips',
    });
    expect(
      await client.trip.findUniqueOrThrow({
        where: { id: trip.id },
        include: { timings: { orderBy: { sequence: 'asc' } } },
      }),
    ).toEqual(tripBefore);
    expect(
      await client.trip.count({ where: { reference: { startsWith: 'ET-PILOT-PARDKR-' } } }),
    ).toBe(outboundBefore);
  });

  it('refuses a stop whose time zone differs and builds no route on it', async () => {
    const other = await harness();
    try {
      const otherAdmin = await staffActor(other.t.app, ['SUPER_ADMIN']);
      const france = await adminApi(otherAdmin).post('/network/countries', {
        iso2: 'FR',
        iso3: 'FRA',
        name: 'France',
        active: true,
      });
      const paris = await adminApi(otherAdmin).post('/network/stops', {
        code: 'PAR',
        name: 'Paris Bercy',
        countryId: france.body.id,
        locality: 'Paris',
        latitude: 48.8399,
        longitude: 2.3828,
        timezone: 'Europe/London',
        active: true,
      });
      expect(paris.status).toBe(201);
      const stopBefore = await db(other.t.app).stop.findUniqueOrThrow({
        where: { id: paris.body.id },
      });

      const report = await other.run();
      const line = (entity: string, key: string) =>
        report.lines.find((l) => l.entity === entity && l.key === key);
      expect(line('stop', 'PAR')).toMatchObject({
        outcome: 'conflict',
        detail: 'time zone is Europe/London, expected Europe/Paris',
      });
      expect(line('route', 'ET-PAR-DKR')).toMatchObject({
        outcome: 'skipped',
        detail: 'depends on stop:PAR',
      });
      expect(line('route', 'ET-DKR-PAR')).toMatchObject({
        outcome: 'skipped',
        detail: 'depends on stop:PAR',
      });
      expect(await db(other.t.app).route.count()).toBe(0);
      expect(await db(other.t.app).trip.count()).toBe(0);
      expect(
        await db(other.t.app).stop.findUniqueOrThrow({ where: { id: paris.body.id } }),
      ).toEqual(stopBefore);
    } finally {
      await other.drop();
    }
  }, 60_000);
});

const france = async (admin: StaffActor) => {
  const response = await adminApi(admin).post('/network/countries', {
    iso2: 'FR',
    iso3: 'FRA',
    name: 'France',
    active: true,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
};

const vehicleLines = (report: PilotBootstrapReport) =>
  report.lines
    .filter((line) => line.entity === 'vehicle')
    .map(({ key, outcome, detail }) => ({ key, outcome, detail }));

describe('pilot data bootstrap keeps the historical operator fleet (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 60_000);

  afterAll(async () => {
    await h.drop();
  });

  it('creates Teranga Pilote 01 and 02 next to the retired operator Teranga 01 and 02, untouched', async () => {
    // The production incident: two coaches created, run and retired in OPS
    // hold the names pilot-corridor/2 gave the pilot coaches.
    const fr = await france(admin);
    const historical = [
      await operatorVehicle(
        admin,
        {
          code: 'ET-BUS-001',
          name: 'Teranga 01',
          manufacturer: 'MAN',
          model: 'Lion’s Coach L',
          registrationPlate: 'XX-234-YM',
          registrationCountryId: fr,
          amenities: ['WIFI', 'TOILET'],
        },
        ['ACTIVE', 'RETIRED'],
      ),
      await operatorVehicle(
        admin,
        {
          code: 'ET-BUS-002',
          name: 'Teranga 02',
          manufacturer: 'Mercedes-Benz',
          model: 'Tourismo M/3',
          registrationPlate: 'YY-123-SD',
          registrationCountryId: fr,
        },
        ['ACTIVE', 'RETIRED'],
      ),
    ];
    const client = db(h.t.app);
    const fleetState = () =>
      client.vehicle.findMany({ where: { id: { in: historical } }, orderBy: { code: 'asc' } });
    const fleetAudit = () =>
      client.auditEvent.findMany({
        where: { resourceId: { in: historical } },
        orderBy: { id: 'asc' },
      });
    const before = await fleetState();
    const auditBefore = await fleetAudit();
    expect(before.map((vehicle) => [vehicle.code, vehicle.name, vehicle.status])).toEqual([
      ['ET-BUS-001', 'Teranga 01', 'RETIRED'],
      ['ET-BUS-002', 'Teranga 02', 'RETIRED'],
    ]);

    // The dry run plans exactly what the write then creates.
    const dry = await h.run({ dryRun: true });
    expect(dry.hasConflicts).toBe(false);
    expect(vehicleLines(dry)).toEqual([
      { key: 'ET-COACH-001', outcome: 'planned', detail: undefined },
      { key: 'ET-COACH-002', outcome: 'planned', detail: undefined },
    ]);
    expect(
      dry.lines.filter((line) => line.entity === 'trip' && line.outcome === 'planned'),
    ).toHaveLength(8);

    const applied = await h.run();
    expect(applied.hasConflicts).toBe(false);
    expect(vehicleLines(applied)).toEqual([
      { key: 'ET-COACH-001', outcome: 'created', detail: undefined },
      { key: 'ET-COACH-002', outcome: 'created', detail: undefined },
    ]);
    const coaches = await client.vehicle.findMany({
      where: { code: { startsWith: 'ET-COACH-' } },
      orderBy: { code: 'asc' },
      include: { registrationCountry: true },
    });
    expect(
      coaches.map((coach) => [
        coach.code,
        coach.name,
        coach.manufacturer,
        coach.model,
        coach.modelYear,
        coach.vin,
        coach.registrationPlate,
        coach.registrationCountry?.iso2,
        coach.status,
      ]),
    ).toEqual([
      [
        'ET-COACH-001',
        'Teranga Pilote 01',
        'Autocar grand tourisme',
        'Modèle à confirmer',
        null,
        null,
        'DEMO-ET-001',
        'FR',
        'ACTIVE',
      ],
      [
        'ET-COACH-002',
        'Teranga Pilote 02',
        'Autocar grand tourisme',
        'Modèle à confirmer',
        null,
        null,
        'DEMO-ET-002',
        'FR',
        'ACTIVE',
      ],
    ]);
    const trips = await client.trip.findMany({ where: { reference: { startsWith: 'ET-PILOT-' } } });
    expect(trips).toHaveLength(8);
    expect(new Set(trips.map((trip) => trip.vehicleId))).toEqual(
      new Set(coaches.map((coach) => coach.id)),
    );

    // The historical coaches: same row (status, name, code, make, model,
    // plate, amenities, seat map, timestamps) and no new audit event.
    expect(await fleetState()).toEqual(before);
    expect(await fleetAudit()).toEqual(auditBefore);

    // A second run reuses everything and writes nothing.
    const settled = await snapshot(h);
    const again = await h.run();
    expect(again.hasConflicts).toBe(false);
    expect(outcomes(again)).toEqual(['existing']);
    expect(await snapshot(h)).toEqual(settled);
    expect(await fleetState()).toEqual(before);
  });
});

describe('pilot data bootstrap: the dry run predicts vehicle identifier conflicts (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 60_000);

  afterAll(async () => {
    await h.drop();
  });

  // Another vehicle holds the name of the first pilot coach, another the
  // plate of the second (as the historical fleet did with the names).
  const [first, second] = PILOT_VEHICLES as [PilotVehicle, PilotVehicle];

  it('reports a name or plate held by another vehicle as the same conflict in a dry run and a write', async () => {
    const fr = await france(admin);
    const byName = await operatorVehicle(admin, {
      code: 'OPS-NAME',
      name: first.name,
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
    });
    const byPlate = await operatorVehicle(admin, {
      code: 'OPS-PLATE',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
      registrationPlate: second.registrationPlate,
      registrationCountryId: fr,
    });
    const operators = () =>
      db(h.t.app).vehicle.findMany({
        where: { id: { in: [byName, byPlate] } },
        orderBy: { code: 'asc' },
      });
    const before = await operators();
    const expected = [
      {
        key: 'ET-COACH-001',
        outcome: 'conflict',
        detail: `vehicle name "${first.name}" already belongs to OPS-NAME`,
      },
      {
        key: 'ET-COACH-002',
        outcome: 'conflict',
        detail: `registration FR/${second.registrationPlate} already belongs to OPS-PLATE`,
      },
    ];
    const refusedTrips = (report: PilotBootstrapReport) =>
      report.lines.filter((line) => line.entity === 'trip');

    const snap = await snapshot(h);
    const dry = await h.run({ dryRun: true });
    expect(vehicleLines(dry)).toEqual(expected);
    // Their departures are not planned either: the write would skip them.
    expect(refusedTrips(dry)).toHaveLength(8);
    for (const line of refusedTrips(dry)) {
      expect(line).toMatchObject({
        outcome: 'skipped',
        detail: expect.stringMatching(/^depends on vehicle:ET-COACH-00[12]$/),
      });
    }
    expect(await snapshot(h)).toEqual(snap);

    const applied = await h.run();
    expect(vehicleLines(applied)).toEqual(expected);
    expect(
      refusedTrips(applied).map(({ key, outcome, detail }) => ({ key, outcome, detail })),
    ).toEqual(refusedTrips(dry).map(({ key, outcome, detail }) => ({ key, outcome, detail })));
    const client = db(h.t.app);
    expect(await client.vehicle.count({ where: { code: { startsWith: 'ET-COACH-' } } })).toBe(0);
    expect(await client.trip.count()).toBe(0);
    expect(await operators()).toEqual(before);
  });

  it('checks the four unique keys of a vehicle, normalized as the fleet stores them', async () => {
    const client = db(h.t.app);
    const fr = (await client.country.findUniqueOrThrow({ where: { iso2: 'FR' } })).id;
    const vin = 'VF1ABCDEF12345678';
    await operatorVehicle(admin, {
      code: 'OPS-VIN',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
      vin,
    });
    const candidate = (fields: Record<string, unknown>) =>
      vehicleCreateSchema.parse({
        code: 'CANDIDATE-1',
        manufacturer: 'Autocar grand tourisme',
        model: 'Modèle à confirmer',
        ...fields,
      });
    const collision = (fields: Record<string, unknown>, exceptVehicleId?: string) =>
      vehicleIdentifierCollision(
        client,
        candidate(fields),
        exceptVehicleId ? { exceptVehicleId } : {},
      );

    expect(await collision({})).toBeNull();
    expect(await collision({ code: 'ops-name' })).toBe(
      'vehicle code OPS-NAME already belongs to another vehicle',
    );
    expect(await collision({ name: `  ${first.name.replaceAll(' ', '   ')} ` })).toBe(
      `vehicle name "${first.name}" already belongs to OPS-NAME`,
    );
    const byVin = await collision({ vin: vin.toLowerCase() });
    expect(byVin).toBe('VIN already belongs to OPS-VIN');
    expect(byVin).not.toContain(vin);
    expect(
      await collision({
        registrationPlate: ` ${second.registrationPlate.toLowerCase()} `,
        registrationCountryId: fr,
      }),
    ).toBe(`registration FR/${second.registrationPlate} already belongs to OPS-PLATE`);
    // A plate is unique per country: the same plate elsewhere, or without a
    // known country, is not a collision.
    expect(
      await collision({
        registrationPlate: second.registrationPlate,
        registrationCountryId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await collision({ registrationPlate: second.registrationPlate, registrationCountryId: null }),
    ).toBeNull();
    // The vehicle itself is not a collision (a rename keeps its own code).
    const opsName = await client.vehicle.findUniqueOrThrow({ where: { code: 'OPS-NAME' } });
    expect(await collision({ code: 'OPS-NAME', name: first.name }, opsName.id)).toBeNull();
    // Several collisions: the first unique key, in a fixed order.
    expect(
      await collision({
        name: first.name,
        vin,
        registrationPlate: second.registrationPlate,
        registrationCountryId: fr,
      }),
    ).toBe(`vehicle name "${first.name}" already belongs to OPS-NAME`);
  });
});

describe('pilot data bootstrap: pilot-corridor/2 coaches (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
    await h.run();
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('renames its own untouched coaches and refuses a coach a person changed', async () => {
    const client = db(h.t.app);
    const fleet = h.t.app.get(FleetService);
    const coach = (code: string) => client.vehicle.findUniqueOrThrow({ where: { code } });
    // A database seeded under pilot-corridor/2: the bootstrap gave its
    // coaches the names "Teranga 01" and "Teranga 02".
    for (const [code, name] of [
      ['ET-COACH-001', 'Teranga 01'],
      ['ET-COACH-002', 'Teranga 02'],
    ] as const) {
      await fleet.updateVehicle(
        (await coach(code)).id,
        vehicleUpdateSchema.parse({ name }),
        PILOT_ACTOR,
      );
    }
    // A person then changed coach 002 in OPS: it is operator data now.
    const changed = await adminApi(admin).post(
      `/fleet/vehicles/${(await coach('ET-COACH-002')).id}`,
      {
        amenities: ['WIFI'],
      },
    );
    expect(changed.status).toBe(200);
    const operatorCoach = await coach('ET-COACH-002');
    const operatorAudit = await client.auditEvent.count({
      where: { resourceId: operatorCoach.id },
    });
    const expected = (outcome: 'planned' | 'completed') => [
      {
        key: 'ET-COACH-001',
        outcome,
        detail: 'renamed from "Teranga 01" for pilot-corridor/3',
      },
      {
        key: 'ET-COACH-002',
        outcome: 'conflict',
        detail:
          'existing name "Teranga 02" is a previous pilot name, but a person created or changed this coach',
      },
    ];

    const snap = await snapshot(h);
    const dry = await h.run({ dryRun: true });
    expect(vehicleLines(dry)).toEqual(expected('planned'));
    // Departures are judged in the dry run as in the write (counted below).
    const trips = (report: PilotBootstrapReport, outcome: string) =>
      report.lines.filter((line) => line.entity === 'trip' && line.outcome === outcome).length;
    expect(await snapshot(h)).toEqual(snap);

    const applied = await h.run();
    expect(vehicleLines(applied)).toEqual(expected('completed'));
    for (const outcome of ['existing', 'skipped', 'planned', 'created', 'conflict']) {
      expect(trips(applied, outcome), outcome).toBe(trips(dry, outcome));
    }
    expect(await coach('ET-COACH-001')).toMatchObject({
      name: 'Teranga Pilote 01',
      status: 'ACTIVE',
    });
    const renamed = await client.auditEvent.findFirstOrThrow({
      where: { resourceId: (await coach('ET-COACH-001')).id, action: 'VEHICLE_UPDATED' },
      orderBy: { id: 'desc' },
    });
    expect(renamed.actorIdentityId).toBeNull();
    expect(renamed.metadata).toMatchObject({ systemActor: 'pilot-bootstrap' });
    expect(await coach('ET-COACH-002')).toEqual(operatorCoach);
    expect(await client.auditEvent.count({ where: { resourceId: operatorCoach.id } })).toBe(
      operatorAudit,
    );
    expect(await client.trip.count({ where: { reference: { startsWith: 'ET-PILOT-' } } })).toBe(8);

    // Next run: the renamed coach is the pilot's, the operator's is still refused.
    const again = await h.run();
    expect(vehicleLines(again)).toEqual([
      { key: 'ET-COACH-001', outcome: 'existing', detail: undefined },
      expected('completed')[1],
    ]);
    expect(await coach('ET-COACH-002')).toEqual(operatorCoach);
  });
});
