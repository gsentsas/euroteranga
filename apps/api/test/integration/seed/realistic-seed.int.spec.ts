import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../src/authorization/audit.service.js';
import { BaggageService } from '../../../src/baggage/baggage.service.js';
import { BookingService } from '../../../src/bookings/booking.service.js';
import { PublicBookingService } from '../../../src/bookings/public-booking.service.js';
import { ContentService } from '../../../src/content/content.service.js';
import { CrewService } from '../../../src/crew/crew.service.js';
import { FleetErrors } from '../../../src/fleet/fleet.errors.js';
import { FleetService } from '../../../src/fleet/fleet.service.js';
import { IncidentService } from '../../../src/incidents/incident.service.js';
import { NetworkService } from '../../../src/network/network.service.js';
import { PassengerDocumentService } from '../../../src/passenger-documents/passenger-document.service.js';
import { PaymentService } from '../../../src/payments/payment.service.js';
import { PaymentQuoteService } from '../../../src/payments/payment-quote.service.js';
import { PaymentWebhookService } from '../../../src/payments/payment-webhook.service.js';
import { PricingService } from '../../../src/pricing/pricing.service.js';
import { SeatMapService } from '../../../src/seat-maps/seat-map.service.js';
import { plannedBaggage } from '../../../src/seed/realistic/realistic-operations.js';
import {
  RealisticSeed,
  type RealisticSeedOptions,
  type RealisticSeedReport,
} from '../../../src/seed/realistic/realistic-seed.js';
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
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const today = () => new Date().toISOString().slice(0, 10);

interface Harness {
  t: TestApp;
  drop: () => Promise<void>;
  run: (
    overrides?: Partial<RealisticSeedOptions>,
    layers?: { operations?: boolean },
  ) => Promise<RealisticSeedReport>;
  cleanup: (options: { dryRun: boolean }) => Promise<RealisticSeedReport>;
}

async function harness(): Promise<Harness> {
  const database = await isolatedDatabase();
  const t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  const seed = (layers: { operations?: boolean } = {}) =>
    new RealisticSeed({
      db: db(t.app),
      audit: t.app.get(AuditService),
      network: t.app.get(NetworkService),
      seatMaps: t.app.get(SeatMapService),
      fleet: t.app.get(FleetService),
      pricing: t.app.get(PricingService),
      tracking: t.app.get(TrackingService),
      trips: t.app.get(TripService),
      content: t.app.get(ContentService),
      commerce: {
        audit: t.app.get(AuditService),
        bookings: t.app.get(BookingService),
        publicBooking: t.app.get(PublicBookingService),
        passengers: t.app.get(PassengerDocumentService),
        payments: t.app.get(PaymentService),
        quotes: t.app.get(PaymentQuoteService),
        webhooks: t.app.get(PaymentWebhookService),
      },
      operations:
        layers.operations === false
          ? undefined
          : {
              audit: t.app.get(AuditService),
              baggage: t.app.get(BaggageService),
              crew: t.app.get(CrewService),
              incidents: t.app.get(IncidentService),
              tracking: t.app.get(TrackingService),
            },
    });
  const run = (overrides: Partial<RealisticSeedOptions> = {}, layers = {}) =>
    seed(layers).run({ anchorDate: today(), tripsPerDirection: 6, dryRun: false, ...overrides });
  return {
    t,
    run,
    cleanup: (options) => seed().cleanup(options),
    drop: async () => {
      await t.app.close();
      await database.drop();
    },
  };
}

/** Row counts of every table the seed may write, plus the audit trail. */
async function snapshot(h: Harness) {
  const client = db(h.t.app);
  return {
    countries: await client.country.count(),
    stops: await client.stop.count(),
    checkpoints: await client.checkpoint.count(),
    routes: await client.route.count(),
    seatMaps: await client.seatMap.count(),
    seatMapVersions: await client.seatMapVersion.count(),
    vehicles: await client.vehicle.count(),
    fareTables: await client.fareTable.count(),
    trips: await client.trip.count(),
    contentEntries: await client.contentEntry.count(),
    contentRevisions: await client.contentRevision.count(),
    identities: await client.authIdentity.count(),
    bookings: await client.booking.count(),
    seats: await client.bookingSeat.count(),
    payments: await client.payment.count(),
    passengers: await client.passenger.count(),
    crewAssignments: await client.crewTripAssignment.count(),
    baggage: await client.baggage.count(),
    trackingConfigs: await client.tripTrackingConfig.count(),
    incidents: await client.incident.count(),
    manifests: await client.passengerManifest.count(),
    audit: await client.auditEvent.count(),
  };
}

const publicGet = (h: Harness, path: string) =>
  request(h.t.app.getHttpServer()).get(`/v1${path}`).set('Origin', 'http://localhost:3000');

