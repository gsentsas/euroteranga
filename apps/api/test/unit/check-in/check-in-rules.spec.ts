import { renderSVG } from 'uqr';
import { describe, expect, it } from 'vitest';
import {
  BOARDING_QR_RENDER_OPTIONS,
  BOARDING_REFERENCE_PATTERN,
  boardingPayloadFingerprint,
  boardingQrPayload,
  CHECK_IN_REFERENCE_PATTERN,
  CREDENTIAL_REFERENCE_PATTERN,
  deriveReadiness,
  generateBoardingReference,
  generateCheckInReference,
  generateCredentialReference,
  normalizeCheckInReference,
  normalizeDeviceId,
  normalizeSeatLabel,
  parseBoardingQrPayload,
  readinessFingerprint,
  readinessSnapshot,
  renderBoardingQrSvg,
  type ReadinessFacts,
} from '../../../src/check-in/check-in-rules.js';

const ready = (): ReadinessFacts => ({
  booking: { reference: 'ETB-0123456789AB', confirmed: true, cancelled: false },
  trip: { reference: 'ET-TEST-CHECKIN', status: 'SCHEDULED' },
  payment: { reference: 'ETP-0123456789AB' },
  seat: { bookingSeatId: 'seat-1', label: '1A', released: false },
  compliance: {
    status: 'COMPLIANT_BY_RULES',
    evaluation: {
      id: 'evaluation-1',
      reference: 'ETCE-0123456789AB',
      engineVersion: 'compliance-engine/1',
      factsFingerprint: 'f'.repeat(64),
      rulesFingerprint: 'r'.repeat(64),
    },
    review: null,
    evidence: [{ reference: 'ETD-0123456789AB', status: 'ACCEPTED' }],
    findingCodes: [],
  },
  baggage: [],
});

const codes = (facts: ReadinessFacts) => deriveReadiness(facts).blockers.map((item) => item.code);

describe('check-in identities and the boarding QR', () => {
  it('generates opaque CSPRNG references in fixed formats', () => {
    expect(generateCheckInReference(() => 31)).toBe('ETK-ZZZZZZZZZZZZ');
    expect(generateBoardingReference(() => 0)).toBe('ETE-000000000000');
    expect(generateCredentialReference(() => 10)).toBe('ETQ-AAAAAAAAAAAAAAAA');
    expect(generateCheckInReference()).toMatch(CHECK_IN_REFERENCE_PATTERN);
    expect(generateBoardingReference()).toMatch(BOARDING_REFERENCE_PATTERN);
    expect(generateCredentialReference()).toMatch(CREDENTIAL_REFERENCE_PATTERN);
    expect(new Set(Array.from({ length: 50 }, () => generateCredentialReference())).size).toBe(50);
    expect(normalizeCheckInReference(' etk-0123456789ab ')).toBe('ETK-0123456789AB');
    expect(normalizeCheckInReference('ETK-ILOU01234567')).toBeNull();
  });

  it('parses only the versioned PII-free payload ETPAX1:<credential>', () => {
    const credential = 'ETQ-0123456789ABCDEF';
    const payload = boardingQrPayload(credential);
    expect(payload).toBe(`ETPAX1:${credential}`);
    expect(parseBoardingQrPayload(`  ${payload.toLowerCase()} `)).toBe(credential);
    for (const invalid of [
      credential,
      `ETPAX2:${credential}`,
      `ETPAX1:${credential}:Awa`,
      'ETPAX1:ETQ-0123456789ABCDE',
      'ETPAX1:ETK-0123456789AB',
      'ETG1:ETG-0123456789AB',
      '',
    ]) {
      expect(parseBoardingQrPayload(invalid), invalid).toBeNull();
    }
    expect(() => boardingQrPayload('ETB-0123456789AB')).toThrow('invalid boarding credential');
    expect(payload).not.toMatch(/ETB-|ETV-|@|1A|awa/iu);
  });

  it('renders locally the SVG of exactly the versioned payload, nothing more', () => {
    const credential = 'ETQ-0123456789ABCDEF';
    const svg = renderBoardingQrSvg(credential);
    expect(svg).toBe(renderSVG(`ETPAX1:${credential}`, BOARDING_QR_RENDER_OPTIONS));
    expect(svg).not.toBe(renderSVG(`ETPAX1:${credential}:Awa Ndiaye`, BOARDING_QR_RENDER_OPTIONS));
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|href=/iu);
  });

  it('accepts only bounded operational device ids and seat labels', () => {
    expect(normalizeDeviceId('  gate-01  ')).toBe('gate-01');
    expect(normalizeDeviceId('Scanner_A:3.2')).toBe('Scanner_A:3.2');
    for (const invalid of ['', '-gate', 'gate 01', 'x'.repeat(65), 'gate\u0000', 'é-gate']) {
      expect(normalizeDeviceId(invalid), JSON.stringify(invalid)).toBeNull();
    }
    expect(normalizeSeatLabel(' 1a ')).toBe('1A');
    expect(normalizeSeatLabel('12-B')).toBe('12-B');
    expect(normalizeSeatLabel('1A;DROP')).toBeNull();
  });
});

