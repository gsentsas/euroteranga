import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { normalizePassengerReference } from '../passenger-documents/passenger-document-rules.js';
import {
  ENGINE_VERSION,
  evaluateCompliance,
  type ComplianceFacts,
  type EngineResult,
} from './compliance-engine.js';
import { loadFacts, versionsInEffect } from './compliance-facts.js';
import {
  generateEvaluationReference,
  normalizeEvaluationReference,
  withFreshReference,
} from './compliance-references.js';
import { ComplianceErrors } from './compliance.errors.js';
import type { ComplianceQueueQuery, ComplianceStatus, ReviewCreate } from './compliance.dto.js';
import { complianceStatus } from './compliance-views.js';

type Db = DatabaseTransaction;

interface Subject {
  bookingId: string;
  passengerId: string;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const BOOKING_REFERENCE = /^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

const evaluationInclude = {
  results: {
    orderBy: { id: 'asc' },
    include: {
      ruleVersion: {
        select: {
          version: true,
          status: true,
          customerGuidance: true,
          effectiveFrom: true,
          effectiveTo: true,
          sourceAuthority: true,
          sourceTitle: true,
          sourceUrl: true,
          sourceReference: true,
          sourceCheckedOn: true,
          rule: { select: { reference: true, title: true } },
        },
      },
      evidence: {
        include: {
          passengerDocument: {
            select: { reference: true, type: true, status: true, expiresAt: true },
          },
        },
      },
    },
  },
  reviews: {
    orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
    include: { reviewer: { select: { email: true } } },
  },
} as const satisfies Prisma.ComplianceEvaluationInclude;

/** The review that no later review supersedes (the head of the linear chain). */
function headReview<T extends { id: string; supersedesReviewId: string | null }>(
  reviews: T[],
): T | null {
  const superseded = new Set(reviews.map((review) => review.supersedesReviewId).filter(Boolean));
  return reviews.find((review) => !superseded.has(review.id)) ?? null;
}

function details(
  value: Prisma.JsonValue,
): Array<{ code: string; documentType?: string; country?: string }> {
  return Array.isArray(value)
    ? (value as Array<{ code: string; documentType?: string; country?: string }>)
    : [];
}

/**
 * Evaluation, staleness and human review of one booking passenger. Facts are
 * always rebuilt from PostgreSQL; no network call happens inside a
 * transaction; every STAFF read of passenger compliance data is audited.
 */
@Injectable()
export class ComplianceEvaluationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  /** Facts and engine result from the current database state. */
  private async compute(
    db: Db,
    subject: Subject,
  ): Promise<{ facts: ComplianceFacts; engine: EngineResult; documentIds: Map<string, string> }> {
    const loaded = await loadFacts(db, subject.bookingId, subject.passengerId);
    if (!loaded) throw ComplianceErrors.subjectNotFound();
    const versions = await versionsInEffect(db, loaded.facts.travelDate);
    return {
      facts: loaded.facts,
      engine: evaluateCompliance(loaded.facts, versions),
      documentIds: loaded.documentIds,
    };
  }

  private latest(db: Db, subject: Subject) {
    return db.complianceEvaluation.findFirst({
      where: { bookingId: subject.bookingId, passengerId: subject.passengerId },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      include: evaluationInclude,
    });
  }

  /**
   * Current = same engine, same facts fingerprint and same rules fingerprint
   * as a fresh computation now. Anything else is history.
   */
  private async isCurrent(
    db: Db,
    subject: Subject,
    evaluation: { engineVersion: string; factsFingerprint: string; rulesFingerprint: string },
  ): Promise<boolean> {
    const { engine } = await this.compute(db, subject);
    return (
      evaluation.engineVersion === ENGINE_VERSION &&
      evaluation.factsFingerprint === engine.factsFingerprint &&
      evaluation.rulesFingerprint === engine.rulesFingerprint
    );
  }

