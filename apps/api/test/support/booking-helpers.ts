import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { client, createIdentity, csrfToken, db, loginCookie, uniqueIp } from './auth-helpers.js';

const suffix = () => randomBytes(4).toString('hex').toUpperCase();
const letters = (length: number) =>
  Array.from(randomBytes(length), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

/** A synthetic country with random ISO-like letters (retried on collision). */
export async function syntheticCountry(app: NestExpressApplication): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const iso2 = letters(2);
    const iso3 = `${iso2}${letters(1)}`;
    const taken = await db(app).country.findFirst({
      where: { OR: [{ iso2 }, { iso3 }] },
      select: { id: true },
    });
    if (taken && attempt < 50) continue;
    return (await db(app).country.create({ data: { iso2, iso3, name: 'Pays réservation' } })).id;
  }
}
const HOUR = 3_600_000;

export interface BookableFixture {
  tripId: string;
  tripReference: string;
  routeVersionId: string;
  countryId: string;
  /** Stops in route order (W1 boarding only, W5 alighting only, W2-W4 both). */
  stopIds: string[];
  /** Route waypoint ids by sequence: wp[1]..wp[5] (index 0 unused). */
  wp: string[];
  checkpointWaypointId: string | null;
  seatMapVersionId: string;
  /** SEAT cells by label (1A, 1B, 2A, 2B); non-seat cells under their kind. */
  cells: Record<string, string>;
  fareTableVersionId: string;
  /** Fare amount (minor units) of the pair origin->destination sequences. */
  fare: (origin: number, destination: number) => number;
  currencyCode: string;
  currencyMinorUnit: number;
}

export interface FixtureOptions {
  countryId?: string;
  /** Departure of the first waypoint, from now. Default: 48 h. */
  departureInMs?: number;
  currencyCode?: string;
  currencyMinorUnit?: number;
  /** Pairs left without a fare, e.g. ['2-4']. */
  unpricedPairs?: string[];
  /** Add a checkpoint between W2 and W3 (shifts W3..W5 to sequences 4..6). */
  withCheckpoint?: boolean;
  /** Leave the trip DRAFT, without seat map or without pricing. */
  status?: 'SCHEDULED' | 'DRAFT';
  withSeatMap?: boolean;
  withPricing?: boolean;
  /** Reuse these five stops (another trip on the same stop pairs). */
  stopIds?: string[];
  /** W4 reuses the stop of W1 (a loop): the same stop appears twice. */
  repeatFirstStop?: boolean;
  /** Fare amount for every pair (default: 1000 * (destination - origin)). */
  amount?: (origin: number, destination: number) => number;
}

/**
 * Synthetic, directly written network, seat map, pricing and SCHEDULED trip
 * for booking tests (no real place, layout or price).
 */
