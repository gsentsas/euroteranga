import { randomInt } from 'node:crypto';
import { renderSVG } from 'uqr';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';
import { fingerprint, type CanonicalValue } from '../compliance/canonical-json.js';
import type { ComplianceStatus } from '../compliance/compliance.dto.js';

/** Version of the deterministic passenger check-in readiness derivation. */
export const READINESS_ENGINE_VERSION = 'checkin-readiness/1';

export const CHECK_IN_REFERENCE_PATTERN = /^ETK-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const BOARDING_REFERENCE_PATTERN = /^ETE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const CREDENTIAL_REFERENCE_PATTERN = /^ETQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;
/** Versioned, PII-free boarding credential payload: ETPAX1:<credential>. */
export const BOARDING_QR_PATTERN = /^ETPAX1:(ETQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16})$/;
/** Operational metadata only (PR-18 owns device enrollment): no identity proof. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Same format as seat_map_cell.seat_label (PR-07). */
export const SEAT_LABEL_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,7}$/;

function randomBody(length: number, random: (max: number) => number): string {
  let body = '';
  for (let index = 0; index < length; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return body;
}

const csprng = (max: number) => randomInt(max);

/** 60 bits of CSPRNG entropy each; never derived from a database id. */
export const generateCheckInReference = (random = csprng) => `ETK-${randomBody(12, random)}`;
export const generateBoardingReference = (random = csprng) => `ETE-${randomBody(12, random)}`;
/** 80 bits: the credential is what a printed or displayed QR identifies. */
export const generateCredentialReference = (random = csprng) => `ETQ-${randomBody(16, random)}`;

const normalized = (pattern: RegExp) => (value: string) => {
  const reference = value.trim().toUpperCase();
  return pattern.test(reference) ? reference : null;
};
export const normalizeCheckInReference = normalized(CHECK_IN_REFERENCE_PATTERN);
export const normalizeSeatLabel = normalized(SEAT_LABEL_PATTERN);

export function boardingQrPayload(credentialReference: string): string {
  if (!CREDENTIAL_REFERENCE_PATTERN.test(credentialReference)) {
    throw new Error('invalid boarding credential reference');
  }
  return `ETPAX1:${credentialReference}`;
}

/** The credential reference of a supported payload, or null. Grants nothing. */
export function parseBoardingQrPayload(value: string): string | null {
  return value.trim().toUpperCase().match(BOARDING_QR_PATTERN)?.[1] ?? null;
}

export const BOARDING_QR_RENDER_OPTIONS = {
  ecc: 'M',
  boostEcc: true,
  border: 4,
  pixelSize: 6,
  blackColor: '#111827',
  whiteColor: '#ffffff',
} as const;

/** Local SVG rendering (no network service) of the versioned payload only. */
export function renderBoardingQrSvg(credentialReference: string): string {
  return renderSVG(boardingQrPayload(credentialReference), BOARDING_QR_RENDER_OPTIONS);
}

export function normalizeDeviceId(value: string): string | null {
  const device = value.trim();
  return DEVICE_ID_PATTERN.test(device) ? device : null;
}

export type ReadinessCheck =
  'BOOKING' | 'PAYMENT' | 'DOCUMENTS' | 'COMPLIANCE' | 'SEAT' | 'BAGGAGE';
export const READINESS_CHECKS: readonly ReadinessCheck[] = [
  'BOOKING',
  'PAYMENT',
  'DOCUMENTS',
  'COMPLIANCE',
  'SEAT',
  'BAGGAGE',
];

export type CheckStatus = 'PASS' | 'BLOCKED' | 'PENDING_REVIEW';

/** Stable codes: the API and the UIs only map them to text. */
export const BLOCKER_STATUS = {
  BOOKING_NOT_CONFIRMED: 'BLOCKED',
  BOOKING_CANCELLED: 'BLOCKED',
  TRIP_NOT_SCHEDULED: 'BLOCKED',
  PAYMENT_NOT_SUCCEEDED: 'BLOCKED',
  DOCUMENTS_NOT_VERIFIED: 'BLOCKED',
  DOCUMENTS_NOT_ACCEPTED: 'BLOCKED',
  DOCUMENTS_INCOMPLETE: 'BLOCKED',
  DOCUMENTS_REVIEW_REQUIRED: 'PENDING_REVIEW',
  COMPLIANCE_MISSING: 'BLOCKED',
  COMPLIANCE_STALE: 'BLOCKED',
  COMPLIANCE_REVIEW_REQUIRED: 'PENDING_REVIEW',
  COMPLIANCE_NEEDS_INFORMATION: 'BLOCKED',
  COMPLIANCE_NON_COMPLIANT: 'BLOCKED',
  SEAT_NOT_ASSIGNED: 'BLOCKED',
  SEAT_RELEASED: 'BLOCKED',
  BAGGAGE_EXCEPTION_ACTIVE: 'PENDING_REVIEW',
} as const satisfies Record<string, Exclude<CheckStatus, 'PASS'>>;
export type BlockerCode = keyof typeof BLOCKER_STATUS;

export interface Blocker {
  check: ReadinessCheck;
  code: BlockerCode;
  /** Business reference the blocker is about (a bag), never an internal id. */
  reference?: string;
}

/** Problem leaf findings of a current compliance evaluation (PR-12 codes). */
const DOCUMENT_PROBLEMS = new Set([
  'DOCUMENT_MISSING',
  'DOCUMENT_VALIDITY_TOO_SHORT',
  'DOCUMENT_EXPIRY_UNKNOWN',
  'DOCUMENT_REQUIRES_HUMAN_CHECK',
]);

/** Server-derived facts of one BookingPassenger. Nothing comes from a browser. */
export interface ReadinessFacts {
  booking: { reference: string; confirmed: boolean; cancelled: boolean };
  trip: { reference: string; status: 'DRAFT' | 'SCHEDULED' | 'CANCELLED' };
  /** Reference of the booking's SUCCEEDED payment (PR-10: at most one). */
  payment: { reference: string } | null;
  seat: { bookingSeatId: string; label: string; released: boolean } | null;
  compliance: {
    /** PR-12 status (staleness already recomputed by the PR-12 service). */
    status: ComplianceStatus;
    evaluation: {
      id: string;
      reference: string;
      engineVersion: string;
      factsFingerprint: string;
      rulesFingerprint: string;
    } | null;
    review: { id: string; decision: 'COMPLIANT' | 'NON_COMPLIANT' | 'NEEDS_INFORMATION' } | null;
    /** Evidence documents of the current evaluation with their technical status. */
    evidence: Array<{ reference: string; status: 'QUARANTINED' | 'ACCEPTED' | 'REJECTED' }>;
    /** Leaf finding codes of non-passing results of the current evaluation. */
    findingCodes: string[];
  };
  /** Every bag of the BookingPassenger (REMOVED included; it is ignored). */
  baggage: Array<{
    reference: string;
    lifecycleStatus: string;
    exceptionStatus: string | null;
  }>;
}

export interface Readiness {
  engineVersion: string;
  eligible: boolean;
  checks: Array<{ check: ReadinessCheck; status: CheckStatus; blockers: BlockerCode[] }>;
  blockers: Blocker[];
}

const blocker = (check: ReadinessCheck, code: BlockerCode, reference?: string): Blocker =>
  reference ? { check, code, reference } : { check, code };

function complianceBlockers(facts: ReadinessFacts): Blocker[] {
  switch (facts.compliance.status) {
    case 'COMPLIANT':
    case 'COMPLIANT_BY_RULES':
      return [];
    case 'NOT_EVALUATED':
      return [blocker('COMPLIANCE', 'COMPLIANCE_MISSING')];
    case 'STALE':
      return [blocker('COMPLIANCE', 'COMPLIANCE_STALE')];
    case 'REVIEW_REQUIRED':
      return [blocker('COMPLIANCE', 'COMPLIANCE_REVIEW_REQUIRED')];
    case 'NEEDS_INFORMATION':
      return [blocker('COMPLIANCE', 'COMPLIANCE_NEEDS_INFORMATION')];
    case 'NON_COMPLIANT':
    case 'NON_COMPLIANT_BY_RULES':
      return [blocker('COMPLIANCE', 'COMPLIANCE_NON_COMPLIANT')];
  }
}

/**
 * Documents are never re-judged here (no passport or visa rule in PR-14):
 * the current PR-12 evaluation decides what is required, and its evidence
 * must still be technically ACCEPTED. A rule with NO_DOCUMENT_REQUIRED passes
 * without any file; a human COMPLIANT review settles document findings.
 */
function documentBlockers(facts: ReadinessFacts): Blocker[] {
  const { compliance } = facts;
  if (compliance.status === 'NOT_EVALUATED' || compliance.status === 'STALE') {
    return [blocker('DOCUMENTS', 'DOCUMENTS_NOT_VERIFIED')];
  }
  if (compliance.evidence.some((document) => document.status !== 'ACCEPTED')) {
    return [blocker('DOCUMENTS', 'DOCUMENTS_NOT_ACCEPTED')];
  }
  if (compliance.review?.decision === 'COMPLIANT') return [];
  const problems = compliance.findingCodes.filter((code) => DOCUMENT_PROBLEMS.has(code));
  if (problems.length === 0) return [];
  return problems.every((code) => code === 'DOCUMENT_REQUIRES_HUMAN_CHECK')
    ? [blocker('DOCUMENTS', 'DOCUMENTS_REVIEW_REQUIRED')]
    : [blocker('DOCUMENTS', 'DOCUMENTS_INCOMPLETE')];
}

/**
 * Pure, deterministic aggregation of the six PR-14 gates. Eligible only when
 * no gate reports a blocker; there is no override input.
 */
export function deriveReadiness(facts: ReadinessFacts): Readiness {
  const blockers: Blocker[] = [];
  if (facts.booking.cancelled) blockers.push(blocker('BOOKING', 'BOOKING_CANCELLED'));
  if (!facts.booking.confirmed) blockers.push(blocker('BOOKING', 'BOOKING_NOT_CONFIRMED'));
  if (facts.trip.status !== 'SCHEDULED') blockers.push(blocker('BOOKING', 'TRIP_NOT_SCHEDULED'));
  if (!facts.payment) blockers.push(blocker('PAYMENT', 'PAYMENT_NOT_SUCCEEDED'));
  blockers.push(...documentBlockers(facts));
  blockers.push(...complianceBlockers(facts));
  if (!facts.seat) blockers.push(blocker('SEAT', 'SEAT_NOT_ASSIGNED'));
  else if (facts.seat.released) blockers.push(blocker('SEAT', 'SEAT_RELEASED'));
  for (const bag of facts.baggage) {
    // REMOVED is history; an active exception needs a decision first.
    if (bag.lifecycleStatus !== 'REMOVED' && bag.exceptionStatus !== null) {
      blockers.push(blocker('BAGGAGE', 'BAGGAGE_EXCEPTION_ACTIVE', bag.reference));
    }
  }
  const checks = READINESS_CHECKS.map((check) => {
    const codes = blockers.filter((item) => item.check === check).map((item) => item.code);
    const status: CheckStatus = codes.some((code) => BLOCKER_STATUS[code] === 'BLOCKED')
      ? 'BLOCKED'
      : codes.length > 0
        ? 'PENDING_REVIEW'
        : 'PASS';
    return { check, status, blockers: codes };
  });
  return {
    engineVersion: READINESS_ENGINE_VERSION,
    eligible: blockers.length === 0,
    checks,
    blockers,
  };
}

/**
 * Fingerprint of every fact that can change the authorization: booking, trip,
 * payment, seat, current compliance identity and review, evidence status and
 * blocking bags. A bag moving REGISTERED → LOADED without an exception does
 * not change it.
 */
export function readinessFingerprint(facts: ReadinessFacts): string {
  const blocking = facts.baggage
    .filter((bag) => bag.lifecycleStatus !== 'REMOVED' && bag.exceptionStatus !== null)
    .map((bag) => ({ reference: bag.reference, exception: bag.exceptionStatus }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
  const value: CanonicalValue = {
    engine: READINESS_ENGINE_VERSION,
    booking: facts.booking,
    trip: facts.trip,
    payment: facts.payment?.reference ?? null,
    seat: facts.seat ? { id: facts.seat.bookingSeatId, released: facts.seat.released } : null,
    compliance: {
      status: facts.compliance.status,
      evaluation: facts.compliance.evaluation
        ? {
            reference: facts.compliance.evaluation.reference,
            engine: facts.compliance.evaluation.engineVersion,
            facts: facts.compliance.evaluation.factsFingerprint,
            rules: facts.compliance.evaluation.rulesFingerprint,
          }
        : null,
      review: facts.compliance.review
        ? { id: facts.compliance.review.id, decision: facts.compliance.review.decision }
        : null,
    },
    evidence: [...facts.compliance.evidence]
      .map((document) => ({ reference: document.reference, status: document.status }))
      .sort((a, b) => a.reference.localeCompare(b.reference)),
    baggage: blocking,
  };
  return fingerprint(value);
}

/**
 * Minimized proof of why a check-in was allowed: references, statuses and
 * codes only — no name, birth date, document number, file or raw facts.
 */
export function readinessSnapshot(facts: ReadinessFacts, readiness: Readiness) {
  return {
    engineVersion: readiness.engineVersion,
    booking: facts.booking,
    trip: facts.trip,
    payment: facts.payment,
    seat: facts.seat ? { label: facts.seat.label } : null,
    compliance: {
      status: facts.compliance.status,
      evaluationReference: facts.compliance.evaluation?.reference ?? null,
      reviewDecision: facts.compliance.review?.decision ?? null,
    },
    documents: facts.compliance.evidence.map(({ reference, status }) => ({ reference, status })),
    baggage: {
      active: facts.baggage.filter((bag) => bag.lifecycleStatus !== 'REMOVED').length,
      blocking: readiness.blockers
        .filter((item) => item.check === 'BAGGAGE')
        .map((item) => item.reference ?? null),
    },
    checks: readiness.checks.map(({ check, status }) => ({ check, status })),
  };
}

/** Idempotency fingerprint of one boarding scan (replays must be identical). */
export function boardingPayloadFingerprint(input: {
  credentialReference: string;
  deviceId: string;
  occurredAt: Date;
}): string {
  return fingerprint({
    credential: input.credentialReference,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt.toISOString(),
  });
}

export async function withFreshReferences<T>(
  attempt: () => Promise<T>,
  collision: (error: unknown) => boolean,
): Promise<T> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index === 2 || !collision(error)) throw error;
    }
  }
  throw new Error('unreachable');
}
