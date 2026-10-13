import { createHash, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { hash } from '@node-rs/argon2';
import {
  FIXTURE_PASSWORD,
  FIXTURES,
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
  } finally {
    await db.$disconnect();
  }
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