describe('realistic seed: catalogue layer (isolated database)', () => {
  let h: Harness;
  let first: RealisticSeedReport;

  beforeAll(async () => {
    h = await harness();
    const dry = await h.run({ dryRun: true });
    // Everything is planned, except what the seed never does (check-in, manifests).
    const explained = (line: { entity: string; outcome: string }) =>
      line.outcome === 'skipped' && ['check-in', 'manifest'].includes(line.entity);
    expect(
      dry.lines.filter((line) => !explained(line)).every((line) => line.outcome === 'planned'),
    ).toBe(true);
    // A dry run writes nothing, audit included.
    expect(Object.values(await snapshot(h)).every((count) => count === 0)).toBe(true);
    first = await h.run();
  }, 180_000);

  afterAll(async () => {
    await h.drop();
  });

  it('creates the pilot corridor, the demo fleet additions and the public pages', async () => {
    expect(first.hasConflicts).toBe(false);
    expect(new Set(first.lines.map((line) => line.outcome))).toEqual(
      new Set(['created', 'updated', 'existing', 'skipped']),
    );
    expect(
      first.lines.filter((line) => line.outcome === 'skipped').map((line) => line.entity),
    ).toEqual(['check-in', 'manifest']);
    const client = db(h.t.app);
    const vehicles = await client.vehicle.findMany({ orderBy: { code: 'asc' } });
    expect(vehicles.map((vehicle) => [vehicle.code, vehicle.name, vehicle.status])).toEqual([
      ['ET-COACH-001', 'Teranga Pilote 01', 'ACTIVE'],
      ['ET-COACH-002', 'Teranga Pilote 02', 'ACTIVE'],
      ['ET-COACH-003', 'Teranga 03', 'PLANNED'],
    ]);
    // No invented make, model, year or registration for the demo coach.
    expect(vehicles[2]).toMatchObject({
      manufacturer: 'Autocar grand tourisme',
      model: 'Modèle à confirmer',
      modelYear: null,
      vin: null,
      registrationPlate: null,
    });
    const wheelchair = await client.seatMapVersion.findFirstOrThrow({
      where: { seatMap: { code: 'ET-SM-COACH-49' }, status: 'PUBLISHED' },
      include: { cells: true },
    });
    expect(wheelchair.cells.filter((cell) => cell.kind === 'SEAT')).toHaveLength(49);
    expect(vehicles[2]!.seatMapVersionId).toBe(wheelchair.id);
    const labels = wheelchair.cells.flatMap((cell) => (cell.seatLabel ? [cell.seatLabel] : []));
    expect(new Set(labels).size).toBe(labels.length);

    // Six upcoming departures per direction, all in the future.
    const trips = await client.trip.findMany({ where: { status: 'SCHEDULED' } });
    expect(trips).toHaveLength(12);
    expect(trips.every((trip) => trip.plannedDepartureAt!.getTime() > Date.now())).toBe(true);
  });

  it('publishes the active coaches only, with their equipment and no private identifier', async () => {
    const response = await publicGet(h, '/booking/fleet');
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        code: 'ET-COACH-001',
        name: 'Teranga Pilote 01',
        seatCount: 53,
        amenities: [
          'AIR_CONDITIONING',
          'RECLINING_SEATS',
          'USB_CHARGING',
          'WIFI',
          'TOILET',
          'ENTERTAINMENT',
        ],
      }),
      expect.objectContaining({
        code: 'ET-COACH-002',
        amenities: ['AIR_CONDITIONING', 'RECLINING_SEATS', 'USB_CHARGING', 'TOILET'],
      }),
    ]);
    expect(response.text).not.toMatch(/DEMO-ET|registration|vin/i);
  });

  it('serves the trip pages without indexing them, and a navigation without dead links', async () => {
    for (const path of ['/paris-dakar', '/dakar-paris', '/nos-bus', '/services']) {
      const page = await publicGet(h, `/content/pages?path=${encodeURIComponent(path)}`);
      expect(page.status, path).toBe(200);
      expect(page.body.document.seo.indexable, path).toBe(false);
    }
    expect((await publicGet(h, '/content/sitemap')).body.items).toEqual([]);
    const site = await publicGet(h, '/content/site');
    const links = [
      ...site.body.navigation.header,
      ...site.body.navigation.footer.flatMap((column: { links: unknown[] }) => column.links),
    ] as Array<{ target: { kind: string; path?: string } }>;
    expect(site.body.navigation.header.map((link: { label: string }) => link.label)).toEqual([
      'Paris → Dakar',
      'Dakar → Paris',
      'Nos bus',
      'Services',
    ]);
    for (const link of links.filter((candidate) => candidate.target.kind === 'page')) {
      const path = link.target.path!;
      if (path === '/') continue; // The home page shows the default content until published.
      expect((await publicGet(h, `/content/pages?path=${encodeURIComponent(path)}`)).status).toBe(
        200,
      );
    }
    // The trip pages read real departures: the seeded corridor is bookable.
    const stops = (await publicGet(h, '/booking/stops?limit=50')).body.items as Array<{
      id: string;
      code: string;
    }>;
    const id = (code: string) => stops.find((stop) => stop.code === code)!.id;
    const trips = await publicGet(
      h,
      `/booking/trips?originStopId=${id('PAR')}&destinationStopId=${id('DKR')}`,
    );
    expect(trips.body.items).toHaveLength(6);
    expect(trips.body.items[0].fare).toMatchObject({ amountMinor: 24_900, currencyCode: 'EUR' });
  });

  it('audits its own writes as the realistic-seed system actor, never as a person', async () => {
    const events = await db(h.t.app).auditEvent.findMany({
      where: { metadata: { path: ['systemActor'], equals: 'realistic-seed' } },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.actorIdentityId === null)).toBe(true);
    const types = new Set(events.map((event) => event.resourceType));
    for (const type of ['vehicle', 'content_entry', 'auth_identity', 'booking', 'payment']) {
      expect(types.has(type), type).toBe(true);
    }
  });

  it('books the upcoming departures as synthetic customers, through SANDBOX payments', async () => {
    const client = db(h.t.app);
    const bookings = await client.booking.findMany({
      include: {
        seats: { include: { seatMapCell: true } },
        payments: true,
        passengers: { include: { passenger: { include: { nationalityCountry: true } } } },
        trip: true,
        customerIdentity: { include: { passwordCredential: true } },
      },
    });
    expect(bookings).toHaveLength(40);
    const state = (booking: (typeof bookings)[number]) =>
      booking.cancelledAt ? 'CANCELLED' : booking.confirmedAt ? 'CONFIRMED' : 'HELD';
    expect(bookings.filter((booking) => state(booking) === 'CONFIRMED')).toHaveLength(37);
    expect(bookings.filter((booking) => state(booking) === 'CANCELLED')).toHaveLength(1);
    expect(bookings.filter((booking) => state(booking) === 'HELD')).toHaveLength(2);
    const payments = bookings.flatMap((booking) => booking.payments);
    expect(payments.filter((payment) => payment.status === 'SUCCEEDED')).toHaveLength(37);
    expect(payments.filter((payment) => payment.status === 'PENDING')).toHaveLength(1);
    expect(payments.filter((payment) => payment.status === 'FAILED')).toHaveLength(1);

    for (const booking of bookings) {
      // Synthetic, never sign-in capable customers on a reserved domain.
      expect(booking.customerIdentity.normalizedEmail).toMatch(/^etr-v1-[a-z0-9-]+@example\.test$/);
      expect(booking.customerIdentity.passwordCredential).toBeNull();
      // Seats of the trip's own seat map, at the pilot fare.
      expect(
        booking.seats.every(
          (seat) => seat.seatMapCell.seatMapVersionId === booking.trip.seatMapVersionId,
        ),
      ).toBe(true);
      expect(booking.seats.every((seat) => seat.seatMapCell.kind === 'SEAT')).toBe(true);
      expect(booking.unitAmountMinor).toBe(24_900);
      for (const payment of booking.payments) {
        expect(Number(payment.amountMinor)).toBe(24_900 * booking.seats.length);
        expect(payment.provider).toBe('SANDBOX');
      }
      // Confirmed bookings name one passenger per seat; families share a nationality.
      if (state(booking) === 'CONFIRMED') {
        expect(booking.passengers).toHaveLength(booking.seats.length);
        const names = booking.passengers.map(({ passenger }) => passenger.givenName);
        expect(new Set(names).size).toBe(names.length);
        expect(
          new Set(booking.passengers.map(({ passenger }) => passenger.nationalityCountry.iso2))
            .size,
        ).toBe(1);
      } else {
        expect(booking.passengers).toHaveLength(0);
      }
    }
    // No seat is sold twice on a segment.
    const duplicates = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM (
        SELECT "trip_id", "seat_map_cell_id", "segment_sequence" FROM "seat_inventory_lock"
        GROUP BY 1, 2, 3 HAVING count(*) > 1) AS d`;
    expect(Number(duplicates[0]!.count)).toBe(0);
    // About 85 % of the soonest Paris -> Dakar departure is taken.
    const stops = (await publicGet(h, '/booking/stops?limit=50')).body.items as Array<{
      id: string;
      code: string;
    }>;
    const id = (code: string) => stops.find((stop) => stop.code === code)!.id;
    const soonest = (
      await publicGet(h, `/booking/trips?originStopId=${id('PAR')}&destinationStopId=${id('DKR')}`)
    ).body.items[0];
    expect(soonest.availableSeatCount).toBe(53 - 45);
  });

  it('prepares the soonest departures under the seed operator, never as a person', async () => {
    const client = db(h.t.app);
    const operator = await client.authIdentity.findUniqueOrThrow({
      where: {
        realm_normalizedEmail: {
          realm: 'STAFF',
          normalizedEmail: 'etr-v1-operations@example.test',
        },
      },
      include: { passwordCredential: true, roleAssignments: true },
    });
    // A dedicated synthetic account: no password, no role, no permission.
    expect(operator.passwordCredential).toBeNull();
    expect(operator.roleAssignments).toHaveLength(0);

    const assignments = await client.crewTripAssignment.findMany({
      include: { trip: true, crew: true },
    });
    expect(assignments).toHaveLength(8);
    expect(assignments.every((row) => row.assignedByIdentityId === operator.id)).toBe(true);
    expect(assignments.every((row) => row.crew.realm === 'CREW')).toBe(true);
    expect(new Set(assignments.map((row) => row.crewIdentityId)).size).toBe(4);

    // Bags declared by travellers of confirmed bookings of the soonest departures only.
    const bags = await client.baggage.findMany({
      include: { bookingPassenger: { include: { booking: true } }, events: true },
    });
    expect(bags.length).toBeGreaterThan(30);
    expect(bags.every((bag) => bag.bookingPassenger.booking.confirmedAt !== null)).toBe(true);
    expect(new Set(bags.map((bag) => bag.bookingPassenger.booking.tripId)).size).toBe(2);
    expect(bags.every((bag) => bag.events.map((event) => event.type).join() === 'REGISTERED')).toBe(
      true,
    );

    const trackings = await client.tripTrackingConfig.findMany();
    expect(trackings).toHaveLength(12);
    expect(
      trackings.every(
        (row) =>
          row.enabled && row.visibility === 'CHECKPOINT_ONLY' && row.trackingDeviceId === null,
      ),
    ).toBe(true);

    const incidents = await client.incident.findMany();
    expect(incidents.map((row) => [row.type, row.severity, row.source]).sort()).toEqual([
      ['DELAY', 'LOW', 'STAFF'],
      ['OTHER', 'LOW', 'STAFF'],
    ]);
    expect(incidents.every((row) => row.openedByIdentityId === operator.id)).toBe(true);
    expect(incidents.every((row) => row.description.includes('démonstration'))).toBe(true);
    // Check-in and manifests need verified documents: never fabricated.
    expect(await client.passengerCheckIn.count()).toBe(0);
    expect(await client.passengerManifest.count()).toBe(0);
  });

  it('is idempotent: a second run reuses everything and writes nothing', async () => {
    const before = await snapshot(h);
    const second = await h.run();
    expect(second.hasConflicts).toBe(false);
    expect(new Set(second.lines.map((line) => line.outcome))).toEqual(
      new Set(['existing', 'skipped']),
    );
    expect(await snapshot(h)).toEqual(before);
  });
});

describe('realistic seed: operator data is never overwritten (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('keeps an operator navigation, an operator page and operator equipment', async () => {
    // The operator already published a navigation and wrote the "Nos bus" page.
    const navigation = await adminApi(admin).post('/content/entries', { kind: 'NAVIGATION' });
    expect(navigation.status).toBe(201);
    const page = await adminApi(admin).post('/content/entries', {
      kind: 'PAGE',
      path: '/nos-bus',
      title: 'Notre flotte',
      description: 'Page écrite par l’exploitant.',
    });
    expect(page.status).toBe(201);
    const first = await h.run();
    // The pilot coach 001 now exists: give it operator equipment, then run again.
    const coach = await db(h.t.app).vehicle.findUniqueOrThrow({ where: { code: 'ET-COACH-001' } });
    expect(coach.amenities).toHaveLength(6);
    await db(h.t.app).vehicle.update({ where: { id: coach.id }, data: { amenities: ['WIFI'] } });
    const before = await db(h.t.app).auditEvent.count({ where: { resourceId: coach.id } });

    const second = await h.run();
    const line = (report: RealisticSeedReport, entity: string, key: string) =>
      report.lines.find((candidate) => candidate.entity === entity && candidate.key === key);
    expect(line(first, 'navigation', 'site')).toMatchObject({ outcome: 'existing' });
    expect(line(first, 'page', '/nos-bus')).toMatchObject({
      outcome: 'existing',
      detail: 'not published (kept)',
    });
    expect(line(second, 'amenities', 'ET-COACH-001')).toMatchObject({ outcome: 'conflict' });
    expect(second.hasConflicts).toBe(true);
    // Untouched: the operator values and no new audit event on the coach.
    expect(
      (await db(h.t.app).vehicle.findUniqueOrThrow({ where: { id: coach.id } })).amenities,
    ).toEqual(['WIFI']);
    expect(await db(h.t.app).auditEvent.count({ where: { resourceId: coach.id } })).toBe(before);
    const operatorPage = await db(h.t.app).contentRevision.findMany({
      where: { entry: { key: '/nos-bus' } },
    });
    expect(operatorPage).toHaveLength(1);
    expect((operatorPage[0]!.document as { title: string }).title).toBe('Notre flotte');
  });
});

describe('realistic seed: no bookings outside local and CI (isolated database)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('reports the commerce layer as skipped and books nothing', async () => {
    const report = await h.run({ commerceUnavailable: 'APP_ENV=staging' });
    expect(report.lines).toContainEqual(
      expect.objectContaining({ layer: 'commerce', outcome: 'skipped', detail: 'APP_ENV=staging' }),
    );
    expect(await db(h.t.app).booking.count()).toBe(0);
    const identities = await db(h.t.app).authIdentity.findMany({
      include: { passwordCredential: true, mfaTotpCredential: true, roleAssignments: true },
    });
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      realm: 'STAFF',
      normalizedEmail: 'pilot-bootstrap-operator@example.test',
      passwordCredential: null,
      mfaTotpCredential: null,
      roleAssignments: [],
    });
    // The catalogue (public site) and checkpoint-only pilot tracking are still complete.
    expect(await db(h.t.app).trip.count()).toBe(12);
    expect(await db(h.t.app).tripTrackingConfig.count()).toBe(12);
  });
});

describe('realistic seed: cleanup retires seed data only (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
    await h.run();
  }, 180_000);

  afterAll(async () => {
    await h.drop();
  });

  it('archives, retires and cancels its own records, and nothing that belongs to anyone else', async () => {
    const client = db(h.t.app);
    // Operator data next to the seed: a vehicle, a page, and a seed page a person edited.
    const operatorCoach = await adminApi(admin).post('/fleet/vehicles', {
      code: 'OPS_COACH_01',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
      amenities: ['WIFI', 'TOILET'],
    });
    expect(operatorCoach.status).toBe(201);
    const operatorPage = await adminApi(admin).post('/content/entries', {
      kind: 'PAGE',
      path: '/a-propos',
      title: 'À propos',
      description: 'Page écrite par l’exploitant.',
    });
    expect(operatorPage.status).toBe(201);
    const services = await client.contentEntry.findUniqueOrThrow({
      where: { kind_key: { kind: 'PAGE', key: '/services' } },
      include: { revisions: { where: { status: 'PUBLISHED' } } },
    });
    const edited = await adminApi(admin).post(`/content/entries/${services.id}/draft`, {
      document: { ...(services.revisions[0]!.document as object), title: 'Nos services, revus' },
      expectedDraftUpdatedAt: null,
    });
    expect(edited.status).toBe(200);
    const operatorRecords = async () => ({
      coach: await client.vehicle.findUniqueOrThrow({ where: { code: 'OPS_COACH_01' } }),
      page: await client.contentEntry.findUniqueOrThrow({ where: { id: operatorPage.body.id } }),
      services: await client.contentEntry.findUniqueOrThrow({ where: { id: services.id } }),
      pilotTrips: await client.trip.findMany({
        orderBy: { reference: 'asc' },
        select: { reference: true, status: true, vehicleId: true },
      }),
      pilotCoaches: await client.vehicle.findMany({
        where: { code: { in: ['ET-COACH-001', 'ET-COACH-002'] } },
        select: { code: true, status: true },
      }),
      operatorAudit: await client.auditEvent.count({
        where: { resourceId: { in: [operatorCoach.body.id, operatorPage.body.id] } },
      }),
    });
    const before = await operatorRecords();

    // The preview writes nothing.
    const auditBefore = await client.auditEvent.count();
    const preview = await h.cleanup({ dryRun: true });
    expect(preview.lines.some((line) => line.outcome === 'planned')).toBe(true);
    expect(preview.lines.some((line) => line.outcome === 'retired')).toBe(false);
    expect(await client.auditEvent.count()).toBe(auditBefore);

    const report = await h.cleanup({ dryRun: false });
    expect(report.hasConflicts).toBe(false);
    const outcome = (entity: string, key: string) =>
      report.lines.find((line) => line.entity === entity && line.key === key)?.outcome;
    expect(outcome('page', '/paris-dakar')).toBe('retired');
    expect(outcome('page', '/nos-bus')).toBe('retired');
    expect(outcome('page', '/services')).toBe('kept');
    expect(outcome('navigation', 'site')).toBe('retired');
    expect(outcome('vehicle', 'ET-COACH-003')).toBe('retired');
    expect(outcome('seat-map', 'ET-SM-COACH-49')).toBe('retired');
    expect(outcome('amenities', 'ET-COACH-001')).toBe('retired');
    expect(outcome('booking', 'confirmed')).toBe('kept');
    // The two open holds (pending payment, declined payment) are cancelled.
    expect(
      report.lines.filter((line) => line.entity === 'booking' && line.outcome === 'retired'),
    ).toHaveLength(2);

    // Everything that is not the seed's is exactly as it was, audit included.
    expect(await operatorRecords()).toEqual(before);
    expect(
      (
        await client.contentEntry.findUniqueOrThrow({
          where: { kind_key: { kind: 'PAGE', key: '/paris-dakar' } },
        })
      ).archivedAt,
    ).not.toBeNull();
    expect(
      (await client.vehicle.findUniqueOrThrow({ where: { code: 'ET-COACH-003' } })).status,
    ).toBe('RETIRED');
    const fleet = (await publicGet(h, '/booking/fleet')).body.items as Array<{
      code: string;
      amenities: string[];
    }>;
    expect(fleet.find((item) => item.code === 'ET-COACH-001')!.amenities).toEqual([]);
    expect(fleet.find((item) => item.code === 'OPS_COACH_01')).toBeUndefined(); // PLANNED
    expect((await publicGet(h, '/content/pages?path=/paris-dakar')).status).toBe(404);
    const site = await publicGet(h, '/content/site');
    expect(site.body.navigation.header.map((link: { label: string }) => link.label)).toEqual([
      'Trajets',
      'Services',
      'Suivi',
      'Aide',
    ]);

    // A second cleanup finds nothing more to retire.
    const again = await h.cleanup({ dryRun: false });
    expect(again.lines.some((line) => line.outcome === 'retired')).toBe(false);
  });
});

describe('realistic seed: the cleanup preview matches the cleanup (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
    await h.run();
  }, 180_000);

  afterAll(async () => {
    await h.drop();
  });

  it('keeps the seat map when a person took over the demo coach, in both modes', async () => {
    const coach = await db(h.t.app).vehicle.findUniqueOrThrow({ where: { code: 'ET-COACH-003' } });
    const edited = await adminApi(admin).post(`/fleet/vehicles/${coach.id}`, {
      name: 'Teranga 03 (exploitant)',
    });
    expect(edited.status).toBe(200);
    const outcomes = (report: RealisticSeedReport) =>
      Object.fromEntries(
        report.lines
          .filter((line) => ['vehicle', 'seat-map'].includes(line.entity))
          .map((line) => [line.key, line.outcome]),
      );
    const preview = outcomes(await h.cleanup({ dryRun: true }));
    expect(preview).toEqual({ 'ET-COACH-003': 'kept', 'ET-SM-COACH-49': 'kept' });
    expect(outcomes(await h.cleanup({ dryRun: false }))).toEqual(preview);
    expect(
      (await db(h.t.app).seatMap.findUniqueOrThrow({ where: { code: 'ET-SM-COACH-49' } })).active,
    ).toBe(true);
  });
});

describe('realistic seed: never reuses an identity it did not create (isolated database)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('refuses a person holding the operator address and records no operational fact', async () => {
    const client = db(h.t.app);
    // Someone was given the seed operator's address (no seed provenance).
    const person = await client.authIdentity.create({
      data: {
        realm: 'STAFF',
        email: 'etr-v1-operations@example.test',
        normalizedEmail: 'etr-v1-operations@example.test',
        status: 'ACTIVE',
      },
    });
    const report = await h.run();
    expect(
      report.lines.find((line) => line.entity === 'operator' && line.key === 'operations'),
    ).toMatchObject({
      outcome: 'conflict',
      detail: expect.stringContaining('not created by the seed'),
    });
    // Nothing operational is recorded under that identity. DATA-1 still configures
    // checkpoint-only tracking under its own separate pilot operator identity.
    expect(await client.crewTripAssignment.count()).toBe(0);
    expect(await client.incident.count()).toBe(0);
    const trackingConfigs = await client.tripTrackingConfig.findMany();
    expect(trackingConfigs).toHaveLength(12);
    expect(
      trackingConfigs.every(
        (row) =>
          row.visibility === 'CHECKPOINT_ONLY' &&
          row.trackingDeviceId === null &&
          row.createdByIdentityId !== person.id &&
          row.updatedByIdentityId !== person.id,
      ),
    ).toBe(true);
    expect(await client.auditEvent.count({ where: { resourceId: person.id } })).toBe(0);
    expect(await client.authIdentity.findUniqueOrThrow({ where: { id: person.id } })).toEqual(
      person,
    );
  });
});

describe('realistic seed: a real customer is never touched (isolated database)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await h.run({}, { operations: false });
  }, 180_000);

  afterAll(async () => {
    await h.drop();
  });

  it('declares bags for synthetic customers only', async () => {
    const client = db(h.t.app);
    // A real customer books and pays the soonest Paris -> Dakar departure.
    const trip = await client.trip.findFirstOrThrow({
      where: { reference: { startsWith: 'ET-PILOT-PARDKR-' } },
      orderBy: { plannedDepartureAt: 'asc' },
      include: { routeVersion: { include: { waypoints: { orderBy: { sequence: 'asc' } } } } },
    });
    const customer = await client.authIdentity.create({
      data: {
        realm: 'CUSTOMER',
        email: 'voyageuse@example.org',
        normalizedEmail: 'voyageuse@example.org',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const actor = { kind: 'system' as const, source: 'test', customerIdentityId: customer.id };
    const [origin, destination] = [
      trip.routeVersion.waypoints[0]!.id,
      trip.routeVersion.waypoints.at(-1)!.id,
    ];
    const free = (
      await h.t.app.get(PublicBookingService).availability(trip.id, origin, destination)
    ).cells.find((cell) => 'available' in cell && cell.available)!;
    const booking = await h.t.app.get(BookingService).create(
      {
        tripId: trip.id,
        originRouteWaypointId: origin,
        destinationRouteWaypointId: destination,
        seatMapCellIds: [free.id],
      },
      actor,
    );
    const quote = await h.t.app
      .get(PaymentQuoteService)
      .create(actor, booking.reference, { payerCountry: 'FR', paymentMethod: 'CARD' });
    const payment = await h.t.app
      .get(PaymentService)
      .create(actor, booking.reference, 'test-payment-real-customer-01', {
        quoteId: quote.id,
        paymentMethod: 'CARD',
      });
    const row = await client.payment.findUniqueOrThrow({
      where: { reference: payment.result.payment.reference },
    });
    await h.t.app.get(PaymentWebhookService).process('SANDBOX', {
      providerEventId: 'evt_test_real_customer_01',
      type: 'PAYMENT_SUCCEEDED',
      providerPaymentId: row.providerPaymentId!,
      amountMinor: BigInt(row.amountMinor),
      currencyCode: row.currencyCode,
      failureCode: null,
      payloadHash: 'a'.repeat(64),
    });
    const france = await client.country.findUniqueOrThrow({ where: { iso2: 'FR' } });
    await h.t.app.get(PassengerDocumentService).createPassenger(actor, booking.reference, {
      givenName: 'Claire',
      familyName: 'Voyageuse',
      dateOfBirth: new Date('1990-05-04T00:00:00.000Z'),
      nationalityCountryId: france.id,
    });

    await h.run();
    const real = await client.baggage.count({
      where: { bookingPassenger: { booking: { customerIdentityId: customer.id } } },
    });
    expect(real).toBe(0);
    expect(
      await client.baggage.count({ where: { bookingPassenger: { booking: { tripId: trip.id } } } }),
    ).toBeGreaterThan(0);
  });
});

describe('realistic seed: interrupted bag declarations resume (isolated database)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await h.run({}, { operations: false });
  }, 180_000);

  afterAll(async () => {
    await h.drop();
  });

  it('declares only the bags each traveller is still missing', async () => {
    const client = db(h.t.app);
    const trip = await client.trip.findFirstOrThrow({
      where: { reference: { startsWith: 'ET-PILOT-PARDKR-' } },
      orderBy: { plannedDepartureAt: 'asc' },
    });
    const travellers = await client.bookingPassenger.findMany({
      where: { booking: { tripId: trip.id, confirmedAt: { not: null }, cancelledAt: null } },
      include: { booking: true, passenger: true },
    });
    // An earlier run stopped after the first bag of a traveller who plans two.
    const interrupted = travellers.find(
      (link) => plannedBaggage(trip.reference, link.passenger.reference).length === 2,
    )!;
    const [firstType] = plannedBaggage(trip.reference, interrupted.passenger.reference);
    await h.t.app.get(BaggageService).customerRegister(
      {
        kind: 'system',
        source: 'test',
        customerIdentityId: interrupted.booking.customerIdentityId,
      },
      interrupted.booking.reference,
      interrupted.passenger.reference,
      { type: firstType! },
    );

    await h.run();
    for (const link of travellers) {
      const bags = await client.baggage.count({
        where: { bookingId: link.bookingId, passengerId: link.passengerId },
      });
      expect(bags, link.passenger.reference).toBe(
        plannedBaggage(trip.reference, link.passenger.reference).length,
      );
    }
  });
});

/** The nth call (from 1) of a service method fails, as when a run is interrupted there. */
function interruptAt(service: object, method: string, call: number) {
  const target = service as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target[method]!.bind(service);
  let calls = 0;
  return vi.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
    calls += 1;
    if (calls === call) throw new Error('interrupted');
    return original(...args);
  });
}

describe('realistic seed: interrupted departures resume (isolated database)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  }, 60_000);

  afterAll(async () => {
    await h.drop();
  });

  const interrupted = async (service: object, method: string, call: number) => {
    const spy = interruptAt(service, method, call);
    try {
      await expect(h.run({}, { operations: false })).rejects.toThrow('interrupted');
    } finally {
      spy.mockRestore();
    }
  };
  const bookingOf = (key: string) =>
    db(h.t.app).booking.findMany({
      where: { customerIdentity: { normalizedEmail: `etr-v1-${key}@example.test` } },
      include: { payments: true, _count: { select: { passengers: true } } },
    });

  it('completes each booking where it stopped, never twice, and reports an expired hold', async () => {
    // Out0 groups 1 and 2 are complete; group 3 stops with its payment pending,
    // then with 1 of its 5 passengers named; group 4 stops before its payment.
    await interrupted(h.t.app.get(PaymentWebhookService), 'process', 3);
    const [held] = await bookingOf('out0-03');
    expect(held!.confirmedAt).toBeNull();
    expect(held!.payments.map((payment) => payment.status)).toEqual(['PENDING']);
    await interrupted(h.t.app.get(PassengerDocumentService), 'createPassenger', 2);
    const [third] = await bookingOf('out0-03');
    expect(third!.confirmedAt).not.toBeNull();
    expect(third).toMatchObject({ _count: { passengers: 1 } });
    await interrupted(h.t.app.get(PaymentService), 'create', 1);
    expect(await bookingOf('out0-03')).toMatchObject([{ _count: { passengers: 5 } }]);
    const [fourth] = await bookingOf('out0-04');
    expect(fourth!.payments).toHaveLength(0);

    // A dry run names the missing steps and writes nothing.
    const before = await snapshot(h);
    const dry = await h.run({ dryRun: true }, { operations: false });
    expect(await snapshot(h)).toEqual(before);
    expect(
      dry.lines.find((line) => line.entity === 'booking' && line.key === fourth!.reference),
    ).toMatchObject({ outcome: 'planned', detail: expect.stringMatching(/resume: start the/) });

    // Seen two hours later, the hold of group 4 has expired: a conflict, not a new booking.
    const later = await h.run({ now: new Date(Date.now() + 2 * 3600_000) }, { operations: false });
    expect(
      later.lines.find((line) => line.entity === 'booking' && line.key === 'out0-04'),
    ).toMatchObject({ outcome: 'conflict', detail: expect.stringMatching(/is expired/) });
    expect(await bookingOf('out0-04')).toHaveLength(1);

    // While the hold is active, the next run completes it, and everything else.
    const resumed = await h.run({}, { operations: false });
    expect(resumed.hasConflicts).toBe(false);
    const client = db(h.t.app);
    const seed = {
      customerIdentity: { normalizedEmail: { startsWith: 'etr-v1-', endsWith: '@example.test' } },
    };
    const bookings = await client.booking.findMany({
      where: seed,
      include: {
        customerIdentity: true,
        payments: true,
        _count: { select: { passengers: true } },
      },
    });
    // The plan: 40 bookings, one per customer and departure; 37 confirmed for 98 seats.
    expect(bookings).toHaveLength(40);
    expect(new Set(bookings.map((b) => `${b.tripId} ${b.customerIdentityId}`)).size).toBe(40);
    const confirmed = bookings.filter((b) => b.confirmedAt && !b.cancelledAt);
    expect(confirmed).toHaveLength(37);
    expect(confirmed.reduce((sum, b) => sum + b._count.passengers, 0)).toBe(98);
    for (const booking of confirmed) {
      const seats = await client.bookingSeat.count({ where: { bookingId: booking.id } });
      expect(booking._count.passengers, booking.customerIdentity.normalizedEmail).toBe(seats);
    }
    expect(bookings.every((b) => b.payments.length <= 1)).toBe(true);
    expect(bookings.reduce((sum, b) => sum + b.payments.length, 0)).toBe(39);

    // Then a run has nothing left to do.
    const settled = await snapshot(h);
    const again = await h.run({}, { operations: false });
    expect(await snapshot(h)).toEqual(settled);
    expect(
      again.lines
        .filter((line) => line.layer === 'commerce')
        .every((line) => ['existing', 'skipped'].includes(line.outcome)),
    ).toBe(true);
  }, 300_000);
});

describe('realistic seed: resumes the partial production apply (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  const staging = { commerceUnavailable: 'APP_ENV=staging' };
  const PAGES = ['/dakar-paris', '/nos-bus', '/paris-dakar', '/services'];

  it('completes the coaches and trips the first apply missed, then writes nothing', async () => {
    const client = db(h.t.app);
    // Production before the seed: the operator's France, retired coaches
    // named Teranga 01 and 02, four published pages and a navigation.
    const france = await adminApi(admin).post('/network/countries', {
      iso2: 'FR',
      iso3: 'FRA',
      name: 'France',
      active: true,
    });
    expect(france.status).toBe(201);
    const historical = [
      await operatorVehicle(
        admin,
        {
          code: 'ET-BUS-001',
          name: 'Teranga 01',
          manufacturer: 'MAN',
          model: 'Lion’s Coach L',
          registrationPlate: 'XX-234-YM',
          registrationCountryId: france.body.id,
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
          registrationCountryId: france.body.id,
        },
        ['ACTIVE', 'RETIRED'],
      ),
    ];
    for (const path of PAGES) {
      const page = await adminApi(admin).post('/content/entries', {
        kind: 'PAGE',
        path,
        title: `Page exploitant ${path}`,
        description: 'Page écrite par l’exploitant.',
      });
      expect(page.status).toBe(201);
      const published = await adminApi(admin).post(`/content/entries/${page.body.id}/publish`, {
        expectedDraftUpdatedAt: page.body.draft.updatedAt,
      });
      expect(published.status).toBe(200);
    }
    const navigation = await adminApi(admin).post('/content/entries', { kind: 'NAVIGATION' });
    expect(navigation.status).toBe(201);
    const fleetState = () =>
      client.vehicle.findMany({ where: { id: { in: historical } }, orderBy: { code: 'asc' } });
    const fleetAudit = () => client.auditEvent.count({ where: { resourceId: { in: historical } } });
    const fleetBefore = await fleetState();
    const fleetAuditBefore = await fleetAudit();
    const contentBefore = await client.contentRevision.findMany({ orderBy: { id: 'asc' } });

    // The first apply: the fleet service refused the two pilot coaches
    // (VEHICLE_IDENTIFIER_CONFLICT), after the rest of the catalogue.
    const fleet = h.t.app.get(FleetService);
    const createVehicle = fleet.createVehicle.bind(fleet);
    const refused = vi
      .spyOn(fleet, 'createVehicle')
      .mockImplementation(async (input, actor) =>
        ['ET-COACH-001', 'ET-COACH-002'].includes(input.code)
          ? Promise.reject(FleetErrors.identifierConflict())
          : createVehicle(input, actor),
      );
    let partial: RealisticSeedReport;
    try {
      partial = await h.run(staging);
    } finally {
      refused.mockRestore();
    }
    const line = (report: RealisticSeedReport, entity: string, key: string) =>
      report.lines.find((candidate) => candidate.entity === entity && candidate.key === key);
    expect(line(partial, 'vehicle', 'ET-COACH-001')).toMatchObject({
      outcome: 'conflict',
      detail: expect.stringMatching(/^VEHICLE_IDENTIFIER_CONFLICT/),
    });
    // The production state after that apply.
    expect(await client.checkpoint.count()).toBe(5);
    expect((await client.route.findMany({ orderBy: { code: 'asc' } })).map((r) => r.code)).toEqual([
      'ET-DKR-PAR',
      'ET-PAR-DKR',
    ]);
    expect(
      (await client.seatMap.findMany({ orderBy: { code: 'asc' } })).map((m) => m.code),
    ).toEqual(['ET-SM-COACH-49', 'ET-SM-COACH-53']);
    expect(await client.fareTable.count()).toBe(2);
    expect(
      (await client.vehicle.findMany({ orderBy: { code: 'asc' } })).map((v) => [v.code, v.status]),
    ).toEqual([
      ['ET-BUS-001', 'RETIRED'],
      ['ET-BUS-002', 'RETIRED'],
      ['ET-COACH-003', 'PLANNED'],
    ]);
    expect(await client.trip.count()).toBe(0);

    // The next dry run: the catalogue exists; only the two coaches, their
    // equipment and the twelve departures are planned, without conflict.
    const before = await snapshot(h);
    const dry = await h.run({ ...staging, dryRun: true });
    expect(await snapshot(h)).toEqual(before);
    expect(dry.hasConflicts).toBe(false);
    const catalogue = (report: RealisticSeedReport) =>
      report.lines.filter((candidate) => candidate.layer === 'catalogue');
    const keysOf = (report: RealisticSeedReport, outcomes: readonly string[]) =>
      catalogue(report)
        .filter((candidate) => outcomes.includes(candidate.outcome))
        .map((candidate) => `${candidate.entity} ${candidate.key}`)
        .sort();
    const pending = keysOf(dry, ['planned']);
    expect(
      pending.filter((key) => !key.startsWith('trip ') && !key.startsWith('tracking ')),
    ).toEqual([
      'amenities ET-COACH-001',
      'amenities ET-COACH-002',
      'vehicle ET-COACH-001',
      'vehicle ET-COACH-002',
    ]);
    const pendingTracking = pending.filter((key) => key.startsWith('tracking '));
    expect(pendingTracking).toHaveLength(12);
    expect(
      pendingTracking.every((key) => /^tracking ET-PILOT-(DKRPAR|PARDKR)-\d{8}$/.test(key)),
    ).toBe(true);
    expect(pending.filter((key) => key.startsWith('trip '))).toHaveLength(12);
    expect(new Set(catalogue(dry).map((candidate) => candidate.outcome))).toEqual(
      new Set(['existing', 'planned']),
    );
    for (const path of PAGES) {
      expect(line(dry, 'page', path)).toMatchObject({
        outcome: 'existing',
        detail: 'published (kept)',
      });
    }
    expect(line(dry, 'navigation', 'site')).toMatchObject({
      outcome: 'existing',
      detail: 'operator navigation kept',
    });

    // The apply creates what the dry run planned plus the synthetic tracking
    // operator identity. The dry run never creates identities by design.
    const applied = await h.run(staging);
    expect(applied.hasConflicts).toBe(false);
    expect(
      keysOf(applied, ['created', 'updated']).filter((key) => key !== 'operator tracking'),
    ).toEqual(pending);
    expect(line(applied, 'operator', 'tracking')).toMatchObject({
      layer: 'catalogue',
      outcome: 'created',
    });
    expect(keysOf(applied, ['existing'])).toEqual(keysOf(dry, ['existing']));
    expect(
      (
        await client.vehicle.findMany({
          where: { code: { startsWith: 'ET-COACH-' } },
          orderBy: { code: 'asc' },
        })
      ).map((v) => [v.code, v.name, v.status, v.amenities.length > 0]),
    ).toEqual([
      ['ET-COACH-001', 'Teranga Pilote 01', 'ACTIVE', true],
      ['ET-COACH-002', 'Teranga Pilote 02', 'ACTIVE', true],
      ['ET-COACH-003', 'Teranga 03', 'PLANNED', true],
    ]);
    expect(await client.trip.count({ where: { status: 'SCHEDULED' } })).toBe(12);
    expect(await client.vehicle.count()).toBe(5);

    // A second apply: nothing created, updated or refused, not a row or an
    // audit event more.
    const settled = await snapshot(h);
    const again = await h.run(staging);
    expect(again.hasConflicts).toBe(false);
    expect(keysOf(again, ['created', 'updated', 'conflict'])).toEqual([]);
    expect(await snapshot(h)).toEqual(settled);

    // Operator data: untouched throughout, and never claimed by the cleanup.
    expect(await fleetState()).toEqual(fleetBefore);
    expect(await fleetAudit()).toBe(fleetAuditBefore);
    expect(await client.contentRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(
      contentBefore,
    );
    const preview = await h.cleanup({ dryRun: true });
    expect(
      preview.lines.filter(
        (candidate) =>
          ['page', 'navigation', 'vehicle'].includes(candidate.entity) &&
          candidate.outcome !== 'kept' &&
          candidate.key !== 'ET-COACH-003',
      ),
    ).toEqual([]);
  }, 300_000);
});

describe('realistic seed: the dry run predicts a demo coach name conflict (isolated database)', () => {
  let h: Harness;
  let admin: StaffActor;

  beforeAll(async () => {
    h = await harness();
    admin = await staffActor(h.t.app, ['SUPER_ADMIN']);
  }, 120_000);

  afterAll(async () => {
    await h.drop();
  });

  it('refuses Teranga 03 in both modes when another vehicle holds its name', async () => {
    const holder = await operatorVehicle(admin, {
      code: 'OPS-003',
      name: 'Teranga 03',
      manufacturer: 'Constructeur exploitant',
      model: 'Modèle exploitant',
    });
    const before = await db(h.t.app).vehicle.findUniqueOrThrow({ where: { id: holder } });
    const demo = (report: RealisticSeedReport) =>
      report.lines
        .filter((line) => line.key === 'ET-COACH-003')
        .map(({ entity, outcome, detail }) => ({ entity, outcome, detail }));
    const expected = [
      {
        entity: 'vehicle',
        outcome: 'conflict',
        detail: 'vehicle name "Teranga 03" already belongs to OPS-003',
      },
      { entity: 'amenities', outcome: 'skipped', detail: 'depends on vehicle:ET-COACH-003' },
    ];
    expect(demo(await h.run({ dryRun: true, commerceUnavailable: 'APP_ENV=staging' }))).toEqual(
      expected,
    );
    expect(demo(await h.run({ commerceUnavailable: 'APP_ENV=staging' }))).toEqual(expected);
    expect(await db(h.t.app).vehicle.count({ where: { code: 'ET-COACH-003' } })).toBe(0);
    expect(await db(h.t.app).vehicle.findUniqueOrThrow({ where: { id: holder } })).toEqual(before);
  });
});
