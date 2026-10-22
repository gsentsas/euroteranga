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
  get crew(): Fixture {
    return { realm: 'CREW', email: runScoped('crew'), roles: ['CREW'] };
  },
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

  /**
   * PR-12: owner of the compliance journey. Separate from paymentCustomer so
   * the parallel PR-10/PR-11 scenarios never see its passengers or files.
   */
  get complianceCustomer(): Fixture {
    return { realm: 'CUSTOMER', email: runScoped('compliance-customer') };
  },
  /** PR-12: drafts, verifies and publishes synthetic regulatory rules. */
  get complianceRuleManager(): Fixture {
    return {
      realm: 'STAFF',
      email: runScoped('compliance-rule-manager'),
      roles: ['DIRECTOR'],
    };
  },

  /** PR-13: owner of the baggage journey (dedicated booking and traveller). */
  get baggageCustomer(): Fixture {
    return { realm: 'CUSTOMER', email: runScoped('baggage-customer') };
  },
  /** PR-13: baggage.read and baggage.manage, without any booking permission. */
  get baggageManager(): Fixture {
    return { realm: 'STAFF', email: runScoped('baggage-manager'), roles: ['DISPATCHER'] };
  },
  /** PR-13: compliance and passenger-document reads, but no baggage permission. */
  get baggageDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('baggage-denied'), roles: ['COMPLIANCE_AGENT'] };
  },

  /** PR-14: owner of the two dedicated check-in bookings. */
  get checkInCustomer(): Fixture {
    return { realm: 'CUSTOMER', email: runScoped('check-in-customer') };
  },
  /** PR-14: makes a synthetic traveller compliant by a reasoned human review. */
  get checkInReviewer(): Fixture {
    return {
      realm: 'STAFF',
      email: runScoped('check-in-reviewer'),
      roles: ['COMPLIANCE_AGENT'],
    };
  },
  /** PR-14: counter check-in (checkin.manage) without boarding.scan. */
  get checkInAgent(): Fixture {
    return { realm: 'STAFF', email: runScoped('check-in-agent'), roles: ['BOOKING_AGENT'] };
  },
  /** PR-14: boards by QR scan (boarding.scan). */
  get boardingOperator(): Fixture {
    return { realm: 'STAFF', email: runScoped('boarding-operator'), roles: ['DISPATCHER'] };
  },
  /** PR-14: OPS access through FINANCE, but no check-in or boarding permission. */
  get checkInDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('check-in-denied'), roles: ['FINANCE'] };
  },

  /** PR-16: administers synthetic operational permits. */
  /** CMS-2: content.read + content.manage, without seo.manage. */
  get contentEditor(): Fixture {
    return { realm: 'STAFF', email: runScoped('content-editor'), roles: ['CONTENT_EDITOR'] };
  },
  /** ops.access without any content permission. */
  get contentDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('content-denied'), roles: ['DISPATCHER'] };
  },
  /** MEDIA-1: content.* and media.*, its own session (parallel to the CMS-2 scenarios). */
  get mediaEditor(): Fixture {
    return { realm: 'STAFF', email: runScoped('media-editor'), roles: ['CONTENT_EDITOR'] };
  },
  get permitManager(): Fixture {
    return { realm: 'STAFF', email: runScoped('permit-manager'), roles: ['OPS_MANAGER'] };
  },
  /** PR-16: reads permits for dispatch without being allowed to change them. */
  get permitReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('permit-reader'), roles: ['DISPATCHER'] };
  },
  /** PR-16: has OPS access through FINANCE, but no permit permission. */
  get permitDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('permit-denied'), roles: ['FINANCE'] };
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
  | 'crew'
  | 'paymentCustomer'
  | 'foreignCustomer'
  | 'passengerDocumentReader'
  | 'passengerDocumentDenied'
  | 'complianceRuleManager'
  | 'complianceCustomer'
  | 'baggageCustomer'
  | 'baggageManager'
  | 'baggageDenied'
  | 'checkInCustomer'
  | 'checkInReviewer'
  | 'checkInAgent'
  | 'boardingOperator'
  | 'checkInDenied'
  | 'permitManager'
  | 'permitReader'
  | 'permitDenied'
  | 'contentEditor'
  | 'contentDenied'
  | 'mediaEditor';

