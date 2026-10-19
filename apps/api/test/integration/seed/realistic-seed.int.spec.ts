import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../src/authorization/audit.service.js';
import { BookingService } from '../../../src/bookings/booking.service.js';
import { PublicBookingService } from '../../../src/bookings/public-booking.service.js';
import { ContentService } from '../../../src/content/content.service.js';
import { FleetService } from '../../../src/fleet/fleet.service.js';
import { NetworkService } from '../../../src/network/network.service.js';
import { PassengerDocumentService } from '../../../src/passenger-documents/passenger-document.service.js';
import { PaymentService } from '../../../src/payments/payment.service.js';
import { PaymentWebhookService } from '../../../src/payments/payment-webhook.service.js';
import { PricingService } from '../../../src/pricing/pricing.service.js';
import { SeatMapService } from '../../../src/seat-maps/seat-map.service.js';
import {
  RealisticSeed,
  type RealisticSeedOptions,
  type RealisticSeedReport,
} from '../../../src/seed/realistic/realistic-seed.js';
import { TripService } from '../../../src/trips/trip.service.js';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const today = () => new Date().toISOString().slice(0, 10);

interface Harness {
  t: TestApp;
  drop: () => Promise<void>;
  run: (overrides?: Partial<RealisticSeedOptions>) => Promise<RealisticSeedReport>;
}

async function harness(): Promise<Harness> {
  const database = await isolatedDatabase();
  const t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  const run = (overrides: Partial<RealisticSeedOptions> = {}) =>
    new RealisticSeed({
      db: db(t.app),
      network: t.app.get(NetworkService),
      seatMaps: t.app.get(SeatMapService),
      fleet: t.app.get(FleetService),
      pricing: t.app.get(PricingService),
      trips: t.app.get(TripService),
      content: t.app.get(ContentService),
      commerce: {
        audit: t.app.get(AuditService),
        bookings: t.app.get(BookingService),
        publicBooking: t.app.get(PublicBookingService),
        passengers: t.app.get(PassengerDocumentService),
        payments: t.app.get(PaymentService),
        webhooks: t.app.get(PaymentWebhookService),
      },
    }).run({ anchorDate: today(), tripsPerDirection: 6, dryRun: false, ...overrides });
  return {
    t,
    run,
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
    expect(dry.lines.every((line) => line.outcome === 'planned')).toBe(true);
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
      new Set(['created', 'updated']),
    );
    const client = db(h.t.app);
    const vehicles = await client.vehicle.findMany({ orderBy: { code: 'asc' } });
    expect(vehicles.map((vehicle) => [vehicle.code, vehicle.name, vehicle.status])).toEqual([
      ['ET-COACH-001', 'Teranga 01', 'ACTIVE'],
      ['ET-COACH-002', 'Teranga 02', 'ACTIVE'],
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
        name: 'Teranga 01',
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

  it('is idempotent: a second run reuses everything and writes nothing', async () => {
    const before = await snapshot(h);
    const second = await h.run();
    expect(second.hasConflicts).toBe(false);
    expect(new Set(second.lines.map((line) => line.outcome))).toEqual(new Set(['existing']));
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
    expect(await db(h.t.app).authIdentity.count()).toBe(0);
    // The catalogue (public site) is still complete.
    expect(await db(h.t.app).trip.count()).toBe(12);
  });
});