  /**
   * Records a new evaluation, or returns the latest one when nothing changed
   * (same engine, facts and rules): repeated requests are deduplicated under
   * the booking passenger row lock.
   */
  private async evaluate(
    actor: AuthPrincipal,
    subject: Subject,
  ): Promise<{ reference: string; created: boolean }> {
    return withFreshReference(
      (reference) =>
        this.database.client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ booking_id: string }>>`
            SELECT "booking_id" FROM "booking_passenger"
            WHERE "booking_id" = ${subject.bookingId}::uuid AND "passenger_id" = ${subject.passengerId}::uuid
            FOR UPDATE`;
          if (locked.length === 0) throw ComplianceErrors.subjectNotFound();
          const { facts, engine, documentIds } = await this.compute(tx, subject);
          const previous = await tx.complianceEvaluation.findFirst({
            where: { bookingId: subject.bookingId, passengerId: subject.passengerId },
            orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
            select: {
              reference: true,
              engineVersion: true,
              factsFingerprint: true,
              rulesFingerprint: true,
            },
          });
          if (
            previous &&
            previous.engineVersion === ENGINE_VERSION &&
            previous.factsFingerprint === engine.factsFingerprint &&
            previous.rulesFingerprint === engine.rulesFingerprint
          ) {
            return { reference: previous.reference, created: false };
          }
          const evaluation = await tx.complianceEvaluation.create({
            data: {
              reference,
              bookingId: subject.bookingId,
              passengerId: subject.passengerId,
              travelDate: new Date(`${facts.travelDate}T00:00:00.000Z`),
              arrivalDate: new Date(`${facts.arrivalDate}T00:00:00.000Z`),
              engineVersion: ENGINE_VERSION,
              facts: facts as unknown as Prisma.InputJsonValue,
              factsFingerprint: engine.factsFingerprint,
              rulesFingerprint: engine.rulesFingerprint,
              result: engine.result,
              findings: engine.findings as unknown as Prisma.InputJsonValue,
              actorIdentityId: actor.identityId,
            },
            select: { id: true },
          });
          if (engine.outcomes.length > 0) {
            const results = await tx.complianceEvaluationResult.createManyAndReturn({
              data: engine.outcomes.map((outcome) => ({
                evaluationId: evaluation.id,
                ruleVersionId: outcome.versionId,
                outcome: outcome.outcome,
                reasonCode: outcome.reasonCode,
                details: outcome.details as unknown as Prisma.InputJsonValue,
              })),
              select: { id: true, ruleVersionId: true },
            });
            const evidence = engine.outcomes.flatMap((outcome) => {
              const resultId = results.find((row) => row.ruleVersionId === outcome.versionId)!.id;
              return outcome.evidence.map((documentReference) => ({
                evaluationResultId: resultId,
                passengerDocumentId: documentIds.get(documentReference)!,
              }));
            });
            if (evidence.length > 0) {
              await tx.complianceEvaluationEvidence.createMany({ data: evidence });
            }
          }
          await this.audit.record(
            {
              actor,
              action: 'COMPLIANCE_EVALUATED',
              resourceType: 'compliance_evaluation',
              resourceId: evaluation.id,
              after: {
                reference,
                result: engine.result,
                engineVersion: ENGINE_VERSION,
                ruleVersions: engine.outcomes.map(
                  (outcome) => `${outcome.ruleReference}#${outcome.version}`,
                ),
                findings: engine.findings.map((finding) => finding.code),
              },
            },
            tx,
          );
          return { reference, created: true };
        }),
      (error) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String(error.meta?.target ?? '').includes('reference'),
      generateEvaluationReference,
    );
  }

  // ---------------------------------------------------------------- CUSTOMER

  private async ownedSubject(
    actor: AuthPrincipal,
    rawBooking: string,
    rawPassenger: string,
  ): Promise<Subject> {
    const bookingReference = rawBooking.trim().toUpperCase();
    const passengerReference = normalizePassengerReference(rawPassenger);
    if (!BOOKING_REFERENCE.test(bookingReference) || !passengerReference) {
      throw ComplianceErrors.subjectNotFound();
    }
    const link = await this.database.client.bookingPassenger.findFirst({
      where: {
        booking: { reference: bookingReference, customerIdentityId: actor.identityId },
        passenger: { reference: passengerReference, ownerCustomerIdentityId: actor.identityId },
      },
      select: { bookingId: true, passengerId: true },
    });
    if (!link) throw ComplianceErrors.subjectNotFound();
    return link;
  }

  /**
   * PR-14: read-only current compliance of one booking passenger for the
   * check-in gates. Same PR-12 status, staleness and head review as every
   * other view; no evaluation is created and nothing is audited here.
   */
  async currentCompliance(db: Db, subject: Subject) {
    const latest = await this.latest(db, subject);
    const current = latest ? await this.isCurrent(db, subject, latest) : false;
    const review = latest && current ? headReview(latest.reviews) : null;
    const results = latest && current ? latest.results : [];
    const failing = results.filter(
      (result) => result.outcome === 'FAIL' || result.outcome === 'REVIEW_REQUIRED',
    );
    return {
      status: complianceStatus(latest, current, review),
      evaluation: latest
        ? {
            id: latest.id,
            reference: latest.reference,
            engineVersion: latest.engineVersion,
            factsFingerprint: latest.factsFingerprint,
            rulesFingerprint: latest.rulesFingerprint,
          }
        : null,
      review: review ? { id: review.id, decision: review.decision } : null,
      evidence: [
        ...new Map(
          results
            .flatMap((result) => result.evidence)
            .map(({ passengerDocument: document }) => [
              document.reference,
              { reference: document.reference, status: document.status },
            ]),
        ).values(),
      ],
      findingCodes: failing.flatMap((result) => details(result.details).map(({ code }) => code)),
      /** Customer guidance of the requirements still to satisfy (plain text). */
      guidance: [...new Set(failing.map((result) => result.ruleVersion.customerGuidance))],
    };
  }

  /** CUSTOMER-safe view: no rule source, internal note, reviewer or fingerprint. */
  private async customerItem(
    subject: Subject,
    passenger: { reference: string; givenName: string; familyName: string },
  ) {
    const latest = await this.latest(this.database.client, subject);
    const current = latest ? await this.isCurrent(this.database.client, subject, latest) : false;
    const review = latest && current ? headReview(latest.reviews) : null;
    const status = complianceStatus(latest, current, review);
    const actionable = latest && current ? latest.results : [];
    return {
      passenger,
      status,
      evaluation: latest
        ? {
            reference: latest.reference,
            evaluatedAt: latest.evaluatedAt,
            travelDate: isoDay(latest.travelDate),
            result: latest.result,
            current,
          }
        : null,
      review: review
        ? {
            decision: review.decision,
            reviewedAt: review.reviewedAt,
            customerMessage: review.customerMessage,
          }
        : null,
      requirements: actionable
        .filter((result) => result.outcome === 'FAIL' || result.outcome === 'REVIEW_REQUIRED')
        .map((result) => ({
          outcome: result.outcome,
          guidance: result.ruleVersion.customerGuidance,
          findings: details(result.details).map(({ code, documentType }) => ({
            code,
            documentType: documentType ?? null,
          })),
        })),
      findings: latest && current ? details(latest.findings) : [],
      documents: [
        ...new Map(
          actionable
            .flatMap((result) => result.evidence)
            .map(({ passengerDocument: document }) => [
              document.reference,
              {
                reference: document.reference,
                type: document.type,
                technicalStatus: document.status,
              },
            ]),
        ).values(),
      ],
    };
  }

  /** GET: no side effect. Foreign and unknown bookings are the same 404. */
  async customerSummary(actor: AuthPrincipal, rawBooking: string) {
    const reference = rawBooking.trim().toUpperCase();
    if (!BOOKING_REFERENCE.test(reference)) throw ComplianceErrors.bookingNotFound();
    const booking = await this.database.client.booking.findFirst({
      where: { reference, customerIdentityId: actor.identityId },
      select: {
        id: true,
        reference: true,
        passengers: {
          orderBy: { passengerId: 'asc' },
          select: {
            passengerId: true,
            passenger: { select: { reference: true, givenName: true, familyName: true } },
          },
        },
      },
    });
    if (!booking) throw ComplianceErrors.bookingNotFound();
    const items = [];
    for (const link of booking.passengers) {
      items.push(
        await this.customerItem(
          { bookingId: booking.id, passengerId: link.passengerId },
          link.passenger,
        ),
      );
    }
    return { bookingReference: booking.reference, items };
  }

  /** POST: owner-scoped, rate-limited, deduplicated, server-derived facts only. */
  async customerEvaluate(actor: AuthPrincipal, rawBooking: string, rawPassenger: string) {
    await this.rateLimits.consume(RATE_LIMITS.complianceEvaluationIdentity, actor.identityId);
    const subject = await this.ownedSubject(actor, rawBooking, rawPassenger);
    await this.evaluate(actor, subject);
    const passenger = await this.database.client.passenger.findUniqueOrThrow({
      where: { id: subject.passengerId },
      select: { reference: true, givenName: true, familyName: true },
    });
    return this.customerItem(subject, passenger);
  }

  // ------------------------------------------------------------------- STAFF

  async staffEvaluate(
    actor: AuthPrincipal,
    input: { bookingReference: string; passengerReference: string },
  ) {
    const link = await this.database.client.bookingPassenger.findFirst({
      where: {
        booking: { reference: input.bookingReference },
        passenger: { reference: input.passengerReference },
      },
      select: { bookingId: true, passengerId: true },
    });
    if (!link) throw ComplianceErrors.subjectNotFound();
    const evaluation = await this.evaluate(actor, link);
    return { reference: evaluation.reference, created: evaluation.created };
  }

  /**
   * Review queue over booking passengers, upcoming departures first. Filters
   * on stored columns run in SQL; the derived status (which needs a fresh
   * staleness check) is applied over a bounded scan of at most 200 rows per
   * request, and the cursor resumes after the last scanned row.
   */
  async queue(actor: AuthPrincipal, query: ComplianceQueueQuery) {
    const cursor = (() => {
      if (!query.cursor) return null;
      try {
        const [departure, bookingId, passengerId] = JSON.parse(
          Buffer.from(query.cursor, 'base64url').toString('utf8'),
        ) as [string, string, string];
        if (
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(departure) ||
          !/^[0-9a-f-]{36}$/.test(bookingId) ||
          !/^[0-9a-f-]{36}$/.test(passengerId)
        ) {
          return null;
        }
        return { departure: new Date(departure), bookingId, passengerId };
      } catch {
        return null;
      }
    })();
    const conditions: Prisma.Sql[] = [Prisma.sql`b."confirmed_at" IS NOT NULL`];
    if (query.tripReference) conditions.push(Prisma.sql`t."reference" = ${query.tripReference}`);
    if (query.bookingReference)
      conditions.push(Prisma.sql`b."reference" = ${query.bookingReference}`);
    if (query.passengerReference)
      conditions.push(Prisma.sql`p."reference" = ${query.passengerReference}`);
    if (query.departureFrom) {
      conditions.push(Prisma.sql`t."planned_departure_at" >= ${query.departureFrom}::date`);
    }
    if (query.departureTo) {
      conditions.push(Prisma.sql`t."planned_departure_at" < (${query.departureTo}::date + 1)`);
    }

    const items: Array<Awaited<ReturnType<ComplianceEvaluationService['queueItem']>>> = [];
    let position = cursor;
    let scanned = 0;
    let exhausted = false;
    while (items.length < query.limit && scanned < 200) {
      const where = [...conditions];
      if (position) {
        where.push(
          Prisma.sql`(COALESCE(t."planned_departure_at", 'epoch'), bp."booking_id", bp."passenger_id") > (${position.departure}, ${position.bookingId}::uuid, ${position.passengerId}::uuid)`,
        );
      }
      const rows = await this.database.client.$queryRaw<
        Array<{
          booking_id: string;
          passenger_id: string;
          booking_reference: string;
          trip_reference: string;
          departure: Date;
          passenger_reference: string;
          given_name: string;
          family_name: string;
        }>
      >`
        SELECT bp."booking_id", bp."passenger_id", b."reference" AS booking_reference,
               t."reference" AS trip_reference,
               COALESCE(t."planned_departure_at", 'epoch') AS departure,
               p."reference" AS passenger_reference, p."given_name", p."family_name"
        FROM "booking_passenger" bp
        JOIN "booking" b ON b."id" = bp."booking_id"
        JOIN "trip" t ON t."id" = b."trip_id"
        JOIN "passenger" p ON p."id" = bp."passenger_id"
        WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY COALESCE(t."planned_departure_at", 'epoch'), bp."booking_id", bp."passenger_id"
        LIMIT 50`;
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      let consumed = 0;
      for (const row of rows) {
        scanned += 1;
        consumed += 1;
        position = {
          departure: row.departure,
          bookingId: row.booking_id,
          passengerId: row.passenger_id,
        };
        const item = await this.queueItem(row);
        if (!query.status || item.status === query.status) items.push(item);
        if (items.length >= query.limit || scanned >= 200) break;
      }
      if (rows.length < 50 && consumed === rows.length) {
        exhausted = true;
        break;
      }
    }
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'COMPLIANCE_ACCESSED',
          resourceType: 'compliance_evaluation',
          metadata: {
            access: 'LIST',
            subjects: items.map((item) => `${item.bookingReference}/${item.passenger.reference}`),
            filters: {
              status: query.status ?? null,
              tripReference: query.tripReference ?? null,
              bookingReference: query.bookingReference ?? null,
              passengerReference: query.passengerReference ?? null,
              departureFrom: query.departureFrom ?? null,
              departureTo: query.departureTo ?? null,
            },
          },
        },
        tx,
      ),
    );
    return {
      items,
      nextCursor:
        exhausted || !position
          ? null
          : Buffer.from(
              JSON.stringify([
                position.departure.toISOString(),
                position.bookingId,
                position.passengerId,
              ]),
            ).toString('base64url'),
    };
  }

  private async queueItem(row: {
    booking_id: string;
    passenger_id: string;
    booking_reference: string;
    trip_reference: string;
    departure: Date;
    passenger_reference: string;
    given_name: string;
    family_name: string;
  }) {
    const subject = { bookingId: row.booking_id, passengerId: row.passenger_id };
    const latest = await this.latest(this.database.client, subject);
    const current = latest ? await this.isCurrent(this.database.client, subject, latest) : false;
    const review = latest ? headReview(latest.reviews) : null;
    return {
      bookingReference: row.booking_reference,
      tripReference: row.trip_reference,
      departureAt: row.departure,
      passenger: {
        reference: row.passenger_reference,
        givenName: row.given_name,
        familyName: row.family_name,
      },
      status: complianceStatus(latest, current, current ? review : null) as ComplianceStatus,
      evaluation: latest
        ? {
            reference: latest.reference,
            result: latest.result,
            evaluatedAt: latest.evaluatedAt,
            current,
          }
        : null,
      review: review ? { decision: review.decision, reviewedAt: review.reviewedAt, current } : null,
    };
  }

  /** STAFF evaluation detail, audited before it is returned. */
  async detail(actor: AuthPrincipal, rawReference: string) {
    const view = await this.detailView(rawReference);
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'COMPLIANCE_ACCESSED',
          resourceType: 'compliance_evaluation',
          resourceId: view.id,
          metadata: { access: 'DETAIL', reference: view.reference },
        },
        tx,
      ),
    );
    const { id: _id, ...publicView } = view;
    return publicView;
  }

  private async detailView(rawReference: string) {
    const reference = normalizeEvaluationReference(rawReference);
    if (!reference) throw ComplianceErrors.evaluationNotFound();
    const evaluation = await this.database.client.complianceEvaluation.findUnique({
      where: { reference },
      include: {
        ...evaluationInclude,
        bookingPassenger: {
          select: {
            booking: { select: { reference: true, trip: { select: { reference: true } } } },
            passenger: {
              select: {
                reference: true,
                givenName: true,
                familyName: true,
                nationalityCountry: { select: { iso2: true, name: true } },
              },
            },
          },
        },
        actor: { select: { realm: true } },
      },
    });
    if (!evaluation) throw ComplianceErrors.evaluationNotFound();
    const subject = { bookingId: evaluation.bookingId, passengerId: evaluation.passengerId };
    const latest = await this.database.client.complianceEvaluation.findFirst({
      where: subject,
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, reference: true },
    });
    const isLatest = latest?.id === evaluation.id;
    const current = isLatest && (await this.isCurrent(this.database.client, subject, evaluation));
    const head = headReview(evaluation.reviews);
    return {
      id: evaluation.id,
      reference: evaluation.reference,
      bookingReference: evaluation.bookingPassenger.booking.reference,
      tripReference: evaluation.bookingPassenger.booking.trip.reference,
      passenger: {
        reference: evaluation.bookingPassenger.passenger.reference,
        givenName: evaluation.bookingPassenger.passenger.givenName,
        familyName: evaluation.bookingPassenger.passenger.familyName,
        nationality: evaluation.bookingPassenger.passenger.nationalityCountry,
      },
      travelDate: isoDay(evaluation.travelDate),
      arrivalDate: isoDay(evaluation.arrivalDate),
      evaluatedAt: evaluation.evaluatedAt,
      triggeredBy: evaluation.actor.realm,
      engineVersion: evaluation.engineVersion,
      facts: evaluation.facts,
      factsFingerprint: evaluation.factsFingerprint,
      rulesFingerprint: evaluation.rulesFingerprint,
      result: evaluation.result,
      findings: details(evaluation.findings),
      latestEvaluationReference: latest?.reference ?? null,
      current,
      status: complianceStatus(evaluation, current, current ? head : null),
      results: evaluation.results.map((result) => ({
        rule: result.ruleVersion.rule,
        version: {
          version: result.ruleVersion.version,
          status: result.ruleVersion.status,
          effectiveFrom: isoDay(result.ruleVersion.effectiveFrom),
          effectiveTo: result.ruleVersion.effectiveTo
            ? isoDay(result.ruleVersion.effectiveTo)
            : null,
          customerGuidance: result.ruleVersion.customerGuidance,
          source: {
            authority: result.ruleVersion.sourceAuthority,
            title: result.ruleVersion.sourceTitle,
            url: result.ruleVersion.sourceUrl,
            reference: result.ruleVersion.sourceReference,
            checkedOn: result.ruleVersion.sourceCheckedOn
              ? isoDay(result.ruleVersion.sourceCheckedOn)
              : null,
          },
        },
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        details: details(result.details),
        evidence: result.evidence.map(({ passengerDocument: document }) => ({
          reference: document.reference,
          type: document.type,
          technicalStatus: document.status,
          expiresAt: document.expiresAt ? isoDay(document.expiresAt) : null,
        })),
      })),
      reviews: evaluation.reviews.map((review) => ({
        id: review.id,
        decision: review.decision,
        reason: review.reason,
        customerMessage: review.customerMessage,
        reviewer: review.reviewer.email,
        reviewedAt: review.reviewedAt,
        supersedesReviewId: review.supersedesReviewId,
        current: current && head?.id === review.id,
      })),
    };
  }

  /**
   * Append-only human decision with a mandatory reason, only on the latest
   * evaluation and only while it is current, serialized on the evaluation
   * row. The reviewer must name the latest review they saw.
   */
  async review(actor: AuthPrincipal, rawReference: string, input: ReviewCreate) {
    const reference = normalizeEvaluationReference(rawReference);
    if (!reference) throw ComplianceErrors.evaluationNotFound();
    const created = await this.database.client.$transaction(async (tx) => {
      const [evaluation] = await tx.$queryRaw<
        Array<{
          id: string;
          booking_id: string;
          passenger_id: string;
          engine_version: string;
          facts_fingerprint: string;
          rules_fingerprint: string;
        }>
      >`
        SELECT "id", "booking_id", "passenger_id", "engine_version", "facts_fingerprint", "rules_fingerprint"
        FROM "compliance_evaluation" WHERE "reference" = ${reference} FOR UPDATE`;
      if (!evaluation) throw ComplianceErrors.evaluationNotFound();
      const subject = { bookingId: evaluation.booking_id, passengerId: evaluation.passenger_id };
      const latest = await tx.complianceEvaluation.findFirst({
        where: subject,
        orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (latest?.id !== evaluation.id) throw ComplianceErrors.evaluationSuperseded();
      const current = await this.isCurrent(tx, subject, {
        engineVersion: evaluation.engine_version,
        factsFingerprint: evaluation.facts_fingerprint,
        rulesFingerprint: evaluation.rules_fingerprint,
      });
      if (!current) throw ComplianceErrors.evaluationStale();
      const reviews = await tx.complianceReview.findMany({
        where: { evaluationId: evaluation.id },
        select: { id: true, supersedesReviewId: true },
      });
      const head = headReview(reviews);
      if ((head?.id ?? null) !== input.previousReviewId) throw ComplianceErrors.reviewConflict();
      const review = await tx.complianceReview.create({
        data: {
          evaluationId: evaluation.id,
          supersedesReviewId: head?.id ?? null,
          decision: input.decision,
          reason: input.reason,
          customerMessage: input.customerMessage ?? null,
          reviewerIdentityId: actor.identityId,
        },
        select: { id: true, decision: true, reviewedAt: true },
      });
      await this.audit.record(
        {
          actor,
          action: 'COMPLIANCE_REVIEWED',
          resourceType: 'compliance_evaluation',
          resourceId: evaluation.id,
          after: {
            evaluation: reference,
            reviewId: review.id,
            decision: review.decision,
            supersedesReviewId: head?.id ?? null,
          },
        },
        tx,
      );
      return review;
    });
    return { evaluationReference: reference, review: created };
  }
}
