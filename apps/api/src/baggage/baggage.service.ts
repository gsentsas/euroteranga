import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { renderSVG } from 'uqr';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  AdminBaggageRegistration,
  BaggageEventInput,
  BaggageListQuery,
  BaggageRegistration,
  BaggageScanInput,
  BaggageWeightInput,
} from './baggage.dto.js';
import { BaggageErrors } from './baggage.errors.js';
import {
  baggageEventFingerprint,
  baggageQrPayload,
  BaggageTransitionError,
  normalizeBaggageReference,
  parseBaggageQrPayload,
  projectBaggageEvent,
  withFreshBaggageReference,
  type BaggageEvent,
} from './baggage-rules.js';
import {
  baggageDetailInclude,
  baggageDetailView,
  baggageEventSelect,
  baggageEventView,
  baggageSummaryInclude,
  baggageSummaryView,
} from './baggage-views.js';

const THIRTY_DAYS = 30 * 24 * 3_600_000;
const FIVE_MINUTES = 5 * 60_000;

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function databaseDomainError(error: unknown): never {
  const message = String(error);
  if (message.includes('confirmed, active scheduled journey')) {
    throw BaggageErrors.bookingNotEligible();
  }
  if (message.includes('waypoint must belong')) throw BaggageErrors.invalidLocation();
  if (message.includes('occurred_at is outside')) throw BaggageErrors.invalidTimestamp();
  if (
    message.includes('baggage lifecycle') ||
    message.includes('baggage removal') ||
    message.includes('active baggage exception') ||
    message.includes('EXCEPTION_RESOLVED') ||
    message.includes('exception cannot') ||
    message.includes('REMOVED is terminal') ||
    message.includes('projection must be updated before') ||
    message.includes('WEIGHT_UPDATED')
  ) {
    throw BaggageErrors.invalidTransition();
  }
  throw error;
}

interface RecordEventInput {
  type: BaggageEvent;
  occurredAt?: Date | undefined;
  routeWaypointId?: string | null | undefined;
  clientEventId?: string | undefined;
  measuredWeightKg?: string | undefined;
}

/**
 * Baggage registration and event projection. Every mutation is one short
 * PostgreSQL transaction containing the domain row(s) and its audit event.
 */