describe('check-in readiness gates', () => {
  it('is eligible only when the six gates pass, in a stable order', () => {
    const readiness = deriveReadiness(ready());
    expect(readiness).toEqual({
      engineVersion: 'checkin-readiness/1',
      eligible: true,
      blockers: [],
      checks: ['BOOKING', 'PAYMENT', 'DOCUMENTS', 'COMPLIANCE', 'SEAT', 'BAGGAGE'].map((check) => ({
        check,
        status: 'PASS',
        blockers: [],
      })),
    });
  });

  it.each([
    [
      'cancelled booking',
      (f: ReadinessFacts) => (f.booking.cancelled = true),
      ['BOOKING_CANCELLED'],
    ],
    [
      'unconfirmed booking',
      (f: ReadinessFacts) => (f.booking.confirmed = false),
      ['BOOKING_NOT_CONFIRMED'],
    ],
    [
      'trip not scheduled',
      (f: ReadinessFacts) => (f.trip.status = 'CANCELLED'),
      ['TRIP_NOT_SCHEDULED'],
    ],
    ['no succeeded payment', (f: ReadinessFacts) => (f.payment = null), ['PAYMENT_NOT_SUCCEEDED']],
    ['no seat', (f: ReadinessFacts) => (f.seat = null), ['SEAT_NOT_ASSIGNED']],
    ['released seat', (f: ReadinessFacts) => (f.seat!.released = true), ['SEAT_RELEASED']],
  ] as const)('blocks on %s', (_name, change, expected) => {
    const facts = ready();
    change(facts);
    expect(codes(facts)).toEqual(expected);
    expect(deriveReadiness(facts).eligible).toBe(false);
  });

  it.each([
    ['NOT_EVALUATED', ['DOCUMENTS_NOT_VERIFIED', 'COMPLIANCE_MISSING']],
    ['STALE', ['DOCUMENTS_NOT_VERIFIED', 'COMPLIANCE_STALE']],
    ['REVIEW_REQUIRED', ['COMPLIANCE_REVIEW_REQUIRED']],
    ['NEEDS_INFORMATION', ['COMPLIANCE_NEEDS_INFORMATION']],
    ['NON_COMPLIANT', ['COMPLIANCE_NON_COMPLIANT']],
    ['NON_COMPLIANT_BY_RULES', ['COMPLIANCE_NON_COMPLIANT']],
    ['COMPLIANT', []],
    ['COMPLIANT_BY_RULES', []],
  ] as const)('maps the PR-12 status %s without re-judging it', (status, expected) => {
    const facts = ready();
    facts.compliance.status = status;
    expect(codes(facts)).toEqual(expected);
  });

  it('reports a staff review as pending, never as a customer action', () => {
    const facts = ready();
    facts.compliance.status = 'REVIEW_REQUIRED';
    expect(deriveReadiness(facts).checks[3]).toEqual({
      check: 'COMPLIANCE',
      status: 'PENDING_REVIEW',
      blockers: ['COMPLIANCE_REVIEW_REQUIRED'],
    });
  });

  it('uses the current evaluation for documents: no hard-coded document rule', () => {
    const missing = ready();
    missing.compliance.status = 'NON_COMPLIANT_BY_RULES';
    missing.compliance.findingCodes = ['DOCUMENT_MISSING'];
    expect(codes(missing)).toEqual(['DOCUMENTS_INCOMPLETE', 'COMPLIANCE_NON_COMPLIANT']);

    const humanCheck = ready();
    humanCheck.compliance.status = 'REVIEW_REQUIRED';
    humanCheck.compliance.findingCodes = ['DOCUMENT_REQUIRES_HUMAN_CHECK'];
    expect(deriveReadiness(humanCheck).checks[2]).toEqual({
      check: 'DOCUMENTS',
      status: 'PENDING_REVIEW',
      blockers: ['DOCUMENTS_REVIEW_REQUIRED'],
    });

    // A human COMPLIANT review settles document findings of its evaluation.
    const reviewed = ready();
    reviewed.compliance.status = 'COMPLIANT';
    reviewed.compliance.review = { id: 'review-1', decision: 'COMPLIANT' };
    reviewed.compliance.findingCodes = ['DOCUMENT_EXPIRY_UNKNOWN'];
    expect(codes(reviewed)).toEqual([]);

    // No document is needed when the rule says so; passing leaves are fine.
    const none = ready();
    none.compliance.evidence = [];
    none.compliance.findingCodes = ['NO_DOCUMENT_REQUIRED', 'DOCUMENT_PRESENT'];
    expect(codes(none)).toEqual([]);

    // Evidence that is no longer technically ACCEPTED is never valid proof.
    for (const status of ['QUARANTINED', 'REJECTED'] as const) {
      const unusable = ready();
      unusable.compliance.evidence = [{ reference: 'ETD-0123456789AB', status }];
      expect(codes(unusable), status).toEqual(['DOCUMENTS_NOT_ACCEPTED']);
    }
  });

  it('blocks on active baggage exceptions only, never on REMOVED or normal progress', () => {
    const facts = ready();
    facts.baggage = [
      { reference: 'ETG-000000000001', lifecycleStatus: 'LOADED', exceptionStatus: null },
      { reference: 'ETG-000000000002', lifecycleStatus: 'REMOVED', exceptionStatus: 'MISSING' },
      { reference: 'ETG-000000000003', lifecycleStatus: 'CHECKED_IN', exceptionStatus: 'DAMAGED' },
    ];
    const readiness = deriveReadiness(facts);
    expect(readiness.blockers).toEqual([
      { check: 'BAGGAGE', code: 'BAGGAGE_EXCEPTION_ACTIVE', reference: 'ETG-000000000003' },
    ]);
    expect(readiness.checks[5]!.status).toBe('PENDING_REVIEW');
    // A pending review still blocks: only an empty blocker list is eligible.
    expect(readiness.eligible).toBe(false);
    facts.baggage = [];
    expect(deriveReadiness(facts).eligible).toBe(true);
  });
});

