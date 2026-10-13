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
  customer: { realm: 'CUSTOMER', email: 'customer.e2e@fixtures.example.test' },
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
  get auditor(): Fixture {
    return { realm: 'STAFF', email: runScoped('auditor'), roles: ['AUDITOR'] };
  },
  /** Target of the SUPER_ADMIN's role and status changes. */
  get managed(): Fixture {
    return { realm: 'STAFF', email: runScoped('managed'), roles: ['DISPATCHER'] };
  },
  get invited(): Fixture {
    return { realm: 'STAFF', email: runScoped('invited'), roles: ['DISPATCHER'], invited: true };
  },
} satisfies Record<string, Fixture>;

/** Single-use invitation token of the `invited` fixture (random per run). */
export function invitationToken(): string {
  const token = process.env.E2E_INVITATION_TOKEN;
  if (!token) throw new Error('E2E_INVITATION_TOKEN is set by global-setup.ts');
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
