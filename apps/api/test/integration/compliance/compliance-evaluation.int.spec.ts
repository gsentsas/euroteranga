import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  acceptedDocument,
  complianceApi,
  confirmedJourney,
  country,
  coverage,
  journeyPassenger,
  publishRule,
  ruleContent,
  type Journey,
} from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** Synthetic rules and data only: no real regulatory requirement is encoded. */
describe('passenger compliance evaluation (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let manager: StaffActor;
  let nationality: { id: string; iso2: string };

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [alice, bob, manager] = await Promise.all([
      customerActor(t.app),
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
    ]);
    nationality = await country(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const evaluations = () => db(t.app).complianceEvaluation.count();

  async function subject(actor = alice, options: { departureInDays?: number } = {}) {
    const journey = await confirmedJourney(t.app, env, actor, options);
    const passenger = await journeyPassenger(actor, journey, nationality.id);
    return { journey, passenger };
  }

  it('never treats an empty rule catalogue as compliance, even with an ACCEPTED passport', async () => {
    const { journey, passenger } = await subject();
    await acceptedDocument(t.app, passenger, 'PASSPORT', '2040-01-01');
    // A client cannot supply facts or a result: the body is ignored.
    const evaluated = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(evaluated.status).toBe(200);
    expect(evaluated.body).toMatchObject({
      status: 'REVIEW_REQUIRED',
      evaluation: { result: 'REVIEW_REQUIRED', current: true, travelDate: journey.travelDate },
      findings: [
        { code: 'NO_APPLICABLE_RULE' },
        { code: 'NO_VERIFIED_COVERAGE', country: journey.transit.iso2 },
        { code: 'NO_VERIFIED_COVERAGE', country: journey.destination.iso2 },
      ],
    });
    expect(evaluated.body.status).not.toMatch(/COMPLIANT/);
    const stored = await db(t.app).complianceEvaluation.findFirstOrThrow({
      where: { reference: evaluated.body.evaluation.reference },
    });
    expect(stored.facts).toEqual({
      factsVersion: 1,
      travelDate: journey.travelDate,
      arrivalDate: expect.any(String),
      originCountry: journey.origin.iso2,
      destinationCountry: journey.destination.iso2,
      transitCountries: [journey.transit.iso2],
      nationality: nationality.iso2,
      ageOnTravelDate: expect.any(Number),
      documents: [
        { reference: expect.stringMatching(/^ETD-/), type: 'PASSPORT', expiresAt: '2040-01-01' },
      ],
    });
    expect(JSON.stringify(stored.facts)).not.toMatch(/Awa|Ndiaye|dateOfBirth|objectKey|sha256/);
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'COMPLIANCE_EVALUATED', resourceId: stored.id, actorIdentityId: alice.id },
    });
    expect(audit.after).toMatchObject({
      reference: stored.reference,
      result: 'REVIEW_REQUIRED',
      engineVersion: 'compliance-engine/1',
      ruleVersions: [],
      findings: ['NO_APPLICABLE_RULE', 'NO_VERIFIED_COVERAGE', 'NO_VERIFIED_COVERAGE'],
    });
    expect(JSON.stringify(audit)).not.toMatch(/Awa|Ndiaye|1990-05-12|objectKey|sha256/);
  });

  it('ignores files that are not technically ACCEPTED (quarantined or rejected)', async () => {
    const { journey, passenger } = await subject();
    const row = await db(t.app).passenger.findUniqueOrThrow({ where: { reference: passenger } });
    for (const [index, status] of (['QUARANTINED', 'REJECTED'] as const).entries()) {
      const document = await db(t.app).passengerDocument.create({
        data: {
          reference: `ETD-00000000QR${index}0`,
          passengerId: row.id,
          type: 'PASSPORT',
          objectKey: `passenger-documents/0${index}/${String(index).repeat(64)}`,
          sha256: 'ab'.repeat(32),
          mimeType: 'application/pdf',
          sizeBytes: 10n,
          expiresAt: new Date('2040-01-01T00:00:00.000Z'),
        },
      });
      if (status === 'REJECTED') {
        await db(t.app).passengerDocument.update({
          where: { id: document.id },
          data: {
            status,
            rejectedAt: new Date(Date.now() + 1_000),
            failureCode: 'MALWARE_DETECTED',
          },
        });
      }
    }
    await publishRule(manager, {
      definition: {
        ...coverage(journey),
        requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' },
      },
    });
    const evaluated = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(evaluated.body).toMatchObject({
      status: 'NON_COMPLIANT_BY_RULES',
      requirements: [
        { outcome: 'FAIL', findings: [{ code: 'DOCUMENT_MISSING', documentType: 'PASSPORT' }] },
      ],
      documents: [],
    });
    const stored = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: evaluated.body.evaluation.reference },
    });
    expect((stored.facts as { documents: unknown[] }).documents).toEqual([]);
  });

  it('passes on verified coverage, cites evidence, deduplicates and goes stale on new facts', async () => {
    const { journey, passenger } = await subject();
    const document = await acceptedDocument(
      t.app,
      passenger,
      'PASSPORT',
      addDays(journey.travelDate, 200),
    );
    const rule = await publishRule(manager, {
      definition: {
        ...coverage(journey),
        requirement: {
          kind: 'DOCUMENT',
          documentType: 'PASSPORT',
          minValidity: { from: 'TRAVEL_DATE', days: 90 },
        },
      },
      guidance: 'Présentez le document synthétique requis.',
    });
    const first = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(first.body).toMatchObject({
      status: 'COMPLIANT_BY_RULES',
      evaluation: { result: 'PASS', current: true },
      requirements: [],
      findings: [],
      documents: [{ reference: document, type: 'PASSPORT', technicalStatus: 'ACCEPTED' }],
    });
    const stored = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: first.body.evaluation.reference },
      include: {
        results: { include: { ruleVersion: { include: { rule: true } }, evidence: true } },
      },
    });
    expect(stored.results).toEqual([
      expect.objectContaining({
        outcome: 'PASS',
        reasonCode: 'REQUIREMENT_MET',
        ruleVersion: expect.objectContaining({
          version: 1,
          rule: expect.objectContaining({ reference: rule.reference }),
        }),
        evidence: [expect.objectContaining({ passengerDocumentId: expect.any(String) })],
      }),
    ]);

    // Same facts, same rules, same engine: no new history row.
    const count = await evaluations();
    const again = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(again.body.evaluation.reference).toBe(first.body.evaluation.reference);
    expect(await evaluations()).toBe(count);

    // A new technically accepted document changes the facts: stale, and a
    // GET reports it without creating anything.
    await acceptedDocument(t.app, passenger, 'NATIONAL_ID', null);
    const summary = await complianceApi(alice).summary(journey.bookingReference);
    expect(summary.status).toBe(200);
    expect(summary.body.items[0]).toMatchObject({
      status: 'STALE',
      evaluation: { reference: first.body.evaluation.reference, current: false },
      requirements: [],
      review: null,
    });
    expect(await evaluations()).toBe(count);
    const fresh = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(fresh.body.evaluation.reference).not.toBe(first.body.evaluation.reference);
    expect(fresh.body).toMatchObject({
      status: 'COMPLIANT_BY_RULES',
      evaluation: { current: true },
    });
  });

  it('keeps an evaluation on the version it used when a new version is published', async () => {
    const { journey, passenger } = await subject();
    await acceptedDocument(t.app, passenger, 'PASSPORT', null);
    const rule = await publishRule(manager, {
      definition: {
        ...coverage(journey),
        requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' },
      },
    });
    const e1 = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(e1.body.evaluation.result).toBe('PASS');
    const snapshot = async () =>
      JSON.stringify(
        await db(t.app).complianceEvaluation.findUniqueOrThrow({
          where: { reference: e1.body.evaluation.reference },
          include: {
            results: {
              include: { ruleVersion: { select: { version: true, id: true } }, evidence: true },
            },
          },
        }),
      );
    const before = await snapshot();

    // Version 2: the same synthetic rule now also asks for a VISA.
    const next = await adminApi(manager).post(`/compliance/rules/${rule.reference}/versions`, {
      version: ruleContent({
        definition: {
          ...coverage(journey),
          requirement: {
            kind: 'ALL_OF',
            requirements: [
              { kind: 'DOCUMENT', documentType: 'PASSPORT' },
              { kind: 'DOCUMENT', documentType: 'VISA' },
            ],
          },
        },
        guidance: 'Un second document synthétique est requis.',
      }),
    });
    const sha = next.body.versions[0].definitionSha256 as string;
    await adminApi(manager).post(`/compliance/rules/${rule.reference}/versions/2/verify`, {
      definitionSha256: sha,
      sourceCheckedOn: today(),
    });
    expect(
      (
        await adminApi(manager).post(`/compliance/rules/${rule.reference}/versions/2/publish`, {
          definitionSha256: sha,
        })
      ).status,
    ).toBe(200);

    expect(await snapshot()).toBe(before);
    expect(before).toContain('"version":1');
    const stale = await complianceApi(alice).summary(journey.bookingReference);
    expect(stale.body.items[0]).toMatchObject({ status: 'STALE', evaluation: { current: false } });
    const e2 = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(e2.body).toMatchObject({
      status: 'NON_COMPLIANT_BY_RULES',
      evaluation: { result: 'FAIL', current: true },
      requirements: [
        {
          outcome: 'FAIL',
          guidance: 'Un second document synthétique est requis.',
          findings: expect.arrayContaining([{ code: 'DOCUMENT_MISSING', documentType: 'VISA' }]),
        },
      ],
    });
    const e2Row = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: e2.body.evaluation.reference },
      include: { results: { include: { ruleVersion: { select: { version: true } } } } },
    });
    expect(e2Row.results.map((result) => result.ruleVersion.version)).toEqual([2]);

    // Retiring version 2 withdraws it; version 1 (still published, open-ended) applies again.
    await adminApi(manager).post(`/compliance/rules/${rule.reference}/versions/2/retire`, {
      reason: 'Version synthétique retirée en test.',
    });
    expect(
      (await complianceApi(alice).summary(journey.bookingReference)).body.items[0].status,
    ).toBe('STALE');
    const e3 = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    expect(e3.body.evaluation.result).toBe('PASS');
  });

  it('selects the version in effect on each planned travel date, on the same evaluation day', async () => {
    const early = await subject(alice, { departureInDays: 10 });
    const late = await subject(alice, { departureInDays: 40 });
    const boundary = addDays(today(), 25);
    // Same synthetic destination/transit for both journeys: reuse early's countries.
    const definition = (documentType: string) => ({
      language: 1,
      scope: {
        destinationCountries: [early.journey.destination.iso2, late.journey.destination.iso2],
        transitCountries: [early.journey.transit.iso2, late.journey.transit.iso2],
      },
      requirement: { kind: 'DOCUMENT', documentType },
    });
    const v1 = await publishRule(manager, {
      definition: definition('PASSPORT'),
      effectiveFrom: '2020-01-01',
      effectiveTo: boundary,
    });
    const next = await adminApi(manager).post(`/compliance/rules/${v1.reference}/versions`, {
      version: ruleContent({ definition: definition('VISA'), effectiveFrom: addDays(boundary, 1) }),
    });
    const sha = next.body.versions[0].definitionSha256 as string;
    await adminApi(manager).post(`/compliance/rules/${v1.reference}/versions/2/verify`, {
      definitionSha256: sha,
      sourceCheckedOn: today(),
    });
    await adminApi(manager).post(`/compliance/rules/${v1.reference}/versions/2/publish`, {
      definitionSha256: sha,
    });

    const versionUsed = async ({ journey, passenger }: { journey: Journey; passenger: string }) => {
      const evaluated = await complianceApi(alice).evaluate(journey.bookingReference, passenger);
      const row = await db(t.app).complianceEvaluation.findUniqueOrThrow({
        where: { reference: evaluated.body.evaluation.reference },
        include: { results: { include: { ruleVersion: { select: { version: true } } } } },
      });
      return {
        versions: row.results.map((result) => result.ruleVersion.version),
        body: evaluated.body,
      };
    };
    const earlyResult = await versionUsed(early);
    const lateResult = await versionUsed(late);
    expect(earlyResult.versions).toEqual([1]);
    expect(lateResult.versions).toEqual([2]);
    expect(earlyResult.body.requirements[0].findings).toEqual([
      { code: 'DOCUMENT_MISSING', documentType: 'PASSPORT' },
    ]);
    expect(lateResult.body.requirements[0].findings).toEqual([
      { code: 'DOCUMENT_MISSING', documentType: 'VISA' },
    ]);
  });

  it('computes age on the travel date from server data (minor-only synthetic rule)', async () => {
    const journey = await confirmedJourney(t.app, env, alice, { seats: ['1A', '1B'] });
    const birth = addDays(journey.travelDate, -365 * 10);
    const child = await journeyPassenger(alice, journey, nationality.id, {
      givenName: 'Enfant',
      dateOfBirth: birth,
    });
    const adult = await journeyPassenger(alice, journey, nationality.id, { givenName: 'Adulte' });
    await publishRule(manager, { definition: coverage(journey) });
    await publishRule(manager, {
      definition: {
        language: 1,
        scope: { destinationCountries: [journey.destination.iso2], maxAgeOnTravelDate: 17 },
        requirement: { kind: 'DOCUMENT', documentType: 'PARENTAL_AUTHORIZATION' },
      },
    });
    const childResult = await complianceApi(alice).evaluate(journey.bookingReference, child);
    const adultResult = await complianceApi(alice).evaluate(journey.bookingReference, adult);
    expect(childResult.body.status).toBe('NON_COMPLIANT_BY_RULES');
    expect(adultResult.body.status).toBe('COMPLIANT_BY_RULES');
    const adultRow = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: adultResult.body.evaluation.reference },
      include: { results: true },
    });
    expect(adultRow.results.map((result) => result.outcome).sort()).toEqual([
      'NOT_APPLICABLE',
      'PASS',
    ]);
  });

  it('answers a foreign booking or passenger exactly like an unknown one', async () => {
    const { journey, passenger } = await subject();
    const foreignSummary = await complianceApi(bob).summary(journey.bookingReference);
    const unknownSummary = await complianceApi(bob).summary('ETB-000000000000');
    expect(foreignSummary.status).toBe(404);
    expect({ ...foreignSummary.body, requestId: undefined }).toEqual({
      ...unknownSummary.body,
      requestId: undefined,
    });
    const before = await evaluations();
    const foreignEvaluate = await complianceApi(bob).evaluate(journey.bookingReference, passenger);
    const unknownEvaluate = await complianceApi(bob).evaluate(
      'ETB-000000000000',
      'ETV-000000000000',
    );
    expect(foreignEvaluate.status).toBe(404);
    expect({ ...foreignEvaluate.body, requestId: undefined }).toEqual({
      ...unknownEvaluate.body,
      requestId: undefined,
    });
    expect(await evaluations()).toBe(before);
    // Bob's own passenger on Alice's booking reference is not a link either.
    const bobs = await subject(bob);
    const crossed = await complianceApi(bob).evaluate(journey.bookingReference, bobs.passenger);
    expect(crossed.body.code).toBe('COMPLIANCE_SUBJECT_NOT_FOUND');
    expect(
      (await complianceApi(alice).evaluate(journey.bookingReference, passenger, { csrf: null }))
        .status,
    ).toBe(403);
  });

  it('shows a customer no internal note, source, reviewer or fingerprint', async () => {
    const { journey, passenger } = await subject();
    await complianceApi(alice).evaluate(journey.bookingReference, passenger);
    const summary = await complianceApi(alice).summary(journey.bookingReference);
    expect(summary.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(summary.body)).not.toMatch(
      /fingerprint|sourceUrl|source|verifiedBy|reviewer|reason"|objectKey|sha256|"id"|customerIdentityId|engineVersion/i,
    );
  });

  it('rate-limits customer evaluations by an opaque identity bucket', async () => {
    const carol = await customerActor(t.app);
    const { journey, passenger } = await subject(carol);
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect(
        (await complianceApi(carol).evaluate(journey.bookingReference, passenger)).status,
        `${attempt}`,
      ).toBe(200);
    }
    const limited = await complianceApi(carol).evaluate(journey.bookingReference, passenger);
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.body)).not.toContain(carol.id);
  });
});
