import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  createTestRole,
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
  journeyPassenger,
} from '../../support/compliance-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('human compliance review (isolated database)', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let agent: StaffActor;
  let secondAgent: StaffActor;
  let opsManager: StaffActor;
  let bookingAgent: StaffActor;
  let documentReader: StaffActor;
  let nationality: { id: string; iso2: string };

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    const readerRole = await createTestRole(t.app, ['ops.access', 'passenger.document.read']);
    [customer, agent, secondAgent, opsManager, bookingAgent, documentReader] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, [readerRole]),
    ]);
    nationality = await country(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  /** A booking passenger whose machine result is REVIEW_REQUIRED (no rules). */
  async function pending() {
    const journey = await confirmedJourney(t.app, env, customer);
    const passenger = await journeyPassenger(customer, journey, nationality.id);
    await acceptedDocument(t.app, passenger, 'PASSPORT', '2040-01-01');
    const evaluated = await complianceApi(customer).evaluate(journey.bookingReference, passenger);
    expect(evaluated.body.status).toBe('REVIEW_REQUIRED');
    return { journey, passenger, evaluation: evaluated.body.evaluation.reference as string };
  }

  const review = (actor: StaffActor, evaluation: string, body: Record<string, unknown>) =>
    adminApi(actor).post(`/compliance/evaluations/${evaluation}/reviews`, body);

  it('lists the queue and shows the detail only to compliance.read, auditing each read', async () => {
    const { journey, passenger, evaluation } = await pending();
    const queue = await adminApi(agent).get(
      `/compliance/booking-passengers?bookingReference=${journey.bookingReference}&status=REVIEW_REQUIRED`,
    );
    expect(queue.status).toBe(200);
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        bookingReference: journey.bookingReference,
        tripReference: journey.tripReference,
        passenger: expect.objectContaining({ reference: passenger }),
        status: 'REVIEW_REQUIRED',
        evaluation: expect.objectContaining({ reference: evaluation, current: true }),
      }),
    ]);
    const listAudit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'COMPLIANCE_ACCESSED', actorIdentityId: agent.id },
      orderBy: { id: 'desc' },
    });
    expect(listAudit.metadata).toMatchObject({
      access: 'LIST',
      subjects: [`${journey.bookingReference}/${passenger}`],
    });

    const detail = await adminApi(opsManager).get(`/compliance/evaluations/${evaluation}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      reference: evaluation,
      bookingReference: journey.bookingReference,
      tripReference: journey.tripReference,
      passenger: expect.objectContaining({
        reference: passenger,
        nationality: expect.objectContaining({ iso2: nationality.iso2 }),
      }),
      travelDate: journey.travelDate,
      result: 'REVIEW_REQUIRED',
      current: true,
      status: 'REVIEW_REQUIRED',
      results: [],
      findings: expect.arrayContaining([{ code: 'NO_APPLICABLE_RULE' }]),
      facts: expect.objectContaining({
        documents: [expect.objectContaining({ type: 'PASSPORT' })],
      }),
    });
    expect(JSON.stringify(detail.body)).not.toMatch(/objectKey|sha256"|"id":"[0-9a-f-]{36}"/);
    expect(
      await db(t.app).auditEvent.count({
        where: {
          action: 'COMPLIANCE_ACCESSED',
          actorIdentityId: opsManager.id,
          metadata: { path: ['access'], equals: 'DETAIL' },
        },
      }),
    ).toBe(1);

    for (const actor of [bookingAgent, documentReader]) {
      expect((await adminApi(actor).get('/compliance/booking-passengers')).status).toBe(403);
      expect((await adminApi(actor).get(`/compliance/evaluations/${evaluation}`)).status).toBe(403);
    }
  });

  it('records a reasoned, audited review that the customer sees without internal details', async () => {
    const { journey, evaluation } = await pending();
    for (const body of [
      { decision: 'COMPLIANT', previousReviewId: null },
      { decision: 'COMPLIANT', reason: 'court', previousReviewId: null },
      {
        decision: 'APPROVED_FOR_TRAVEL',
        reason: 'Motif suffisamment long.',
        previousReviewId: null,
      },
      { decision: 'COMPLIANT', reason: 'Motif <script>x</script> long.', previousReviewId: null },
    ]) {
      expect((await review(agent, evaluation, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (
        await review(opsManager, evaluation, {
          decision: 'COMPLIANT',
          reason: 'Lecture seule, refus attendu.',
          previousReviewId: null,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await review(bookingAgent, evaluation, {
          decision: 'COMPLIANT',
          reason: 'Rôle sans droit de revue.',
          previousReviewId: null,
        })
      ).status,
    ).toBe(403);
    // There is no CUSTOMER review route at all.
    const customerCsrf = await customer.csrf();
    const customerAttempt = await request(t.app.getHttpServer())
      .post(`/v1/booking/compliance/evaluations/${evaluation}/reviews`)
      .set('Origin', customer.http.origin)
      .set('Cookie', customer.cookie)
      .set('X-CSRF-Token', customerCsrf)
      .send({
        decision: 'COMPLIANT',
        reason: 'Auto-approbation interdite.',
        previousReviewId: null,
      });
    expect(customerAttempt.status).toBe(404);

    const reason = 'Document synthétique contrôlé manuellement, cohérent avec le voyage.';
    const created = await review(agent, evaluation, {
      decision: 'COMPLIANT',
      reason,
      customerMessage: 'Votre dossier a été vérifié.',
      previousReviewId: null,
    });
    expect(created.status).toBe(201);
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'COMPLIANCE_REVIEWED', actorIdentityId: agent.id },
      orderBy: { id: 'desc' },
    });
    expect(audit.after).toMatchObject({
      evaluation,
      decision: 'COMPLIANT',
      supersedesReviewId: null,
    });
    expect(JSON.stringify(audit)).not.toContain(reason);

    const summary = await complianceApi(customer).summary(journey.bookingReference);
    expect(summary.body.items[0]).toMatchObject({
      status: 'COMPLIANT',
      review: { decision: 'COMPLIANT', customerMessage: 'Votre dossier a été vérifié.' },
    });
    expect(JSON.stringify(summary.body)).not.toContain(reason);
    expect(JSON.stringify(summary.body)).not.toContain(agent.email);

    // The review is history: a later decision supersedes it, never edits it.
    const conflict = await review(secondAgent, evaluation, {
      decision: 'NEEDS_INFORMATION',
      reason: 'Information complémentaire nécessaire.',
      previousReviewId: null,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('COMPLIANCE_REVIEW_CONFLICT');
    const superseding = await review(secondAgent, evaluation, {
      decision: 'NEEDS_INFORMATION',
      reason: 'Information complémentaire nécessaire.',
      previousReviewId: created.body.review.id,
    });
    expect(superseding.status).toBe(201);
    const detail = await adminApi(agent).get(`/compliance/evaluations/${evaluation}`);
    expect(detail.body.status).toBe('NEEDS_INFORMATION');
    expect(
      detail.body.reviews.map((r: { decision: string; current: boolean }) => [
        r.decision,
        r.current,
      ]),
    ).toEqual([
      ['COMPLIANT', false],
      ['NEEDS_INFORMATION', true],
    ]);
    const first = await db(t.app).complianceReview.findUniqueOrThrow({
      where: { id: created.body.review.id },
    });
    expect(first.decision).toBe('COMPLIANT');
  });

  it('never presents a stale evaluation as currently approved, nor lets it be reviewed', async () => {
    const { journey, passenger, evaluation } = await pending();
    const approved = await review(agent, evaluation, {
      decision: 'COMPLIANT',
      reason: 'Approbation sur les faits connus à ce moment.',
      previousReviewId: null,
    });
    expect(approved.status).toBe(201);
    await acceptedDocument(t.app, passenger, 'VISA', null);

    const summary = await complianceApi(customer).summary(journey.bookingReference);
    expect(summary.body.items[0]).toMatchObject({
      status: 'STALE',
      review: null,
      evaluation: { current: false },
    });
    const detail = await adminApi(agent).get(`/compliance/evaluations/${evaluation}`);
    expect(detail.body).toMatchObject({ current: false, status: 'STALE' });
    expect(detail.body.reviews).toEqual([
      expect.objectContaining({ decision: 'COMPLIANT', current: false }),
    ]);
    const queue = await adminApi(agent).get(
      `/compliance/booking-passengers?bookingReference=${journey.bookingReference}`,
    );
    expect(queue.body.items[0]).toMatchObject({
      status: 'STALE',
      review: { decision: 'COMPLIANT', current: false },
    });

    const onStale = await review(agent, evaluation, {
      decision: 'COMPLIANT',
      reason: 'Tentative sur une évaluation obsolète.',
      previousReviewId: approved.body.review.id,
    });
    expect(onStale.body.code).toBe('COMPLIANCE_EVALUATION_STALE');

    const reevaluated = await adminApi(agent).post('/compliance/evaluations', {
      bookingReference: journey.bookingReference,
      passengerReference: passenger,
    });
    expect(reevaluated.status).toBe(200);
    expect(reevaluated.body.created).toBe(true);
    const onSuperseded = await review(agent, evaluation, {
      decision: 'COMPLIANT',
      reason: 'Tentative sur une évaluation remplacée.',
      previousReviewId: approved.body.review.id,
    });
    expect(onSuperseded.body.code).toBe('COMPLIANCE_EVALUATION_SUPERSEDED');
    expect(
      (await complianceApi(customer).summary(journey.bookingReference)).body.items[0].status,
    ).toBe('REVIEW_REQUIRED');
    // Staff evaluation needs compliance.review.
    expect(
      (
        await adminApi(opsManager).post('/compliance/evaluations', {
          bookingReference: journey.bookingReference,
          passengerReference: passenger,
        })
      ).status,
    ).toBe(403);
  });

  it('accepts exactly one of two simultaneous first reviews', async () => {
    const { evaluation } = await pending();
    const outcomes = await Promise.all(
      [agent, secondAgent].map((actor, index) =>
        review(actor, evaluation, {
          decision: index === 0 ? 'COMPLIANT' : 'NON_COMPLIANT',
          reason: `Décision concurrente numéro ${index + 1}.`,
          previousReviewId: null,
        }),
      ),
    );
    expect(outcomes.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(outcomes.find((response) => response.status === 409)?.body.code).toBe(
      'COMPLIANCE_REVIEW_CONFLICT',
    );
    const row = await db(t.app).complianceEvaluation.findUniqueOrThrow({
      where: { reference: evaluation },
      include: { reviews: true },
    });
    expect(row.reviews).toHaveLength(1);
  });
});
