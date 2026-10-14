/**
 * Synthetic identities for browser tests only. They are written directly to
 * the disposable test database by global-setup.ts; no endpoint creates them.
 */
export const FIXTURE_PASSWORD = 'synthetic browser test passphrase 0042';

type Realm = 'CUSTOMER' | 'STAFF' | 'CREW';

export interface Fixture {
  realm: Realm;
  email: string;
  /** STAFF only: roles granted at seed time (none means no `ops.access`). */
  roles?: readonly string[];
  /** STAFF only: the account is pending until the invitation is accepted. */
  invited?: boolean;
}

/**
 * STAFF fixtures get a fresh address on every run: role assignments and
 * audit events reference them and are never deleted (append-only audit),
 * so they cannot be reset in place. global-setup.ts sets E2E_RUN_ID, which
 * Playwright passes on to the test workers.
 */
function runScoped(name: string): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return `${name}.${runId}.e2e@fixtures.example.test`;
}

export const FIXTURES = {
  /** Run-scoped because booking history is deliberately immutable. */
  get customer(): Fixture {
    return { realm: 'CUSTOMER', email: runScoped('customer') };
  },
  crew: { realm: 'CREW', email: 'crew.e2e@fixtures.example.test' },
  get staff(): Fixture {
    return { realm: 'STAFF', email: runScoped('staff'), roles: ['DISPATCHER'] };
  },
  get staffWithoutAccess(): Fixture {
    return { realm: 'STAFF', email: runScoped('no-access'), roles: [] };
  },
  get superAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('super-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** Dedicated identities keep fully-parallel network scenarios independent. */
  get networkAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-admin'), roles: ['SUPER_ADMIN'] };
  },
  get networkReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-reader'), roles: ['DISPATCHER'] };
  },
  get networkDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-denied'), roles: ['FINANCE'] };
  },
  get fleetAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('fleet-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** fleet.read only. */
  get fleetReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('fleet-reader'), roles: ['DISPATCHER'] };
  },
  /** ops.access and network.read, but no fleet permission. */
  get fleetDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('fleet-denied'), roles: ['BOOKING_AGENT'] };
  },
  get tripAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('trip-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** trip.read only (no trip.manage, no fleet.read). */
  get tripReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('trip-reader'), roles: ['BOOKING_AGENT'] };
  },
  /** ops.access only: no trip permission. */
  get tripDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('trip-denied'), roles: ['FINANCE'] };
  },
  get seatMapAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('seat-map-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** seatmap.read only (no seatmap.manage). */
  get seatMapReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('seat-map-reader'), roles: ['BOOKING_AGENT'] };
  },
  /** ops.access only: no seat-map permission. */
  get seatMapDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('seat-map-denied'), roles: ['FINANCE'] };
  },
  get pricingAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('pricing-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** pricing.read only (no pricing.manage, no trip or network permission). */
  get pricingReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('pricing-reader'), roles: ['FINANCE'] };
  },
  /** trip.read but no pricing permission. */
  get pricingDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('pricing-denied'), roles: ['COMPLIANCE_AGENT'] };
  },
  get bookingAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('booking-admin'), roles: ['BOOKING_AGENT'] };
  },
  /** booking.read and ops.access, without booking.manage. */
  get bookingReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('booking-reader'), roles: [bookingReaderRole()] };
  },
  /** ops.access through FINANCE, but no booking permission. */
  get bookingDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('booking-denied'), roles: ['FINANCE'] };
  },
  get auditor(): Fixture {
    return { realm: 'STAFF', email: runScoped('auditor'), roles: ['AUDITOR'] };
  },
  /** PR-10: the customer paying through the SANDBOX provider. */
  get paymentCustomer(): Fixture {
    return { realm: 'CUSTOMER', email: runScoped('payment-customer') };
  },
  /** PR-11: can inspect private passenger documents, but cannot mutate them. */
  get passengerDocumentReader(): Fixture {
    return {
      realm: 'STAFF',
      email: runScoped('passenger-document-reader'),
      roles: ['COMPLIANCE_AGENT'],
    };
  },
  /** PR-11: has OPS access but no passenger.document.read permission. */
  get passengerDocumentDenied(): Fixture {
    return {
      realm: 'STAFF',
      email: runScoped('passenger-document-denied'),
      roles: ['BOOKING_AGENT'],
    };
  },

  /** Target of the SUPER_ADMIN's role and status changes. */
  get managed(): Fixture {
    return { realm: 'STAFF', email: runScoped('managed'), roles: ['DISPATCHER'] };
  },
  get invited(): Fixture {
    return { realm: 'STAFF', email: runScoped('invited'), roles: ['DISPATCHER'], invited: true };
  },
} satisfies Record<string, Fixture>;

/** Test-only read role created by global setup before fixture assignments. */
export function bookingReaderRole(): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return `E2E_BOOKING_READER_${runId.toUpperCase()}`;
}

/** Single-use invitation token of the `invited` fixture (random per run). */
export function invitationToken(): string {
  const token = process.env.E2E_INVITATION_TOKEN;
  if (!token) throw new Error('E2E_INVITATION_TOKEN is set by global-setup.ts');
  return token;
}

