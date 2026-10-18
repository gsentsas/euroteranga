import { createHash, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { hash } from '@node-rs/argon2';
import { contentSeed } from './content-seed.js';
import {
  bookingReaderRole,
  bookingSeed,
  FIXTURE_PASSWORD,
  FIXTURES,
  networkSpecCountryCodes,
  baggageSeed,
  checkInSeed,
  complianceSeed,
  paymentSeed,
  pricingSeed,
  seatMapSeed,
  seededVehicleCode,
  tripSeed,
  type Fixture,
} from './fixtures.js';

const DAY_MS = 24 * 3_600_000;

const PREAUTHENTICATED_SESSIONS = {
  crew: 'E2E_CREW_SESSION',
  paymentCustomer: 'E2E_PAYMENT_CUSTOMER_SESSION',
  foreignCustomer: 'E2E_FOREIGN_CUSTOMER_SESSION',
  passengerDocumentReader: 'E2E_PASSENGER_DOCUMENT_READER_SESSION',
  passengerDocumentDenied: 'E2E_PASSENGER_DOCUMENT_DENIED_SESSION',
  complianceRuleManager: 'E2E_COMPLIANCE_RULE_MANAGER_SESSION',
  complianceCustomer: 'E2E_COMPLIANCE_CUSTOMER_SESSION',
  baggageCustomer: 'E2E_BAGGAGE_CUSTOMER_SESSION',
  baggageManager: 'E2E_BAGGAGE_MANAGER_SESSION',
  baggageDenied: 'E2E_BAGGAGE_DENIED_SESSION',
  checkInCustomer: 'E2E_CHECK_IN_CUSTOMER_SESSION',
  checkInReviewer: 'E2E_CHECK_IN_REVIEWER_SESSION',
  checkInAgent: 'E2E_CHECK_IN_AGENT_SESSION',
  boardingOperator: 'E2E_BOARDING_OPERATOR_SESSION',
  checkInDenied: 'E2E_CHECK_IN_DENIED_SESSION',
  permitManager: 'E2E_PERMIT_MANAGER_SESSION',
  permitReader: 'E2E_PERMIT_READER_SESSION',
  permitDenied: 'E2E_PERMIT_DENIED_SESSION',
  contentEditor: 'E2E_CONTENT_EDITOR_SESSION',
  contentDenied: 'E2E_CONTENT_DENIED_SESSION',
} as const;

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
      const sessionEnvironment = preauthenticatedSessionEnvironment(fixture);
      if (sessionEnvironment) {
        const sessionToken = randomBytes(32).toString('base64url');
        process.env[sessionEnvironment] = sessionToken;
        await db.authSession.create({
          data: {
            identityId: identity.id,
            tokenHash: new Uint8Array(createHash('sha256').update(sessionToken).digest()),
            authVersion: identity.authVersion,
            idleExpiresAt: expiresAt,
            absoluteExpiresAt: expiresAt,
          },
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
    await seedPaymentData(db);
    await seedComplianceRuleCountry(db);
    await seedComplianceData(db);
    await seedBaggageData(db);
    await seedCheckInData(db);
    await seedContentData(db);
  } finally {
    await db.$disconnect();
  }
}

/**
 * PR-11 tests exercise document ownership and RBAC, not login itself. Seed
 * their sessions directly so adding these scenarios does not consume the
 * suite-wide login-IP rate-limit budget used by the authentication tests.
 */
function preauthenticatedSessionEnvironment(fixture: Fixture): string | undefined {
  if (fixture.email === FIXTURES.crew.email) {
    return PREAUTHENTICATED_SESSIONS.crew;
  }
  if (fixture.email === FIXTURES.paymentCustomer.email) {
    return PREAUTHENTICATED_SESSIONS.paymentCustomer;
  }
  if (fixture.email === FIXTURES.customer.email) {
    return PREAUTHENTICATED_SESSIONS.foreignCustomer;
  }
  if (fixture.email === FIXTURES.passengerDocumentReader.email) {
    return PREAUTHENTICATED_SESSIONS.passengerDocumentReader;
  }
  if (fixture.email === FIXTURES.passengerDocumentDenied.email) {
    return PREAUTHENTICATED_SESSIONS.passengerDocumentDenied;
  }
  if (fixture.email === FIXTURES.complianceRuleManager.email) {
    return PREAUTHENTICATED_SESSIONS.complianceRuleManager;
  }
  if (fixture.email === FIXTURES.complianceCustomer.email) {
    return PREAUTHENTICATED_SESSIONS.complianceCustomer;
  }
  if (fixture.email === FIXTURES.baggageCustomer.email) {
    return PREAUTHENTICATED_SESSIONS.baggageCustomer;
  }
  if (fixture.email === FIXTURES.baggageManager.email) {
    return PREAUTHENTICATED_SESSIONS.baggageManager;
  }
  if (fixture.email === FIXTURES.baggageDenied.email) {
    return PREAUTHENTICATED_SESSIONS.baggageDenied;
  }
  for (const name of [
    'checkInCustomer',
    'checkInReviewer',
    'checkInAgent',
    'boardingOperator',
    'checkInDenied',
    'permitManager',
    'permitReader',
    'permitDenied',
    'contentEditor',
    'contentDenied',
  ] as const) {
    if (fixture.email === FIXTURES[name].email) return PREAUTHENTICATED_SESSIONS[name];
  }
  return undefined;
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
 * PR-10: a second scheduled trip on the booking-seed route (same seat map and
 * fare table, another date) and one CONFIRMED booking on it, paid through a
 * recorded SANDBOX event under every PostgreSQL guard (processed event,
 * succeeded attempt and confirmation in one transaction).
 */
async function seedPaymentData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const booking = bookingSeed();
  const seed = paymentSeed();
  const customer = await db.authIdentity.findUniqueOrThrow({
    where: {
      realm_normalizedEmail: {
        realm: 'CUSTOMER',
        normalizedEmail: FIXTURES.paymentCustomer.email,
      },
    },
  });
  const template = await db.trip.findUniqueOrThrow({
    where: { reference: booking.tripReference },
    include: { timings: { orderBy: { sequence: 'asc' } } },
  });
  const [origin, destination] = template.timings;
  const trip = await db.trip.create({
    data: {
      reference: seed.tripReference,
      routeVersionId: template.routeVersionId,
      seatMapVersionId: template.seatMapVersionId,
      fareTableVersionId: template.fareTableVersionId,
    },
  });
  const departure = new Date(`${seed.departureDate}T08:00:00.000Z`);
  const arrival = new Date(`${seed.departureDate}T12:00:00.000Z`);
  await db.tripWaypointTiming.createMany({
    data: [
      {
        tripId: trip.id,
        routeWaypointId: origin!.routeWaypointId,
        sequence: 1,
        plannedDepartureAt: departure,
      },
      {
        tripId: trip.id,
        routeWaypointId: destination!.routeWaypointId,
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
  const fare = await db.fareEntry.findFirstOrThrow({
    where: {
      fareTableVersionId: template.fareTableVersionId!,
      originRouteWaypointId: origin!.routeWaypointId,
      destinationRouteWaypointId: destination!.routeWaypointId,
    },
  });
  const seat = await db.seatMapCell.findFirstOrThrow({
    where: { seatMapVersionId: template.seatMapVersionId!, seatLabel: '2B' },
  });
  await db.$transaction(async (tx) => {
    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
    const held = await tx.booking.create({
      data: {
        reference: seed.confirmedBookingReference,
        customerIdentityId: customer.id,
        tripId: trip.id,
        originRouteWaypointId: origin!.routeWaypointId,
        destinationRouteWaypointId: destination!.routeWaypointId,
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
    const bookingSeat = await tx.bookingSeat.create({
      data: { bookingId: held.id, seatMapCellId: seat.id, createdAt: now },
    });
    await tx.seatInventoryLock.create({
      data: {
        bookingSeatId: bookingSeat.id,
        tripId: trip.id,
        seatMapCellId: seat.id,
        segmentSequence: 1,
      },
    });
    const payment = await tx.payment.create({
      data: {
        reference: seed.paymentReference,
        bookingId: held.id,
        customerIdentityId: customer.id,
        provider: 'SANDBOX',
        providerPaymentId: `sbx_e2e_${seed.run.toLowerCase()}`,
        amountMinor: BigInt(seed.unitAmountMinor),
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        createdAt: now,
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: payment.id,
        provider: 'SANDBOX',
        providerEventId: `evt_e2e_${seed.run.toLowerCase()}`,
        type: 'PAYMENT_SUCCEEDED',
        payloadHash: createHash('sha256').update(`synthetic e2e event ${seed.run}`).digest('hex'),
        receivedAt: now,
        processedAt: now,
      },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', succeededAt: now },
    });
    await tx.booking.update({ where: { id: held.id }, data: { confirmedAt: now } });
  });
}

/**
 * PR-12: a synthetic country from the ISO user-assigned range (X?), never a
 * real one, unused by any journey: the rule-manager scenario's synthetic rule
 * targets it and therefore changes no other scenario's evaluation.
 */
async function seedComplianceRuleCountry(
  db: ReturnType<typeof createDatabaseClient>,
): Promise<void> {
  for (let letter = 0; letter < 26; letter += 1) {
    const iso2 = `X${String.fromCharCode(65 + letter)}`;
    const iso3 = `X${String.fromCharCode(65 + letter)}R`;
    const taken = await db.country.findFirst({
      where: { OR: [{ iso2 }, { iso3 }] },
      select: { id: true },
    });
    if (taken) continue;
    await db.country.create({ data: { iso2, iso3, name: 'Pays de règle synthétique' } });
    process.env.E2E_COMPLIANCE_RULE_COUNTRY = iso2;
    return;
  }
  throw new Error('no free user-assigned country code for the compliance rule scenario');
}

interface ConfirmedBookingSeed {
  run: string;
  /** Short tag kept in the synthetic SANDBOX identifiers. */
  tag: string;
  customerEmail: string;
  tripReference: string;
  departureDate: string;
  bookingReference: string;
  paymentReference: string;
  /** Booked seat labels (default one seat, 1A); the amount is fare x seats. */
  seats?: string[];
}

/**
 * Its own SCHEDULED trip (copied from the booking template) with one
 * CONFIRMED booking of a dedicated customer on seat 1A, written under every
 * guard like the PR-10 seed. Scenarios that run in parallel never share it.
 */
async function seedConfirmedBooking(
  db: ReturnType<typeof createDatabaseClient>,
  seed: ConfirmedBookingSeed,
): Promise<{ bookingId: string; customerId: string }> {
  const booking = bookingSeed();
  const customer = await db.authIdentity.findUniqueOrThrow({
    where: {
      realm_normalizedEmail: {
        realm: 'CUSTOMER',
        normalizedEmail: seed.customerEmail,
      },
    },
  });
  const template = await db.trip.findUniqueOrThrow({
    where: { reference: booking.tripReference },
    include: { timings: { orderBy: { sequence: 'asc' } } },
  });
  const [origin, destination] = template.timings;
  const trip = await db.trip.create({
    data: {
      reference: seed.tripReference,
      routeVersionId: template.routeVersionId,
      seatMapVersionId: template.seatMapVersionId,
      fareTableVersionId: template.fareTableVersionId,
    },
  });
  const departure = new Date(`${seed.departureDate}T08:00:00.000Z`);
  const arrival = new Date(`${seed.departureDate}T12:00:00.000Z`);
  await db.tripWaypointTiming.createMany({
    data: [
      {
        tripId: trip.id,
        routeWaypointId: origin!.routeWaypointId,
        sequence: 1,
        plannedDepartureAt: departure,
      },
      {
        tripId: trip.id,
        routeWaypointId: destination!.routeWaypointId,
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
  const fare = await db.fareEntry.findFirstOrThrow({
    where: {
      fareTableVersionId: template.fareTableVersionId!,
      originRouteWaypointId: origin!.routeWaypointId,
      destinationRouteWaypointId: destination!.routeWaypointId,
    },
  });
  const cells = await Promise.all(
    (seed.seats ?? ['1A']).map((seatLabel) =>
      db.seatMapCell.findFirstOrThrow({
        where: { seatMapVersionId: template.seatMapVersionId!, seatLabel },
      }),
    ),
  );
  return db.$transaction(async (tx) => {
    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
    const held = await tx.booking.create({
      data: {
        reference: seed.bookingReference,
        customerIdentityId: customer.id,
        tripId: trip.id,
        originRouteWaypointId: origin!.routeWaypointId,
        destinationRouteWaypointId: destination!.routeWaypointId,
        originSequence: 1,
        destinationSequence: 2,
        fareEntryId: fare.id,
        unitAmountMinor: fare.amountMinor,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        createdAt: now,
        holdExpiresAt: new Date(now.getTime() + 30 * 60_000),
      },
    });
    for (const cell of cells) {
      const bookingSeat = await tx.bookingSeat.create({
        data: { bookingId: held.id, seatMapCellId: cell.id, createdAt: now },
      });
      await tx.seatInventoryLock.create({
        data: {
          bookingSeatId: bookingSeat.id,
          tripId: trip.id,
          seatMapCellId: cell.id,
          segmentSequence: 1,
        },
      });
    }
    const payment = await tx.payment.create({
      data: {
        reference: seed.paymentReference,
        bookingId: held.id,
        customerIdentityId: customer.id,
        provider: 'SANDBOX',
        providerPaymentId: `sbx_e2e_${seed.tag}_${seed.run.toLowerCase()}`,
        amountMinor: BigInt(fare.amountMinor) * BigInt(cells.length),
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        createdAt: now,
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: payment.id,
        provider: 'SANDBOX',
        providerEventId: `evt_e2e_${seed.tag}_${seed.run.toLowerCase()}`,
        type: 'PAYMENT_SUCCEEDED',
        payloadHash: createHash('sha256')
          .update(`synthetic ${seed.tag} e2e ${seed.run}`)
          .digest('hex'),
        receivedAt: now,
        processedAt: now,
      },
    });
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', succeededAt: now },
    });
    await tx.booking.update({ where: { id: held.id }, data: { confirmedAt: now } });
    return { bookingId: held.id, customerId: customer.id };
  });
}

/**
 * PR-12: a dedicated confirmed journey of the compliance customer (no seat,
 * passenger or file shared with the PR-10/PR-11 scenarios); the rule-manager
 * scenario uses an unused synthetic country (user-assigned X? code), so its
 * published rule covers no journey.
 */
async function seedComplianceData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const seed = complianceSeed();
  await seedConfirmedBooking(db, {
    ...seed,
    tag: 'cpl',
    customerEmail: FIXTURES.complianceCustomer.email,
  });
}

/**
 * PR-13: a dedicated confirmed journey of the baggage customer with one
 * synthetic traveller already on it, so the baggage scenarios share no
 * booking, passenger or bag with the PR-10/PR-11/PR-12 scenarios.
 */
/** One synthetic traveller of the booking customer, linked to the booking. */
async function seedPassenger(
  db: ReturnType<typeof createDatabaseClient>,
  booking: { bookingId: string; customerId: string },
  passenger: { reference: string; givenName: string; familyName: string },
): Promise<void> {
  // The synthetic booking-seed country (its code may have been shifted).
  const stop = await db.stop.findUniqueOrThrow({ where: { code: bookingSeed().originCode } });
  const created = await db.passenger.create({
    data: {
      ...passenger,
      ownerCustomerIdentityId: booking.customerId,
      dateOfBirth: new Date('1990-03-12T00:00:00.000Z'),
      nationalityCountryId: stop.countryId,
    },
  });
  await db.bookingPassenger.create({
    data: { bookingId: booking.bookingId, passengerId: created.id },
  });
}

/**
 * PR-14: two dedicated confirmed bookings of the check-in customer (own
 * trips, so nothing is shared with PR-10..PR-13 scenarios). Booking A has a
 * traveller to make ready and one left blocked; booking B has the traveller
 * checked in at the OPS counter and then boarded.
 */
async function seedCheckInData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const seed = checkInSeed();
  const customerEmail = FIXTURES.checkInCustomer.email;
  const a = await seedConfirmedBooking(db, {
    run: seed.run,
    tag: 'chka',
    customerEmail,
    tripReference: seed.customerTripReference,
    departureDate: '2030-07-03',
    bookingReference: seed.customerBookingReference,
    paymentReference: seed.customerPaymentReference,
    seats: ['1A', '1B'],
  });
  await seedPassenger(db, a, seed.readyPassenger);
  await seedPassenger(db, a, seed.blockedPassenger);
  const b = await seedConfirmedBooking(db, {
    run: seed.run,
    tag: 'chkb',
    customerEmail,
    tripReference: seed.counterTripReference,
    departureDate: '2030-07-04',
    bookingReference: seed.counterBookingReference,
    paymentReference: seed.counterPaymentReference,
  });
  await seedPassenger(db, b, seed.counterPassenger);

  const c = await seedConfirmedBooking(db, {
    run: seed.run,
    tag: 'chkc',
    customerEmail,
    tripReference: seed.crewTripReference,
    departureDate: '2030-07-05',
    bookingReference: seed.crewBookingReference,
    paymentReference: seed.crewPaymentReference,
  });
  await seedPassenger(db, c, seed.crewPassenger);

  const [crew, grantor, trip] = await Promise.all([
    db.authIdentity.findUniqueOrThrow({
      where: {
        realm_normalizedEmail: { realm: 'CREW', normalizedEmail: FIXTURES.crew.email },
      },
    }),
    db.authIdentity.findUniqueOrThrow({
      where: {
        realm_normalizedEmail: { realm: 'STAFF', normalizedEmail: FIXTURES.permitManager.email },
      },
    }),
    db.trip.findUniqueOrThrow({ where: { reference: seed.crewTripReference } }),
  ]);
  await db.crewTripAssignment.create({
    data: {
      tripId: trip.id,
      crewIdentityId: crew.id,
      assignedByIdentityId: grantor.id,
    },
  });
}

async function seedBaggageData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const seed = baggageSeed();
  const { bookingId, customerId } = await seedConfirmedBooking(db, {
    ...seed,
    tag: 'bag',
    customerEmail: FIXTURES.baggageCustomer.email,
  });
  // The synthetic booking-seed country (its code may have been shifted).
  const origin = await db.stop.findUniqueOrThrow({ where: { code: bookingSeed().originCode } });
  const passenger = await db.passenger.create({
    data: {
      reference: seed.passengerReference,
      ownerCustomerIdentityId: customerId,
      givenName: seed.passengerGivenName,
      familyName: seed.passengerFamilyName,
      dateOfBirth: new Date('1990-03-12T00:00:00.000Z'),
      nationalityCountryId: origin.countryId,
    },
  });
  await db.bookingPassenger.create({ data: { bookingId, passengerId: passenger.id } });
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

  // PR-17 browser fixture: a scheduled trip with no confirmed travellers.
  // The test explicitly generates an empty manifest and publishes an empty
  // permit policy before authorizing dispatch; no legal rule is inferred.
  const departureTrip = await db.trip.create({
    data: {
      reference: seed.departureTripReference,
      routeVersionId: version.id,
      vehicleId: vehicle.id,
    },
  });
  const waypoints = await db.routeWaypoint.findMany({
    where: { routeVersionId: version.id },
    orderBy: { sequence: 'asc' },
  });
  const departureAt = new Date('2030-12-01T08:00:00.000Z');
  const arrivalAt = new Date('2030-12-01T12:00:00.000Z');
  await db.tripWaypointTiming.createMany({
    data: [
      {
        tripId: departureTrip.id,
        routeWaypointId: waypoints[0]!.id,
        sequence: 1,
        plannedDepartureAt: departureAt,
      },
      {
        tripId: departureTrip.id,
        routeWaypointId: waypoints[1]!.id,
        sequence: 2,
        plannedArrivalAt: arrivalAt,
      },
    ],
  });
  await db.trip.update({
    where: { id: departureTrip.id },
    data: {
      plannedDepartureAt: departureAt,
      plannedArrivalAt: arrivalAt,
      status: 'SCHEDULED',
      scheduledAt: new Date(),
    },
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

/**
 * WEB-1: one published CMS page per run (written under every PostgreSQL
 * guard: created as DRAFT, then published), so the public website renders
 * CMS content. The home page is left unpublished: it shows the default
 * content fallback.
 */
async function seedContentData(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
  const { path, title } = contentSeed();
  const entry = await db.contentEntry.create({ data: { kind: 'PAGE', key: path } });
  const revision = await db.contentRevision.create({
    data: {
      entryId: entry.id,
      revision: 1,
      document: {
        title,
        seo: {
          description: 'Page de démonstration publiée pour les tests navigateur.',
          indexable: true,
        },
        blocks: [
          {
            type: 'richText',
            title: 'Contenu publié',
            body: [
              {
                kind: 'paragraph',
                spans: [
                  { text: 'Ce paragraphe vient du CMS. ' },
                  { text: '<b>Le balisage reste du texte.</b>', bold: true },
                ],
              },
            ],
          },
          {
            type: 'cta',
            title: 'Prêt à partir ?',
            button: { label: 'Rechercher un voyage', target: { kind: 'app', app: 'booking' } },
          },
        ],
      },
    },
  });
  await db.contentRevision.update({ where: { id: revision.id }, data: { status: 'PUBLISHED' } });
}
