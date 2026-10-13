import { createHash, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { hash } from '@node-rs/argon2';
import {
  bookingReaderRole,
  bookingSeed,
  FIXTURE_PASSWORD,
  FIXTURES,
  networkSpecCountryCodes,
  pricingSeed,
  seatMapSeed,
  seededVehicleCode,
  tripSeed,
  type Fixture,
} from './fixtures.js';

const DAY_MS = 24 * 3_600_000;

/**
 * Seeds the fixture identities before each run. STAFF fixtures start without
 * MFA but with a one-time enrollment grant (what an accepted invitation
 * gives), so the enrollment flow is exercised; the `invited` fixture is a
 * pending account with an invitation. Refuses to run against anything but a
 * disposable test database.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Browser tests need DATABASE_URL (disposable test database)');
  if (process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production') {
    throw new Error('Refusing to seed browser fixtures outside local/ci');
  }
  process.env.E2E_RUN_ID = randomBytes(4).toString('hex');
  const invitationToken = randomBytes(32).toString('base64url');
  process.env.E2E_INVITATION_TOKEN = invitationToken;

  const db = createDatabaseClient({ databaseUrl });
  try {
    // Argon2id, same parameters as the API (they are encoded in the hash).
    const passwordHash = await hash(FIXTURE_PASSWORD, {
      algorithm: 2,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    const readRole = bookingReaderRole();
    await db.authorizationRole.create({
      data: {
        key: readRole,
        name: 'Lecture réservations E2E',
        description: 'Rôle synthétique du scénario navigateur PR-09',
        realm: 'STAFF',
        system: false,
        permissions: {
          create: [{ permissionKey: 'ops.access' }, { permissionKey: 'booking.read' }],
        },
      },
    });
    const expiresAt = new Date(Date.now() + DAY_MS);
    const fixtures: Fixture[] = Object.values(FIXTURES);
    for (const fixture of fixtures) {
      // Only the non-STAFF fixtures keep a fixed address and are reset here.
      if (fixture.realm !== 'STAFF') {
        await db.authIdentity.deleteMany({
          where: { realm: fixture.realm, normalizedEmail: fixture.email },
        });
      }
      const identity = await db.authIdentity.create({
        data: {
          realm: fixture.realm,
          email: fixture.email,
          normalizedEmail: fixture.email,
          status: fixture.invited ? 'PENDING_VERIFICATION' : 'ACTIVE',
          emailVerifiedAt: fixture.invited ? null : new Date(),
          ...(fixture.invited ? {} : { passwordCredential: { create: { passwordHash } } }),
        },
      });
      for (const roleKey of fixture.roles ?? []) {
        await db.authorizationRoleAssignment.create({
          data: { identityId: identity.id, roleKey, grantReason: 'browser test fixture' },
        });
      }
      if (fixture.realm !== 'STAFF') continue;
      if (fixture.invited) {
        await db.staffInvitation.create({
          data: {
            identityId: identity.id,
            tokenHash: new Uint8Array(createHash('sha256').update(invitationToken).digest()),
            expiresAt,
          },
        });
      } else {
        await db.staffEnrollmentGrant.create({ data: { identityId: identity.id, expiresAt } });
      }
    }
    // One synthetic vehicle (no VIN, no plate) for read-only scenarios.
    await db.vehicle.create({
      data: {
        code: seededVehicleCode(),
        manufacturer: 'Constructeur synthétique',
        model: 'Lecture',
      },
    });
    await seedTripData(db);
    await seedBookingData(db);
  } finally {
    await db.$disconnect();
  }
}

/** A complete scheduled trip and one active hold, scoped to the browser-test run. */
async function seedBookingData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const seed = bookingSeed();
  const customer = await db.authIdentity.findUniqueOrThrow({
    where: {
      realm_normalizedEmail: {
        realm: 'CUSTOMER',
        normalizedEmail: FIXTURES.customer.email,
      },
    },
  });
  const start = (seed.iso2.charCodeAt(0) - 65) * 26 + (seed.iso2.charCodeAt(1) - 65);
  const reserved = networkSpecCountryCodes();
  let countryCodes: { iso2: string; iso3: string } | null = null;
  for (let offset = 0; offset < 26 * 26; offset += 1) {
    const value = (start + offset) % (26 * 26);
    const iso2 = `${String.fromCharCode(65 + Math.floor(value / 26))}${String.fromCharCode(65 + (value % 26))}`;
    const iso3 = `${iso2}Z`;
    if (iso2 === reserved.iso2 || iso3 === reserved.iso3) continue;
    const existing = await db.country.findFirst({
      where: { OR: [{ iso2 }, { iso3 }] },
      select: { id: true },
    });
    if (!existing) {
      countryCodes = { iso2, iso3 };
      break;
    }
  }
  if (!countryCodes) throw new Error('No synthetic country code available for booking tests');
  const country = await db.country.create({
    data: { ...countryCodes, name: seed.countryName },
  });
  const [origin, destination] = await Promise.all([
    db.stop.create({
      data: {
        code: seed.originCode,
        name: 'Gare de départ réservation',
        countryId: country.id,
        locality: 'Ville départ',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    }),
    db.stop.create({
      data: {
        code: seed.destinationCode,
        name: 'Gare d’arrivée réservation',
        countryId: country.id,
        locality: 'Ville arrivée',
        latitude: 2,
        longitude: 2,
        timezone: 'Etc/UTC',
      },
    }),
  ]);
  const route = await db.route.create({
    data: { code: seed.routeCode, name: seed.routeName },
  });
  const routeVersion = await db.routeVersion.create({
    data: { routeId: route.id, version: 1 },
  });
  await db.routeWaypoint.createMany({
    data: [
      {
        routeVersionId: routeVersion.id,
        sequence: 1,
        stopId: origin.id,
        boardingAllowed: true,
      },
      {
        routeVersionId: routeVersion.id,
        sequence: 2,
        stopId: destination.id,
        alightingAllowed: true,
      },
    ],
  });
  await db.routeVersion.update({
    where: { id: routeVersion.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  const [originWaypoint, destinationWaypoint] = await db.routeWaypoint.findMany({
    where: { routeVersionId: routeVersion.id },
    orderBy: { sequence: 'asc' },
  });

  const seatMap = await db.seatMap.create({
    data: { code: seed.seatMapCode, name: 'Plan réservation navigateur' },
  });
  const seatMapVersion = await db.seatMapVersion.create({
    data: { seatMapId: seatMap.id, version: 1 },
  });
  await db.seatMapCell.createMany({
    data: [
      { seatMapVersionId: seatMapVersion.id, deck: 1, row: 1, column: 1, kind: 'DRIVER' },
      {
        seatMapVersionId: seatMapVersion.id,
        deck: 1,
        row: 2,
        column: 1,
        kind: 'SEAT',
        seatLabel: '1A',
      },
      {
        seatMapVersionId: seatMapVersion.id,
        deck: 1,
        row: 2,
        column: 2,
        kind: 'SEAT',
        seatLabel: '1B',
      },
      { seatMapVersionId: seatMapVersion.id, deck: 1, row: 2, column: 3, kind: 'AISLE' },
      {
        seatMapVersionId: seatMapVersion.id,
        deck: 1,
        row: 3,
        column: 1,
        kind: 'SEAT',
        seatLabel: '2A',
      },
      {
        seatMapVersionId: seatMapVersion.id,
        deck: 1,
        row: 3,
        column: 2,
        kind: 'SEAT',
        seatLabel: '2B',
      },
    ],
  });
  await db.seatMapVersion.update({
    where: { id: seatMapVersion.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  const fareTable = await db.fareTable.create({
    data: {
      code: seed.fareTableCode,
      name: 'Tarif réservation navigateur',
      routeId: route.id,
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
    },
  });
  const fareVersion = await db.fareTableVersion.create({
    data: { fareTableId: fareTable.id, routeVersionId: routeVersion.id, version: 1 },
  });
  const fare = await db.fareEntry.create({
    data: {
      fareTableVersionId: fareVersion.id,
      originRouteWaypointId: originWaypoint!.id,
      destinationRouteWaypointId: destinationWaypoint!.id,
      amountMinor: seed.unitAmountMinor,
    },
  });
  await db.fareTableVersion.update({
    where: { id: fareVersion.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  const trip = await db.trip.create({
    data: {
      reference: seed.tripReference,
      routeVersionId: routeVersion.id,
      seatMapVersionId: seatMapVersion.id,
      fareTableVersionId: fareVersion.id,
    },
  });
  const departure = new Date(`${seed.departureDate}T08:00:00.000Z`);
  const arrival = new Date(`${seed.departureDate}T12:00:00.000Z`);
  await db.tripWaypointTiming.createMany({
    data: [
      {
        tripId: trip.id,
        routeWaypointId: originWaypoint!.id,
        sequence: 1,
        plannedDepartureAt: departure,
      },
      {
        tripId: trip.id,
        routeWaypointId: destinationWaypoint!.id,
        sequence: 2,
        plannedArrivalAt: arrival,
      },
    ],
  });
  await db.trip.update({
    where: { id: trip.id },
    data: {
      plannedDepartureAt: departure,
      plannedArrivalAt: arrival,
      status: 'SCHEDULED',
      scheduledAt: new Date(),
    },
  });

  const heldSeat = await db.seatMapCell.findFirstOrThrow({
    where: { seatMapVersionId: seatMapVersion.id, seatLabel: '2B' },
  });
  const now = new Date();
  const booking = await db.booking.create({
    data: {
      reference: seed.staffBookingReference,
      customerIdentityId: customer.id,
      tripId: trip.id,
      originRouteWaypointId: originWaypoint!.id,
      destinationRouteWaypointId: destinationWaypoint!.id,
      originSequence: 1,
      destinationSequence: 2,
      fareEntryId: fare.id,
      unitAmountMinor: seed.unitAmountMinor,
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      createdAt: now,
      holdExpiresAt: new Date(now.getTime() + 30 * 60_000),
    },
  });
  const bookingSeat = await db.bookingSeat.create({
    data: { bookingId: booking.id, seatMapCellId: heldSeat.id, createdAt: now },
  });
  await db.seatInventoryLock.create({
    data: {
      bookingSeatId: bookingSeat.id,
      tripId: trip.id,
      seatMapCellId: heldSeat.id,
      segmentSequence: 1,
      createdAt: now,
    },
  });
}

/**
 * Synthetic geography and vehicle for the trip scenarios (no real place,
 * route, plate or reference), written directly like the identities above.
 */
async function seedTripData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const seed = tripSeed();
  const country = await db.country.create({
    data: { iso2: seed.iso2, iso3: seed.iso3, name: seed.countryName },
  });
  const place = (code: string, name: string) =>
    db.stop.create({
      data: {
        code,
        name,
        countryId: country.id,
        locality: 'Localité synthétique',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
  const origin = await place(seed.originCode, 'Arrêt départ synthétique');
  const destination = await place(seed.destinationCode, 'Arrêt arrivée synthétique');
  const route = await db.route.create({ data: { code: seed.routeCode, name: seed.routeName } });
  const version = await db.routeVersion.create({ data: { routeId: route.id, version: 1 } });
  await db.routeWaypoint.createMany({
    data: [
      { routeVersionId: version.id, sequence: 1, stopId: origin.id, boardingAllowed: true },
      { routeVersionId: version.id, sequence: 2, stopId: destination.id, alightingAllowed: true },
    ],
  });
  await db.routeVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  const vehicle = await db.vehicle.create({
    data: {
      code: seed.vehicleCode,
      manufacturer: 'Constructeur synthétique',
      model: 'Autocar voyages',
    },
  });
  await db.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } });
  await db.trip.create({
    data: { reference: seed.seededTripReference, routeVersionId: version.id },
  });
  await seedSeatMapData(db, version.id);
  await seedPricingData(db, route.id, version.id);
}

/** Synthetic seat-map data (no real layout, plate or reference). */
async function seedSeatMapData(
  db: ReturnType<typeof createDatabaseClient>,
  routeVersionId: string,
): Promise<void> {
  const seed = seatMapSeed();
  const seatMap = await db.seatMap.create({
    data: { code: seed.seededSeatMapCode, name: 'Plan synthétique de lecture' },
  });
  const version = await db.seatMapVersion.create({ data: { seatMapId: seatMap.id, version: 1 } });
  await db.seatMapCell.createMany({
    data: [
      { seatMapVersionId: version.id, deck: 1, row: 1, column: 1, kind: 'DRIVER' },
      { seatMapVersionId: version.id, deck: 1, row: 2, column: 1, kind: 'SEAT', seatLabel: '1A' },
    ],
  });
  await db.seatMapVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  const vehicle = await db.vehicle.create({
    data: {
      code: seed.vehicleCode,
      manufacturer: 'Constructeur synthétique',
      model: 'Autocar plan',
    },
  });
  await db.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } });
  const trip = await db.trip.create({
    data: { reference: seed.tripReference, routeVersionId, vehicleId: vehicle.id },
  });
  const waypoints = await db.routeWaypoint.findMany({
    where: { routeVersionId },
    orderBy: { sequence: 'asc' },
  });
  const departure = new Date('2030-02-01T08:00:00Z');
  const arrival = new Date('2030-02-01T12:00:00Z');
  await db.tripWaypointTiming.createMany({
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
  await db.trip.update({
    where: { id: trip.id },
    data: { plannedDepartureAt: departure, plannedArrivalAt: arrival },
  });
}

/** Synthetic fare table and DRAFT trip on the trip-seed route (no real price). */
async function seedPricingData(
  db: ReturnType<typeof createDatabaseClient>,
  routeId: string,
  routeVersionId: string,
): Promise<void> {
  const seed = pricingSeed();
  const [origin, destination] = await db.routeWaypoint.findMany({
    where: { routeVersionId },
    orderBy: { sequence: 'asc' },
  });
  const fareTable = await db.fareTable.create({
    data: {
      code: seed.seededFareTableCode,
      name: 'Grille synthétique de lecture',
      routeId,
      currencyCode: 'XOF',
      currencyMinorUnit: 0,
    },
  });
  const version = await db.fareTableVersion.create({
    data: { fareTableId: fareTable.id, routeVersionId, version: 1 },
  });
  await db.fareEntry.create({
    data: {
      fareTableVersionId: version.id,
      originRouteWaypointId: origin!.id,
      destinationRouteWaypointId: destination!.id,
      amountMinor: 15000,
    },
  });
  await db.fareTableVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  const trip = await db.trip.create({ data: { reference: seed.tripReference, routeVersionId } });
  const departure = new Date('2030-04-01T08:00:00Z');
  const arrival = new Date('2030-04-01T12:00:00Z');
  await db.tripWaypointTiming.createMany({
    data: [
      { tripId: trip.id, routeWaypointId: origin!.id, sequence: 1, plannedDepartureAt: departure },
      { tripId: trip.id, routeWaypointId: destination!.id, sequence: 2, plannedArrivalAt: arrival },
    ],
  });
  await db.trip.update({
    where: { id: trip.id },
    data: { plannedDepartureAt: departure, plannedArrivalAt: arrival },
  });
}