@Injectable()
export class BaggageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  async customerRegister(
    actor: AuthPrincipal,
    rawBookingReference: string,
    rawPassengerReference: string,
    input: BaggageRegistration,
  ) {
    await this.rateLimits.consume(RATE_LIMITS.baggageRegistrationIdentity, actor.identityId);
    return this.register(
      actor,
      rawBookingReference,
      rawPassengerReference,
      input.type,
      actor.identityId,
    );
  }

  async adminRegister(actor: AuthPrincipal, input: AdminBaggageRegistration) {
    await this.rateLimits.consume(RATE_LIMITS.baggageOperationIdentity, actor.identityId);
    return this.register(actor, input.bookingReference, input.passengerReference, input.type);
  }

  private async register(
    actor: AuthPrincipal,
    rawBookingReference: string,
    rawPassengerReference: string,
    type: BaggageRegistration['type'],
    ownerIdentityId?: string,
  ) {
    const bookingReference = rawBookingReference.trim().toUpperCase();
    const passengerReference = rawPassengerReference.trim().toUpperCase();
    if (
      !/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(bookingReference) ||
      !/^ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(passengerReference)
    ) {
      throw BaggageErrors.subjectNotFound();
    }

    let reference: string;
    try {
      reference = await withFreshBaggageReference(
        (candidate) =>
          this.database.client.$transaction(async (tx) => {
            const subject = await tx.bookingPassenger.findFirst({
              where: {
                booking: {
                  reference: bookingReference,
                  ...(ownerIdentityId ? { customerIdentityId: ownerIdentityId } : {}),
                },
                passenger: {
                  reference: passengerReference,
                  ...(ownerIdentityId ? { ownerCustomerIdentityId: ownerIdentityId } : {}),
                },
              },
              select: {
                bookingId: true,
                passengerId: true,
                booking: { select: { confirmedAt: true, cancelledAt: true } },
              },
            });
            if (!subject) throw BaggageErrors.subjectNotFound();
            if (!subject.booking.confirmedAt || subject.booking.cancelledAt) {
              throw BaggageErrors.bookingNotEligible();
            }
            const baggage = await tx.baggage.create({
              data: {
                reference: candidate,
                bookingId: subject.bookingId,
                passengerId: subject.passengerId,
                type,
              },
              select: { id: true },
            });
            const occurredAt = new Date();
            await tx.baggageEvent.create({
              data: {
                baggageId: baggage.id,
                sequence: 1,
                type: 'REGISTERED',
                lifecycleStatus: 'REGISTERED',
                occurredAt,
                actorIdentityId: actor.identityId,
                payloadFingerprint: baggageEventFingerprint({
                  type: 'REGISTERED',
                  occurredAt,
                  routeWaypointId: null,
                  measuredWeightKg: null,
                }),
              },
            });
            await this.audit.record(
              {
                actor,
                action: 'BAGGAGE_REGISTERED',
                resourceType: 'baggage',
                resourceId: baggage.id,
                after: {
                  reference: candidate,
                  bookingReference,
                  passengerReference,
                  type,
                  lifecycleStatus: 'REGISTERED',
                },
              },
              tx,
            );
            return candidate;
          }),
        uniqueViolation,
      );
    } catch (error) {
      return databaseDomainError(error);
    }
    return ownerIdentityId
      ? this.customerBaggage(actor, reference)
      : this.adminBaggage(actor, reference, 'REGISTER');
  }

  async customerBookingBaggage(actor: AuthPrincipal, rawBookingReference: string) {
    const bookingReference = rawBookingReference.trim().toUpperCase();
    const booking = await this.database.client.booking.findFirst({
      where: { reference: bookingReference, customerIdentityId: actor.identityId },
      select: { id: true },
    });
    if (!booking) throw BaggageErrors.subjectNotFound();
    const rows = await this.database.client.baggage.findMany({
      where: { bookingId: booking.id },
      take: 100,
      orderBy: { id: 'desc' },
      include: baggageSummaryInclude,
    });
    return { items: rows.map(baggageSummaryView) };
  }

  async customerBaggage(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeBaggageReference(rawReference);
    if (!reference) throw BaggageErrors.notFound();
    const row = await this.database.client.baggage.findFirst({
      where: {
        reference,
        bookingPassenger: { booking: { customerIdentityId: actor.identityId } },
      },
      include: baggageDetailInclude,
    });
    if (!row) throw BaggageErrors.notFound();
    return baggageDetailView(row);
  }

  async customerQr(actor: AuthPrincipal, rawReference: string) {
    const baggage = await this.customerBaggage(actor, rawReference);
    return { reference: baggage.reference, svg: this.renderQr(baggage.reference) };
  }

  async adminList(actor: AuthPrincipal, query: BaggageListQuery) {
    const where: Prisma.BaggageWhereInput = {
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      ...(query.reference ? { reference: query.reference } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.lifecycleStatus ? { lifecycleStatus: query.lifecycleStatus } : {}),
      ...(query.exceptionStatus ? { exceptionStatus: query.exceptionStatus } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lt: query.createdTo } : {}),
            },
          }
        : {}),
      ...(query.bookingReference || query.passengerReference || query.tripReference
        ? {
            bookingPassenger: {
              booking: {
                ...(query.bookingReference ? { reference: query.bookingReference } : {}),
                ...(query.tripReference ? { trip: { reference: query.tripReference } } : {}),
              },
              ...(query.passengerReference
                ? { passenger: { reference: query.passengerReference } }
                : {}),
            },
          }
        : {}),
    };
    const rows = await this.database.client.baggage.findMany({
      where,
      take: query.limit + 1,
      orderBy: { id: 'desc' },
      include: baggageSummaryInclude,
    });
    const page = rows.slice(0, query.limit);
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'BAGGAGE_ACCESSED',
          resourceType: 'baggage',
          metadata: {
            access: 'LIST',
            references: page.map((row) => row.reference),
            filters: {
              reference: query.reference ?? null,
              bookingReference: query.bookingReference ?? null,
              passengerReference: query.passengerReference ?? null,
              tripReference: query.tripReference ?? null,
              type: query.type ?? null,
              lifecycleStatus: query.lifecycleStatus ?? null,
              exceptionStatus: query.exceptionStatus ?? null,
            },
          },
        },
        tx,
      ),
    );
    return {
      items: page.map(baggageSummaryView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async adminBaggage(actor: AuthPrincipal, rawReference: string, access = 'DETAIL') {
    const row = await this.adminRow(rawReference);
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'BAGGAGE_ACCESSED',
          resourceType: 'baggage',
          resourceId: row.id,
          metadata: { access, reference: row.reference },
        },
        tx,
      ),
    );
    return baggageDetailView(row);
  }

  async adminResolveQr(actor: AuthPrincipal, qrPayload: string) {
    const reference = parseBaggageQrPayload(qrPayload);
    if (!reference) throw BaggageErrors.qrInvalid();
    return this.adminBaggage(actor, reference, 'QR_RESOLVE');
  }

  async adminQr(actor: AuthPrincipal, rawReference: string) {
    const baggage = await this.adminBaggage(actor, rawReference, 'QR_LABEL');
    return { reference: baggage.reference, svg: this.renderQr(baggage.reference) };
  }

  async updateWeight(actor: AuthPrincipal, rawReference: string, input: BaggageWeightInput) {
    return this.recordEvent(actor, rawReference, {
      type: 'WEIGHT_UPDATED',
      ...input,
    });
  }

  async recordOperationalEvent(
    actor: AuthPrincipal,
    rawReference: string,
    input: BaggageEventInput,
  ) {
    return this.recordEvent(actor, rawReference, input);
  }

  async recordScan(actor: AuthPrincipal, input: BaggageScanInput) {
    const reference = parseBaggageQrPayload(input.qrPayload);
    if (!reference) throw BaggageErrors.qrInvalid();
    const { qrPayload: _qrPayload, ...event } = input;
    return this.recordEvent(actor, reference, event);
  }

  private async recordEvent(actor: AuthPrincipal, rawReference: string, input: RecordEventInput) {
    const reference = normalizeBaggageReference(rawReference);
    if (!reference) throw BaggageErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.baggageOperationIdentity, actor.identityId);
    const occurredAt = input.occurredAt ?? new Date();
    const now = Date.now();
    if (occurredAt.getTime() < now - THIRTY_DAYS || occurredAt.getTime() > now + FIVE_MINUTES) {
      throw BaggageErrors.invalidTimestamp();
    }
    const routeWaypointId = input.routeWaypointId ?? null;
    const measuredWeightKg = input.measuredWeightKg ?? null;
    const fingerprint = baggageEventFingerprint({
      type: input.type,
      occurredAt,
      routeWaypointId,
      measuredWeightKg,
    });

    try {
      return await this.database.client.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "baggage" WHERE "reference" = ${reference} FOR UPDATE`;
        if (!locked) throw BaggageErrors.notFound();

        if (input.clientEventId) {
          const replay = await tx.baggageEvent.findFirst({
            where: { baggageId: locked.id, clientEventId: input.clientEventId },
            select: { ...baggageEventSelect, payloadFingerprint: true },
          });
          if (replay) {
            if (replay.payloadFingerprint !== fingerprint) {
              throw BaggageErrors.idempotencyConflict();
            }
            const { payloadFingerprint: _payloadFingerprint, ...event } = replay;
            return { created: false, event: baggageEventView(event) };
          }
        }

        const baggage = await tx.baggage.findUniqueOrThrow({
          where: { id: locked.id },
          include: baggageSummaryInclude,
        });
        const current = {
          lifecycleStatus: baggage.lifecycleStatus,
          exceptionStatus: baggage.exceptionStatus,
          measuredWeightKg: baggage.measuredWeightKg?.toFixed(3) ?? null,
        };
        let projection;
        try {
          projection = projectBaggageEvent(current, input.type, input.measuredWeightKg);
        } catch (error) {
          if (error instanceof BaggageTransitionError) throw BaggageErrors.invalidTransition();
          throw error;
        }
        const latest = await tx.baggageEvent.findFirst({
          where: { baggageId: baggage.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const event = await tx.baggageEvent.create({
          data: {
            baggageId: baggage.id,
            sequence: (latest?.sequence ?? 0) + 1,
            type: input.type,
            lifecycleStatus: projection.lifecycleStatus,
            exceptionStatus: projection.exceptionStatus,
            measuredWeightKg: projection.measuredWeightKg,
            occurredAt,
            actorIdentityId: actor.identityId,
            routeWaypointId,
            ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
            payloadFingerprint: fingerprint,
          },
          select: baggageEventSelect,
        });
        await tx.baggage.update({
          where: { id: baggage.id },
          data: {
            lifecycleStatus: projection.lifecycleStatus,
            exceptionStatus: projection.exceptionStatus,
            measuredWeightKg: projection.measuredWeightKg,
          },
        });
        const action =
          input.type === 'WEIGHT_UPDATED'
            ? 'BAGGAGE_WEIGHT_UPDATED'
            : input.type === 'REMOVED'
              ? 'BAGGAGE_REMOVED'
              : 'BAGGAGE_EVENT_RECORDED';
        await this.audit.record(
          {
            actor,
            action,
            resourceType: 'baggage',
            resourceId: baggage.id,
            metadata: {
              reference,
              event: input.type,
              sequence: event.sequence,
              lifecycleStatus: event.lifecycleStatus,
              exceptionStatus: event.exceptionStatus,
              measuredWeightKg: event.measuredWeightKg?.toFixed(3) ?? null,
            },
          },
          tx,
        );
        return { created: true, event: baggageEventView(event) };
      });
    } catch (error) {
      return databaseDomainError(error);
    }
  }

  private async adminRow(rawReference: string) {
    const reference = normalizeBaggageReference(rawReference);
    if (!reference) throw BaggageErrors.notFound();
    const row = await this.database.client.baggage.findUnique({
      where: { reference },
      include: baggageDetailInclude,
    });
    if (!row) throw BaggageErrors.notFound();
    return row;
  }

  private renderQr(reference: string): string {
    return renderSVG(baggageQrPayload(reference), {
      ecc: 'M',
      boostEcc: true,
      border: 4,
      pixelSize: 6,
      blackColor: '#111827',
      whiteColor: '#ffffff',
    });
  }
}