export type PreauthenticatedFixture =
  'paymentCustomer' | 'foreignCustomer' | 'passengerDocumentReader' | 'passengerDocumentDenied';

const preauthenticatedSessionEnvironment: Record<PreauthenticatedFixture, string> = {
  paymentCustomer: 'E2E_PAYMENT_CUSTOMER_SESSION',
  foreignCustomer: 'E2E_FOREIGN_CUSTOMER_SESSION',
  passengerDocumentReader: 'E2E_PASSENGER_DOCUMENT_READER_SESSION',
  passengerDocumentDenied: 'E2E_PASSENGER_DOCUMENT_DENIED_SESSION',
};

/**
 * Raw, run-scoped session created in the disposable database by global setup.
 * These fixtures keep domain E2E scenarios from consuming the shared login-IP
 * budget; the password, cookie and STAFF MFA paths remain covered by auth.spec.
 */
export function preauthenticatedSession(name: PreauthenticatedFixture): string {
  const token = process.env[preauthenticatedSessionEnvironment[name]];
  if (!token)
    throw new Error(`${preauthenticatedSessionEnvironment[name]} is set by global-setup.ts`);
  return token;
}

/** Code of the synthetic vehicle seeded for read-only scenarios. */
export function seededVehicleCode(): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return `VH_SEED_${runId.toUpperCase()}`;
}

/**
 * Synthetic network/fleet data seeded for the trip scenarios: two stops, a
 * published route version, an ACTIVE vehicle and one DRAFT trip.
 */
export function tripSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  // The network spec creates a country whose ISO codes start with
  // letter(runId[0:2]); shifting that first letter guarantees no collision.
  const networkFirst = Number.parseInt(raw.slice(0, 2), 16) % 26;
  const iso2 = `${String.fromCharCode(65 + ((networkFirst + 1) % 26))}Q`;
  return {
    run,
    iso2,
    iso3: `${iso2}Q`,
    countryName: `Pays voyages ${run}`,
    originCode: `TRS_A_${run}`,
    destinationCode: `TRS_B_${run}`,
    routeCode: `TRR_${run}`,
    routeName: `Route voyages ${run}`,
    vehicleCode: `VH_TRIP_${run}`,
    vehicleLabel: 'Constructeur synthétique Autocar voyages',
    seededTripReference: `ET-TEST-SEED-${run}`,
  };
}

/**
 * Synthetic data for the seat-map scenarios: a published seat map for the
 * read-only profile, and an ACTIVE vehicle with a DRAFT trip (complete
 * timetable) on the trip-seed route for the SUPER_ADMIN scenario.
 */
export function seatMapSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    seededSeatMapCode: `SM_SEED_${run}`,
    vehicleCode: `VH_SEAT_${run}`,
    tripReference: `ET-TEST-SEAT-${run}`,
  };
}

/**
 * Synthetic data for the pricing scenarios: a published XOF fare table on the
 * trip-seed route for the read-only profile, and a DRAFT trip (complete
 * timetable) on the same route for the SUPER_ADMIN scenario.
 */
export function pricingSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    seededFareTableCode: `FT_SEED_${run}`,
    tripReference: `ET-TEST-FARE-${run}`,
  };
}

/**
 * ISO codes the network spec creates through the UI (same formula as
 * specs/network.spec.ts): seeded countries must never take them.
 */
export function networkSpecCountryCodes(): { iso2: string; iso3: string } {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const letter = (pair: string) => String.fromCharCode(65 + (Number.parseInt(pair, 16) % 26));
  const iso2 = `${letter(raw.slice(0, 2))}${letter(raw.slice(2, 4))}`;
  return { iso2, iso3: `${iso2}${letter(raw.slice(4, 6))}` };
}

/** Fully bookable synthetic trip used only by the PR-09 browser scenarios. */
export function bookingSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  // Start two letters after the network spec's first letter (the trip seed
  // uses one); global-setup also skips the network spec's exact codes.
  const networkFirst = Number.parseInt(raw.slice(0, 2), 16) % 26;
  const iso2 = `${String.fromCharCode(65 + ((networkFirst + 2) % 26))}R`;
  return {
    run,
    iso2,
    iso3: `${iso2}R`,
    countryName: `Pays réservation ${run}`,
    originCode: `BKS_A_${run}`,
    destinationCode: `BKS_B_${run}`,
    routeCode: `BKR_${run}`,
    routeName: `Route réservation ${run}`,
    seatMapCode: `BKM_${run}`,
    fareTableCode: `BKF_${run}`,
    tripReference: `ET-BK-${run}`,
    staffBookingReference: `ETB-E2E0${run}`,
    departureDate: '2030-06-15',
    unitAmountMinor: 12_345,
  };
}

/**
 * PR-10 payment scenarios: a second trip on the booking-seed route, seat map
 * and fare table (another date, so PR-09 searches never see it), and one
 * seeded CONFIRMED booking paid through a recorded SANDBOX event for the OPS
 * scenarios. Payments are simulated: no provider is ever contacted.
 */
export function paymentSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    tripReference: `ET-PAY-${run}`,
    departureDate: '2030-06-16',
    confirmedBookingReference: `ETB-E2E1${run}`,
    paymentReference: `ETP-E2E0${run}`,
    unitAmountMinor: 12_345,
  };
}