const preauthenticatedSessionEnvironment: Record<PreauthenticatedFixture, string> = {
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
  mediaEditor: 'E2E_MEDIA_EDITOR_SESSION',
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
    supportVehicleCode: `VH_SUPPORT_${run}`,
    supportVehicleLabel: 'Constructeur synthétique Fourgon support',
    seededTripReference: `ET-TEST-SEED-${run}`,
    departureTripReference: `ET-TEST-DEP-${run}`,
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
/**
 * PR-12: a dedicated trip and confirmed booking of a dedicated customer (so
 * the compliance scenarios share no seat, passenger or file with the
 * PR-10/PR-11 scenarios that run in parallel), and a
 * synthetic country reserved for the rule-manager scenario's rule.
 */
export function complianceSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const ruleCountry = process.env.E2E_COMPLIANCE_RULE_COUNTRY;
  if (!ruleCountry) throw new Error('E2E_COMPLIANCE_RULE_COUNTRY is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    tripReference: `ET-CPL-${run}`,
    departureDate: '2030-07-01',
    bookingReference: `ETB-E2E2${run}`,
    paymentReference: `ETP-E2E2${run}`,
    ruleCountry,
  };
}

/**
 * PR-13: a dedicated trip and confirmed booking of the baggage customer, with
 * one synthetic traveller already linked to it.
 */
export function baggageSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    tripReference: `ET-BAG-${run}`,
    departureDate: '2030-07-02',
    bookingReference: `ETB-E2E3${run}`,
    paymentReference: `ETP-E2E3${run}`,
    passengerReference: `ETV-E2E3${run}`,
    passengerGivenName: 'Coumba',
    passengerFamilyName: 'Bagages',
  };
}

/**
 * PR-14: two dedicated trips and confirmed bookings of the check-in customer.
 * Booking A (two seats): a traveller made ready, one left blocked. Booking B:
 * the traveller checked in at the counter and boarded.
 */
export function checkInSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  return {
    run,
    customerTripReference: `ET-CHKA-${run}`,
    customerBookingReference: `ETB-E2E4${run}`,
    customerPaymentReference: `ETP-E2E4${run}`,
    counterTripReference: `ET-CHKB-${run}`,
    counterBookingReference: `ETB-E2E5${run}`,
    counterPaymentReference: `ETP-E2E5${run}`,
    crewTripReference: `ET-CHKC-${run}`,
    crewBookingReference: `ETB-E2E6${run}`,
    crewPaymentReference: `ETP-E2E6${run}`,
    readyPassenger: { reference: `ETV-E2E4${run}`, givenName: 'Aminata', familyName: 'Prête' },
    blockedPassenger: { reference: `ETV-E2E5${run}`, givenName: 'Babacar', familyName: 'Bloqué' },
    counterPassenger: { reference: `ETV-E2E6${run}`, givenName: 'Coura', familyName: 'Comptoir' },
    crewPassenger: { reference: `ETV-E2E7${run}`, givenName: 'Daba', familyName: 'Equipage' },
  };
}

/**
 * PR-16: data-driven, entirely synthetic permit data. The permit targets the
 * existing synthetic trip and expresses no real legal requirement.
 */
export function permitSeed() {
  const raw = process.env.E2E_RUN_ID;
  if (!raw) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  const run = raw.toUpperCase();
  const year = new Date().getUTCFullYear();
  return {
    run,
    permitType: `SYNTHETIC_${run}`,
    title: `Autorisation synthétique E2E ${run}`,
    updatedTitle: `Autorisation synthétique E2E ${run} révisée`,
    issuingAuthority: 'Autorité synthétique de test',
    authorityReference: `SYN-E2E-${run}`,
    tripReference: tripSeed().seededTripReference,
    validFrom: `${year - 1}-01-01`,
    validUntil: `${year + 1}-12-31`,
    sourceUrl: `https://regulations.example.test/permits/${raw}`,
    sourceCheckedOn: `${year - 1}-01-15`,
    notes: 'Donnée synthétique réservée au scénario navigateur PR-16.',
    revocationReason: 'Révocation synthétique du scénario navigateur PR-16.',
  };
}

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
