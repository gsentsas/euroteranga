import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEvaluationReference } from '../../../src/compliance/compliance-references.js';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import {
  complianceApi,
  confirmedJourney,
  country,
  journeyPassenger,
  publishRule,
  ruleContent,
} from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const today = () => new Date().toISOString().slice(0, 10);

describe('compliance PostgreSQL invariants and concurrency (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let manager: StaffActor;
  let reviewer: StaffActor;
  let customer: CustomerActor;
  let destination: string;
  let nationalityId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    [manager, reviewer, customer] = await Promise.all([
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      customerActor(t.app),
    ]);
    destination = (await country(t.app)).iso2;
    nationalityId = (await country(t.app)).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const definition = (documentType = 'PASSPORT') => ({
    language: 1,
    scope: { destinationCountries: [destination] },
    requirement: { kind: 'DOCUMENT', documentType },
  });

  async function draft() {
    const created = await adminApi(manager).post('/compliance/rules', {
      title: 'Règle synthétique en base',
      version: ruleContent({ definition: definition() }),
    });
    expect(created.status, created.text).toBe(201);
    const reference = created.body.reference as string;
    const version = await db(t.app).complianceRuleVersion.findFirstOrThrow({
      where: { rule: { reference } },
    });
    return { reference, sha: version.definitionSha256, version };
  }

  async function verified() {
    const created = await draft();
    const response = await adminApi(manager).post(
      `/compliance/rules/${created.reference}/versions/1/verify`,
      {
        definitionSha256: created.sha,
        sourceCheckedOn: today(),
      },
    );
    expect(response.status).toBe(200);
    return created;
  }

  async function lockWaiters(): Promise<number> {
    const [row] = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return Number(row!.count);
  }

  async function waitForWaiters(count: number) {
    for (let attempt = 0; attempt < 400 && (await lockWaiters()) < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await lockWaiters(), 'the operation must queue on the lock').toBeGreaterThanOrEqual(
      count,
    );
  }

  /**
   * Forced overlap: a separate transaction holds the rule row lock, the two
   * API operations queue behind it in the given order (both in flight), then
   * the lock is released and PostgreSQL grants it in arrival order.
   */
  async function ordered<A, B>(
    ruleReference: string,
    first: () => PromiseLike<A>,
    second: () => PromiseLike<B>,
  ) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const gate = db(t.app).$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "compliance_rule" WHERE "reference" = ${ruleReference} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isLocked;
    const a = Promise.resolve(first());
    await waitForWaiters(1);
    const b = Promise.resolve(second());
    await waitForWaiters(2);
    release();
    await gate;
    return Promise.all([a, b]);
  }

  it('refuses unverified publication, silent edits and any change to published history', async () => {
    const { reference, sha, version } = await draft();
    await expect(
      db(t.app).complianceRuleVersion.create({
        data: { ...version, id: undefined, version: 9, status: 'PUBLISHED' } as never,
      }),
    ).rejects.toThrow(/created as unverified drafts|one_draft|status_consistent/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "status" = 'PUBLISHED', "published_at" = now(), "published_by_identity_id" = ${manager.id}::uuid WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/only an unchanged verified draft can be published|status_consistent/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "verification_status" = 'VERIFIED' WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/verification_consistent/);

    await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/verify`, {
      definitionSha256: sha,
      sourceCheckedOn: today(),
    });
    // Editing verified content without dropping the verification is impossible.
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "customer_guidance" = 'Texte modifié en douce.' WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/must be verified again/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "definition" = '{"language":1,"scope":{},"requirement":{"kind":"NO_DOCUMENT_REQUIRED"}}'::jsonb WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/must be verified again|verification_consistent/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "source_checked_on" = CURRENT_DATE + 30, "verification_status" = 'UNVERIFIED', "verified_at" = NULL, "verified_by_identity_id" = NULL, "verified_definition_sha256" = NULL WHERE "id" = ${version.id}::uuid`,
    ).resolves.toBe(1);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "verification_status" = 'VERIFIED', "verified_at" = now(), "verified_by_identity_id" = ${manager.id}::uuid, "verified_definition_sha256" = "definition_sha256" WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/checked in the future/);
    await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/verify`, {
      definitionSha256: sha,
      sourceCheckedOn: today(),
    });
    expect(
      (
        await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/publish`, {
          definitionSha256: sha,
        })
      ).status,
    ).toBe(200);

    for (const change of [
      `"customer_guidance" = 'Réécriture silencieuse.'`,
      `"effective_to" = CURRENT_DATE`,
      `"definition" = '{"language":1,"scope":{},"requirement":{"kind":"HUMAN_REVIEW"}}'::jsonb`,
      `"status" = 'DRAFT', "published_at" = NULL, "published_by_identity_id" = NULL`,
      `"verification_note" = 'Note ajoutée après publication.'`,
    ]) {
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "compliance_rule_version" SET ${change} WHERE "id" = $1::uuid`,
          version.id,
        ),
        change,
      ).rejects.toThrow(/published compliance rule versions are immutable/);
    }
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "status" = 'RETIRED', "retired_at" = now(), "retired_by_identity_id" = ${manager.id}::uuid WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/status_consistent/);
    await expect(
      db(t.app).complianceRuleVersion.delete({ where: { id: version.id } }),
    ).rejects.toThrow(/cannot be deleted/);
    await adminApi(manager).post(`/compliance/rules/${reference}/versions/1/retire`, {
      reason: 'Retrait synthétique pour le test.',
    });
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "retirement_reason" = 'Autre motif de retrait.' WHERE "id" = ${version.id}::uuid`,
    ).rejects.toThrow(/retired compliance rule versions are immutable/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule" SET "title" = 'Titre réécrit' WHERE "reference" = ${reference}`,
    ).rejects.toThrow(/identity is immutable/);
    await expect(db(t.app).complianceRule.delete({ where: { reference } })).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('enforces version numbering, one draft, intervals and https provenance', async () => {
    const { version } = await draft();
    const base = {
      ruleId: version.ruleId,
      definition: version.definition as object,
      definitionSha256: version.definitionSha256,
      customerGuidance: 'Texte.',
      effectiveFrom: version.effectiveFrom,
    };
    await expect(
      db(t.app).complianceRuleVersion.create({ data: { ...base, version: 2 } }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      db(t.app).complianceRuleVersion.create({ data: { ...base, version: 1 } }),
    ).rejects.toThrow(/Unique constraint/);
    const other = await draft();
    const otherBase = { ...base, ruleId: other.version.ruleId };
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "effective_to" = "effective_from" - 1 WHERE "id" = ${other.version.id}::uuid`,
    ).rejects.toThrow(/effective_interval/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "source_url" = 'http://insecure.example.test' WHERE "id" = ${other.version.id}::uuid`,
    ).rejects.toThrow(/source_url_https/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "source_url" = 'javascript:alert(1)' WHERE "id" = ${other.version.id}::uuid`,
    ).rejects.toThrow(/source_url_https/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_rule_version" SET "customer_guidance" = '<b>gras</b>' WHERE "id" = ${other.version.id}::uuid`,
    ).rejects.toThrow(/guidance_plain/);
    expect(otherBase.ruleId).not.toBe(base.ruleId);
    for (const table of [
      'compliance_rule',
      'compliance_rule_version',
      'compliance_evaluation',
      'compliance_evaluation_result',
      'compliance_evaluation_evidence',
      'compliance_review',
    ]) {
      await expect(
        db(t.app).$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`),
        table,
      ).rejects.toThrow(/cannot be truncated/);
    }
  });

  it('keeps evaluations, results, evidence and reviews append-only and coherent', async () => {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, nationalityId);
    const evaluated = await complianceApi(customer).evaluate(journey.bookingReference, passenger);
    const evaluation = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: evaluated.body.evaluation.reference },
    });
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_evaluation" SET "result" = 'PASS' WHERE "id" = ${evaluation.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db(t.app).complianceEvaluation.delete({ where: { id: evaluation.id } }),
    ).rejects.toThrow(/append-only/);

    // Only a PUBLISHED version can be applied.
    const { version: draftVersion } = await draft();
    await expect(
      db(t.app).complianceEvaluationResult.create({
        data: {
          evaluationId: evaluation.id,
          ruleVersionId: draftVersion.id,
          outcome: 'PASS',
          reasonCode: 'REQUIREMENT_MET',
        },
      }),
    ).rejects.toThrow(/only published compliance rule versions can be applied/);
    const published = await publishRule(manager, { definition: definition('VISA') });
    const publishedVersion = await db(t.app).complianceRuleVersion.findFirstOrThrow({
      where: { rule: { reference: published.reference } },
    });
    const result = await db(t.app).complianceEvaluationResult.create({
      data: {
        evaluationId: evaluation.id,
        ruleVersionId: publishedVersion.id,
        outcome: 'FAIL',
        reasonCode: 'REQUIREMENT_NOT_MET',
      },
    });
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_evaluation_result" SET "outcome" = 'PASS' WHERE "id" = ${result.id}::uuid`,
    ).rejects.toThrow(/append-only/);

    // Evidence must be a technically ACCEPTED document of the same passenger.
    const passengerRow = await db(t.app).passenger.findUniqueOrThrow({
      where: { reference: passenger },
    });
    const quarantined = await db(t.app).passengerDocument.create({
      data: {
        reference: 'ETD-0000000000Q1',
        passengerId: passengerRow.id,
        type: 'PASSPORT',
        objectKey: `passenger-documents/aa/${'a'.repeat(64)}`,
        sha256: 'ab'.repeat(32),
        mimeType: 'application/pdf',
        sizeBytes: 10n,
      },
    });
    await expect(
      db(t.app).complianceEvaluationEvidence.create({
        data: { evaluationResultId: result.id, passengerDocumentId: quarantined.id },
      }),
    ).rejects.toThrow(/technically accepted document of the evaluated passenger/);

    // Reviews: ACTIVE STAFF only, one linear chain, latest evaluation only.
    const customerIdentity = await createIdentity(t.app, { realm: 'customer' });
    await expect(
      db(t.app).complianceReview.create({
        data: {
          evaluationId: evaluation.id,
          decision: 'COMPLIANT',
          reason: 'Revue par un client.',
          reviewerIdentityId: customerIdentity.id,
        },
      }),
    ).rejects.toThrow(/ACTIVE STAFF/);
    const first = await db(t.app).complianceReview.create({
      data: {
        evaluationId: evaluation.id,
        decision: 'NEEDS_INFORMATION',
        reason: 'Première revue directe.',
        reviewerIdentityId: reviewer.id,
      },
    });
    await expect(
      db(t.app).complianceReview.create({
        data: {
          evaluationId: evaluation.id,
          decision: 'COMPLIANT',
          reason: 'Seconde première revue.',
          reviewerIdentityId: reviewer.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await db(t.app).complianceReview.create({
      data: {
        evaluationId: evaluation.id,
        supersedesReviewId: first.id,
        decision: 'COMPLIANT',
        reason: 'Revue suivante valide.',
        reviewerIdentityId: reviewer.id,
      },
    });
    await expect(
      db(t.app).complianceReview.create({
        data: {
          evaluationId: evaluation.id,
          supersedesReviewId: first.id,
          decision: 'NON_COMPLIANT',
          reason: 'Branche concurrente.',
          reviewerIdentityId: reviewer.id,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      db(t.app)
        .$executeRaw`UPDATE "compliance_review" SET "decision" = 'NON_COMPLIANT' WHERE "id" = ${first.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(db(t.app).complianceReview.delete({ where: { id: first.id } })).rejects.toThrow(
      /append-only/,
    );

    // A newer evaluation makes this one unreviewable, even directly in SQL.
    const newer = await db(t.app).complianceEvaluation.create({
      data: {
        reference: generateEvaluationReference(),
        bookingId: evaluation.bookingId,
        passengerId: evaluation.passengerId,
        travelDate: evaluation.travelDate,
        arrivalDate: evaluation.arrivalDate,
        engineVersion: evaluation.engineVersion,
        facts: evaluation.facts as object,
        factsFingerprint: 'c'.repeat(64),
        rulesFingerprint: 'd'.repeat(64),
        result: 'REVIEW_REQUIRED',
        actorIdentityId: reviewer.id,
      },
    });
    await expect(
      db(t.app).complianceReview.create({
        data: {
          evaluationId: evaluation.id,
          decision: 'COMPLIANT',
          reason: 'Sur une évaluation remplacée.',
          reviewerIdentityId: reviewer.id,
        },
      }),
    ).rejects.toThrow(/only the latest evaluation/);
    await expect(
      db(t.app).complianceReview.create({
        data: {
          evaluationId: newer.id,
          supersedesReviewId: first.id,
          decision: 'COMPLIANT',
          reason: 'Chaîne inter-évaluations.',
          reviewerIdentityId: reviewer.id,
        },
      }),
    ).rejects.toThrow(/same evaluation|Unique constraint/);
  });

  it('publishes the same draft only once under simultaneous requests', async () => {
    const { reference, sha } = await verified();
    const before = await db(t.app).auditEvent.count({
      where: { action: 'COMPLIANCE_RULE_PUBLISHED' },
    });
    const outcomes = await Promise.all(
      [0, 1].map(() =>
        adminApi(manager).post(`/compliance/rules/${reference}/versions/1/publish`, {
          definitionSha256: sha,
        }),
      ),
    );
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      await db(t.app).auditEvent.count({ where: { action: 'COMPLIANCE_RULE_PUBLISHED' } }),
    ).toBe(before + 1);
  });

  it('serializes publication with a concurrent edit of the same draft, in both orders', async () => {
    // Edit first: the publication then sees the dropped verification.
    const editFirst = await verified();
    const [edited, publishAfterEdit] = await ordered(
      editFirst.reference,
      () =>
        adminApi(manager).post(
          `/compliance/rules/${editFirst.reference}/versions/1`,
          ruleContent({ definition: definition('VISA') }),
        ),
      () =>
        adminApi(manager).post(`/compliance/rules/${editFirst.reference}/versions/1/publish`, {
          definitionSha256: editFirst.sha,
        }),
    );
    expect(edited.status).toBe(200);
    expect(publishAfterEdit.status).toBe(409);
    expect(publishAfterEdit.body.code).toBe('COMPLIANCE_RULE_CONTENT_CHANGED');
    expect(
      (
        await db(t.app).complianceRuleVersion.findFirstOrThrow({
          where: { rule: { reference: editFirst.reference } },
        })
      ).status,
    ).toBe('DRAFT');

    // Publish first: the edit then finds an immutable version.
    const publishFirst = await verified();
    const [publishedFirst, editAfterPublish] = await ordered(
      publishFirst.reference,
      () =>
        adminApi(manager).post(`/compliance/rules/${publishFirst.reference}/versions/1/publish`, {
          definitionSha256: publishFirst.sha,
        }),
      () =>
        adminApi(manager).post(
          `/compliance/rules/${publishFirst.reference}/versions/1`,
          ruleContent({ definition: definition('VISA') }),
        ),
    );
    expect(publishedFirst.status).toBe(200);
    expect(editAfterPublish.body.code).toBe('COMPLIANCE_RULE_VERSION_NOT_DRAFT');
    const stored = await db(t.app).complianceRuleVersion.findFirstOrThrow({
      where: { rule: { reference: publishFirst.reference } },
    });
    expect(stored).toMatchObject({ status: 'PUBLISHED', definitionSha256: publishFirst.sha });
  });

  it('makes a retirement wait for an evaluation that is applying the version', async () => {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, nationalityId);
    const published = await publishRule(manager, { definition: definition('VISA') });
    const version = await db(t.app).complianceRuleVersion.findFirstOrThrow({
      where: { rule: { reference: published.reference } },
    });
    const link = await db(t.app).bookingPassenger.findFirstOrThrow({
      where: {
        booking: { reference: journey.bookingReference },
        passenger: { reference: passenger },
      },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let applied!: () => void;
    const isApplied = new Promise<void>((resolve) => (applied = resolve));
    const evaluation = db(t.app).$transaction(
      async (tx) => {
        const row = await tx.complianceEvaluation.create({
          data: {
            reference: generateEvaluationReference(),
            bookingId: link.bookingId,
            passengerId: link.passengerId,
            travelDate: new Date(`${journey.travelDate}T00:00:00.000Z`),
            arrivalDate: new Date(`${journey.travelDate}T00:00:00.000Z`),
            engineVersion: 'compliance-engine/1',
            facts: {},
            factsFingerprint: 'e'.repeat(64),
            rulesFingerprint: 'f'.repeat(64),
            result: 'FAIL',
            actorIdentityId: reviewer.id,
          },
        });
        await tx.complianceEvaluationResult.create({
          data: {
            evaluationId: row.id,
            ruleVersionId: version.id,
            outcome: 'FAIL',
            reasonCode: 'REQUIREMENT_NOT_MET',
          },
        });
        applied();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isApplied;
    const retire = adminApi(manager).post(
      `/compliance/rules/${published.reference}/versions/1/retire`,
      {
        reason: 'Retrait concurrent synthétique.',
      },
    );
    await waitForWaiters(1);
    release();
    await evaluation;
    expect((await retire).status).toBe(200);
    const results = await db(t.app).complianceEvaluationResult.count({
      where: { ruleVersionId: version.id },
    });
    expect(results).toBe(1);
  });
});