describe('readiness fingerprint and snapshot', () => {
  it('changes with every authorization fact, not with harmless bag progress', () => {
    const base = readinessFingerprint(ready());
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(readinessFingerprint(ready())).toBe(base);
    const variants: Array<(facts: ReadinessFacts) => void> = [
      (f) => (f.seat!.bookingSeatId = 'seat-2'),
      (f) => (f.seat = null),
      (f) => (f.compliance.status = 'STALE'),
      (f) => (f.compliance.evaluation!.reference = 'ETCE-0123456789AC'),
      (f) => (f.compliance.evaluation!.factsFingerprint = 'e'.repeat(64)),
      (f) => (f.compliance.review = { id: 'review-1', decision: 'COMPLIANT' }),
      (f) => (f.compliance.evidence[0]!.status = 'REJECTED'),
      (f) => (f.payment = null),
      (f) => (f.booking.cancelled = true),
      (f) => (f.trip.status = 'CANCELLED'),
      (f) =>
        (f.baggage = [
          { reference: 'ETG-000000000003', lifecycleStatus: 'LOADED', exceptionStatus: 'MISSING' },
        ]),
    ];
    for (const [index, change] of variants.entries()) {
      const facts = ready();
      change(facts);
      expect(readinessFingerprint(facts), String(index)).not.toBe(base);
    }
    const progressed = ready();
    progressed.baggage = [
      { reference: 'ETG-000000000002', lifecycleStatus: 'IN_TRANSIT', exceptionStatus: null },
      { reference: 'ETG-000000000001', lifecycleStatus: 'REMOVED', exceptionStatus: 'DAMAGED' },
    ];
    expect(readinessFingerprint(progressed)).toBe(base);
  });

  it('keeps a minimized snapshot: references, statuses and codes only', () => {
    const facts = ready();
    const snapshot = readinessSnapshot(facts, deriveReadiness(facts));
    expect(snapshot).toMatchObject({
      engineVersion: 'checkin-readiness/1',
      seat: { label: '1A' },
      compliance: { status: 'COMPLIANT_BY_RULES', evaluationReference: 'ETCE-0123456789AB' },
      documents: [{ reference: 'ETD-0123456789AB', status: 'ACCEPTED' }],
      baggage: { active: 0, blocking: [] },
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['seat-1', 'evaluation-1', 'f'.repeat(64)]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fingerprints every field of a boarding replay', () => {
    const base = {
      credentialReference: 'ETQ-0123456789ABCDEF',
      deviceId: 'gate-01',
      occurredAt: new Date('2030-01-01T10:00:00.000Z'),
    };
    const fingerprint = boardingPayloadFingerprint(base);
    expect(boardingPayloadFingerprint({ ...base })).toBe(fingerprint);
    expect(boardingPayloadFingerprint({ ...base, deviceId: 'gate-02' })).not.toBe(fingerprint);
    expect(
      boardingPayloadFingerprint({ ...base, occurredAt: new Date('2030-01-01T10:00:01.000Z') }),
    ).not.toBe(fingerprint);
    expect(
      boardingPayloadFingerprint({ ...base, credentialReference: 'ETQ-0123456789ABCDEG' }),
    ).not.toBe(fingerprint);
  });
});