export async function bookableFixture(
  app: NestExpressApplication,
  options: FixtureOptions = {},
): Promise<BookableFixture> {
  const prisma = db(app);
  const countryId = options.countryId ?? (await syntheticCountry(app));
  const stopIds: string[] = options.stopIds ? [...options.stopIds] : [];
  for (let index = stopIds.length + 1; index <= 5; index += 1) {
    const stop = await prisma.stop.create({
      data: {
        code: `BK_${suffix()}`,
        name: `Arrêt réservation ${index}`,
        countryId,
        locality: `Localité ${index}`,
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
    stopIds.push(stop.id);
  }
  const route = await prisma.route.create({
    data: { code: `RB_${suffix()}`, name: 'Route réservation' },
  });
  const version = await prisma.routeVersion.create({ data: { routeId: route.id, version: 1 } });
  const waypoints: Array<{
    stopId?: string;
    checkpointId?: string;
    boardingAllowed?: boolean;
    alightingAllowed?: boolean;
  }> = [
    { stopId: stopIds[0]!, boardingAllowed: true },
    { stopId: stopIds[1]!, boardingAllowed: true, alightingAllowed: true },
  ];
  if (options.withCheckpoint) {
    const checkpoint = await prisma.checkpoint.create({
      data: {
        code: `CK_${suffix()}`,
        name: 'Point de contrôle',
        countryId,
        type: 'TECHNICAL',
        locality: 'L',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
    waypoints.push({ checkpointId: checkpoint.id });
  }
  waypoints.push(
    { stopId: stopIds[2]!, boardingAllowed: true, alightingAllowed: true },
    {
      stopId: options.repeatFirstStop ? stopIds[0]! : stopIds[3]!,
      boardingAllowed: true,
      alightingAllowed: true,
    },
    { stopId: stopIds[4]!, alightingAllowed: true },
  );
  await prisma.routeWaypoint.createMany({
    data: waypoints.map((waypoint, index) => ({
      routeVersionId: version.id,
      sequence: index + 1,
      ...waypoint,
    })),
  });
  await prisma.routeVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  const rows = await prisma.routeWaypoint.findMany({
    where: { routeVersionId: version.id },
    orderBy: { sequence: 'asc' },
  });
  const stopRows = rows.filter((row) => row.stopId !== null);
  const wp = ['', ...stopRows.map((row) => row.id)];
  const sequenceOf = new Map(stopRows.map((row, index) => [index + 1, row.sequence]));
  const checkpointWaypointId = rows.find((row) => row.checkpointId !== null)?.id ?? null;

  // Seat map: driver, 1A 1B / aisle / 2A 2B.
  const seatMap = await prisma.seatMap.create({
    data: { code: `SMB_${suffix()}`, name: 'Plan réservation' },
  });
  const seatVersion = await prisma.seatMapVersion.create({
    data: { seatMapId: seatMap.id, version: 1 },
  });
  await prisma.seatMapCell.createMany({
    data: [
      { seatMapVersionId: seatVersion.id, deck: 1, row: 1, column: 1, kind: 'DRIVER' },
      {
        seatMapVersionId: seatVersion.id,
        deck: 1,
        row: 2,
        column: 1,
        kind: 'SEAT',
        seatLabel: '1A',
      },
      {
        seatMapVersionId: seatVersion.id,
        deck: 1,
        row: 2,
        column: 2,
        kind: 'SEAT',
        seatLabel: '1B',
      },
      { seatMapVersionId: seatVersion.id, deck: 1, row: 2, column: 3, kind: 'AISLE' },
      {
        seatMapVersionId: seatVersion.id,
        deck: 1,
        row: 3,
        column: 1,
        kind: 'SEAT',
        seatLabel: '2A',
      },
      {
        seatMapVersionId: seatVersion.id,
        deck: 1,
        row: 3,
        column: 2,
        kind: 'SEAT',
        seatLabel: '2B',
      },
    ],
  });
  await prisma.seatMapVersion.update({
    where: { id: seatVersion.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  const cellRows = await prisma.seatMapCell.findMany({
    where: { seatMapVersionId: seatVersion.id },
  });
  const cells = Object.fromEntries(cellRows.map((cell) => [cell.seatLabel ?? cell.kind, cell.id]));

  // Pricing: every boarding -> later alighting stop pair, unless unpriced.
  const currencyCode = options.currencyCode ?? 'EUR';
  const currencyMinorUnit = options.currencyMinorUnit ?? 2;
  const amount =
    options.amount ?? ((origin: number, destination: number) => 1000 * (destination - origin));
  const fareTable = await prisma.fareTable.create({
    data: {
      code: `FTB_${suffix()}`,
      name: 'Tarif réservation',
      routeId: route.id,
      currencyCode,
      currencyMinorUnit,
    },
  });
  const fareVersion = await prisma.fareTableVersion.create({
    data: { fareTableId: fareTable.id, routeVersionId: version.id, version: 1 },
  });
  const fares = [];
  for (let origin = 1; origin <= 4; origin += 1) {
    for (let destination = Math.max(origin + 1, 2); destination <= 5; destination += 1) {
      if (options.unpricedPairs?.includes(`${origin}-${destination}`)) continue;
      fares.push({
        fareTableVersionId: fareVersion.id,
        originRouteWaypointId: wp[origin]!,
        destinationRouteWaypointId: wp[destination]!,
        amountMinor: amount(origin, destination),
      });
    }
  }
  await prisma.fareEntry.createMany({ data: fares });
  await prisma.fareTableVersion.update({
    where: { id: fareVersion.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  // Trip with a complete timetable, one hour per leg.
  const departure = Date.now() + (options.departureInMs ?? 48 * HOUR);
  const trip = await prisma.trip.create({
    data: {
      reference: `ET-TEST-BK-${suffix()}`,
      routeVersionId: version.id,
      ...(options.withSeatMap === false ? {} : { seatMapVersionId: seatVersion.id }),
      ...(options.withPricing === false ? {} : { fareTableVersionId: fareVersion.id }),
    },
    // Historical upgrade suites exercise this helper against pre-PR-17 schemas.
    // Return only fields that existed before dispatch columns were introduced.
    select: { id: true, reference: true },
  });
  const at = (index: number) => new Date(departure + index * HOUR);
  await prisma.tripWaypointTiming.createMany({
    data: rows.map((row, index) => ({
      tripId: trip.id,
      routeWaypointId: row.id,
      sequence: row.sequence,
      plannedArrivalAt: index === 0 ? null : at(index),
      plannedDepartureAt:
        index === rows.length - 1
          ? null
          : new Date(at(index).getTime() + (index === 0 ? 0 : 600_000)),
    })),
  });
  await prisma.trip.update({
    where: { id: trip.id },
    data: { plannedDepartureAt: at(0), plannedArrivalAt: at(rows.length - 1) },
    select: { id: true },
  });
  if (options.status !== 'DRAFT') {
    await prisma.trip.update({
      where: { id: trip.id },
      data: { status: 'SCHEDULED', scheduledAt: new Date() },
      select: { id: true },
    });
  }
  return {
    tripId: trip.id,
    tripReference: trip.reference,
    routeVersionId: version.id,
    countryId,
    stopIds,
    wp,
    checkpointWaypointId,
    seatMapVersionId: seatVersion.id,
    cells,
    fareTableVersionId: fareVersion.id,
    fare: (origin, destination) => amount(origin, destination),
    currencyCode,
    currencyMinorUnit,
    ...{ sequenceOf },
  };
}

export interface CustomerActor {
  id: string;
  email: string;
  cookie: string;
  http: ReturnType<typeof client>;
  csrf: () => Promise<string>;
}

/** An ACTIVE CUSTOMER with a live session (the booker). */
export async function customerActor(app: NestExpressApplication): Promise<CustomerActor> {
  const identity = await createIdentity(app, { realm: 'customer' });
  const cookie = await loginCookie(app, 'customer', identity.email);
  const http = client(app, 'customer', uniqueIp());
  return { ...identity, cookie, http, csrf: () => csrfToken(app, 'customer', cookie) };
}

/** Customer booking calls (session cookie, customer origin, CSRF on POST). */
export function bookingApi(actor: CustomerActor) {
  return {
    get: (path: string) => actor.http.get(`/v1/booking${path}`, actor.cookie),
    post: async (path: string, body: unknown = {}, options: { csrf?: string | null } = {}) => {
      const csrf = options.csrf === undefined ? await actor.csrf() : (options.csrf ?? undefined);
      return actor.http.post(`/v1/booking${path}`, body, actor.cookie, csrf);
    },
  };
}

export const holdBody = (
  fixture: BookableFixture,
  origin: number,
  destination: number,
  seats: string[],
) => ({
  tripId: fixture.tripId,
  originRouteWaypointId: fixture.wp[origin]!,
  destinationRouteWaypointId: fixture.wp[destination]!,
  seatMapCellIds: seats.map((label) => fixture.cells[label]!),
});

/**
 * A real hold whose expiry is 1.5 s away, written under every PostgreSQL
 * guard (no trigger is bypassed), then left to expire naturally: the API
 * TTL cannot be shorter than 60 s. Returns once the database clock has
 * passed the expiry.
 */
export async function expiredHold(
  app: NestExpressApplication,
  fixture: BookableFixture,
  customerIdentityId: string,
  origin: number,
  destination: number,
  seats: string[],
): Promise<{ id: string; reference: string }> {
  const prisma = db(app);
  const reference = `ETB-${Array.from({ length: 12 }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('')}`;
  const booking = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
    const now = row!.now;
    const fare = await tx.fareEntry.findUniqueOrThrow({
      where: {
        fareTableVersionId_originRouteWaypointId_destinationRouteWaypointId: {
          fareTableVersionId: fixture.fareTableVersionId,
          originRouteWaypointId: fixture.wp[origin]!,
          destinationRouteWaypointId: fixture.wp[destination]!,
        },
      },
    });
    const [originWp, destinationWp] = await Promise.all([
      tx.routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[origin]! } }),
      tx.routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[destination]! } }),
    ]);
    const created = await tx.booking.create({
      data: {
        reference,
        customerIdentityId,
        tripId: fixture.tripId,
        originRouteWaypointId: originWp.id,
        destinationRouteWaypointId: destinationWp.id,
        originSequence: originWp.sequence,
        destinationSequence: destinationWp.sequence,
        fareEntryId: fare.id,
        unitAmountMinor: fare.amountMinor,
        currencyCode: fixture.currencyCode,
        currencyMinorUnit: fixture.currencyMinorUnit,
        createdAt: now,
        holdExpiresAt: new Date(now.getTime() + 1500),
      },
    });
    for (const label of seats) {
      const seat = await tx.bookingSeat.create({
        data: { bookingId: created.id, seatMapCellId: fixture.cells[label]!, createdAt: now },
      });
      for (let segment = originWp.sequence; segment < destinationWp.sequence; segment += 1) {
        await tx.seatInventoryLock.create({
          data: {
            bookingSeatId: seat.id,
            tripId: fixture.tripId,
            seatMapCellId: seat.seatMapCellId,
            segmentSequence: segment,
          },
        });
      }
    }
    return created;
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [row] = await prisma.$queryRaw<Array<{ expired: boolean }>>`
      SELECT "hold_expires_at" <= now() AS "expired" FROM "booking" WHERE "id" = ${booking.id}::uuid`;
    if (row?.expired) return { id: booking.id, reference };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('hold did not expire');
}
