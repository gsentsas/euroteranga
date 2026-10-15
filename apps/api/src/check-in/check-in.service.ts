import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import type { RateLimitRule } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { BOOKING_REFERENCE_PATTERN } from '../bookings/booking-rules.js';
import { ComplianceEvaluationService } from '../compliance/compliance-evaluation.service.js';
import { DatabaseService } from '../database/database.service.js';
import { normalizePassengerReference } from '../passenger-documents/passenger-document-rules.js';
import type { CheckInListQuery } from './check-in.dto.js';
import { CheckInBlockedError, CheckInErrors } from './check-in.errors.js';
import {
  deriveReadiness,
  generateCheckInReference,
  generateCredentialReference,
  normalizeCheckInReference,
  normalizeSeatLabel,
  readinessFingerprint,
  readinessSnapshot,
  renderBoardingQrSvg,
  withFreshReferences,
  type Readiness,
  type ReadinessFacts,
} from './check-in-rules.js';
import {
  checkInSelect,
  customerCheckInView,
  readinessView,
  staffCheckInView,
  tripSelect,
  tripView,
  type CheckInRow,
} from './check-in-views.js';

type Db = DatabaseTransaction;

/** One BookingPassenger: one person on one confirmed booking of one trip. */
export interface CheckInSubject {
  bookingId: string;
  passengerId: string;
  bookingReference: string;
  passengerReference: string;
}

export interface ReadinessResult {
  facts: ReadinessFacts;
  readiness: Readiness;
  fingerprint: string;
  guidance: string[];
}

function uniqueViolation(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes(field)
  );
}

const referenceCollision = (error: unknown) =>
  uniqueViolation(error, 'reference') || uniqueViolation(error, 'credential_reference');

/** Maps the PostgreSQL guards (races behind the API checks) to public errors. */
export function checkInDomainError(error: unknown): never {
  if (error instanceof CheckInBlockedError) throw error;
  const message = String(error);
  if (message.includes('seat of a checked-in passenger is immutable')) {
    throw CheckInErrors.seatLocked();
  }
  if (message.includes('released seat')) throw CheckInErrors.seatNotFound();
  if (
    message.includes('check-in requires') ||
    message.includes('check-in pins the current seat') ||
    message.includes('seat assignment requires') ||
    message.includes('passenger_check_in_seat_assignment_fkey')
  ) {
    throw CheckInErrors.notEligible([]);
  }
  throw error;
}

/**
 * PR-14 seat assignment and passenger check-in. Every gate is derived from
 * PostgreSQL; each mutation is one short transaction holding the
 * BookingPassenger row lock, with its audit event.
 */
@Injectable()
export class CheckInService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly compliance: ComplianceEvaluationService,
  ) {}

  /** Foreign, unknown and mismatched booking/passenger pairs are the same 404. */
  async subject(
    rawBooking: string,
    rawPassenger: string,
    ownerIdentityId?: string,
  ): Promise<CheckInSubject> {
    const bookingReference = rawBooking.trim().toUpperCase();
    const passengerReference = normalizePassengerReference(rawPassenger);
    if (!BOOKING_REFERENCE_PATTERN.test(bookingReference) || !passengerReference) {
      throw CheckInErrors.subjectNotFound();
    }
    const link = await this.database.client.bookingPassenger.findFirst({
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
      select: { bookingId: true, passengerId: true },
    });
    if (!link) throw CheckInErrors.subjectNotFound();
    return { ...link, bookingReference, passengerReference };
  }

  /** Serializes seat assignment, check-in and boarding of one BookingPassenger. */
  private async lockSubject(tx: Db, subject: CheckInSubject) {
    const [locked] = await tx.$queryRaw<Array<{ booking_id: string }>>`
      SELECT "booking_id" FROM "booking_passenger"
      WHERE "booking_id" = ${subject.bookingId}::uuid AND "passenger_id" = ${subject.passengerId}::uuid
      FOR UPDATE`;
    if (!locked) throw CheckInErrors.subjectNotFound();
  }

  /** The six gates of one BookingPassenger, from server data only. */
  async readinessOf(db: Db, subject: CheckInSubject): Promise<ReadinessResult> {
    const row = await db.bookingPassenger.findUnique({
      where: {
        bookingId_passengerId: { bookingId: subject.bookingId, passengerId: subject.passengerId },
      },
      select: {
        booking: {
          select: {
            reference: true,
            confirmedAt: true,
            cancelledAt: true,
            trip: { select: { reference: true, status: true } },
            payments: { where: { status: 'SUCCEEDED' }, select: { reference: true }, take: 1 },
          },
        },
        seatAssignment: {
          select: {
            bookingSeatId: true,
            bookingSeat: {
              select: { releasedAt: true, seatMapCell: { select: { seatLabel: true } } },
            },
          },
        },
        baggage: {
          select: { reference: true, lifecycleStatus: true, exceptionStatus: true },
          orderBy: { reference: 'asc' },
        },
      },
    });
    if (!row) throw CheckInErrors.subjectNotFound();
    const compliance = await this.compliance.currentCompliance(db, subject);
    const payment = row.booking.payments[0];
    const facts: ReadinessFacts = {
      booking: {
        reference: row.booking.reference,
        confirmed: row.booking.confirmedAt !== null,
        cancelled: row.booking.cancelledAt !== null,
      },
      trip: row.booking.trip,
      payment: payment ? { reference: payment.reference } : null,
      seat: row.seatAssignment
        ? {
            bookingSeatId: row.seatAssignment.bookingSeatId,
            label: row.seatAssignment.bookingSeat.seatMapCell.seatLabel ?? '',
            released: row.seatAssignment.bookingSeat.releasedAt !== null,
          }
        : null,
      compliance: {
        status: compliance.status,
        evaluation: compliance.evaluation,
        review: compliance.review,
        evidence: compliance.evidence,
        findingCodes: compliance.findingCodes,
      },
      baggage: row.baggage,
    };
    const readiness = deriveReadiness(facts);
    return {
      facts,
      readiness,
      fingerprint: readinessFingerprint(facts),
      guidance: compliance.guidance,
    };
  }

  async readiness(subject: CheckInSubject) {
    const { readiness, guidance } = await this.readinessOf(this.database.client, subject);
    return readinessView(readiness, guidance);
  }

  /**
   * Links the BookingPassenger to one unreleased seat already booked on the
   * same booking. Creates, releases and prices nothing; refused after check-in.
   */
  async assignSeat(
    actor: AuthPrincipal,
    subject: CheckInSubject,
    rawLabel: string,
    rule: RateLimitRule,
  ) {
    const label = normalizeSeatLabel(rawLabel);
    if (!label) throw CheckInErrors.seatNotFound();
    await this.rateLimits.consume(rule, actor.identityId);
    try {
      return await this.database.client.$transaction(async (tx) => {
        await this.lockSubject(tx, subject);
        const key = { bookingId: subject.bookingId, passengerId: subject.passengerId };
        const checkedIn = await tx.passengerCheckIn.findUnique({
          where: { bookingId_passengerId: key },
          select: { id: true },
        });
        if (checkedIn) throw CheckInErrors.seatLocked();
        const seat = await tx.bookingSeat.findFirst({
          where: {
            bookingId: subject.bookingId,
            releasedAt: null,
            seatMapCell: { seatLabel: label },
          },
          select: { id: true },
        });
        if (!seat) throw CheckInErrors.seatNotFound();
        const current = await tx.bookingPassengerSeat.findUnique({
          where: { bookingId_passengerId: key },
          select: {
            bookingSeatId: true,
            bookingSeat: { select: { seatMapCell: { select: { seatLabel: true } } } },
          },
        });
        if (current?.bookingSeatId === seat.id) return { changed: false, seat: { label } };
        if (current) {
          await tx.bookingPassengerSeat.update({
            where: { bookingId_passengerId: key },
            data: { bookingSeatId: seat.id, assignedByIdentityId: actor.identityId },
          });
        } else {
          await tx.bookingPassengerSeat.create({
            data: { ...key, bookingSeatId: seat.id, assignedByIdentityId: actor.identityId },
          });
        }
        await this.audit.record(
          {
            actor,
            action: 'PASSENGER_SEAT_ASSIGNED',
            resourceType: 'booking_passenger',
            resourceId: `${subject.bookingReference}/${subject.passengerReference}`,
            metadata: {
              bookingReference: subject.bookingReference,
              passengerReference: subject.passengerReference,
              seatLabel: label,
              previousSeatLabel: current?.bookingSeat.seatMapCell.seatLabel ?? null,
            },
          },
          tx,
        );
        return { changed: true, seat: { label } };
      });
    } catch (error) {
      if (uniqueViolation(error, 'booking_seat_id')) throw CheckInErrors.seatAlreadyAssigned();
      return checkInDomainError(error);
    }
  }

  /**
   * The one check-in of a BookingPassenger: lock, derive every gate, create
   * the check-in and its credential, audit, commit — or nothing. A repeated
   * request returns the existing check-in (created: false).
   */
  async checkIn(
    actor: AuthPrincipal,
    subject: CheckInSubject,
    rule: RateLimitRule,
  ): Promise<{ created: boolean; row: CheckInRow }> {
    await this.rateLimits.consume(rule, actor.identityId);
    try {
      return await withFreshReferences(
        () =>
          this.database.client.$transaction(
            async (tx) => {
              await this.lockSubject(tx, subject);
              const existing = await tx.passengerCheckIn.findUnique({
                where: {
                  bookingId_passengerId: {
                    bookingId: subject.bookingId,
                    passengerId: subject.passengerId,
                  },
                },
                select: checkInSelect,
              });
              if (existing) return { created: false, row: existing };

              const { facts, readiness, fingerprint } = await this.readinessOf(tx, subject);
              const evaluation = facts.compliance.evaluation;
              if (!readiness.eligible || !facts.seat || !evaluation) {
                throw CheckInErrors.notEligible(readiness.blockers);
              }
              const row = await tx.passengerCheckIn.create({
                data: {
                  reference: generateCheckInReference(),
                  credentialReference: generateCredentialReference(),
                  bookingId: subject.bookingId,
                  passengerId: subject.passengerId,
                  bookingSeatId: facts.seat.bookingSeatId,
                  complianceEvaluationId: evaluation.id,
                  complianceReviewId: facts.compliance.review?.id ?? null,
                  engineVersion: readiness.engineVersion,
                  readinessFingerprint: fingerprint,
                  readinessSnapshot: readinessSnapshot(facts, readiness),
                  checkedInByIdentityId: actor.identityId,
                },
                select: checkInSelect,
              });
              await this.audit.record(
                {
                  actor,
                  action: 'PASSENGER_CHECKED_IN',
                  resourceType: 'passenger_check_in',
                  resourceId: row.id,
                  metadata: {
                    checkInReference: row.reference,
                    bookingReference: subject.bookingReference,
                    passengerReference: subject.passengerReference,
                    tripReference: facts.trip.reference,
                    seatLabel: facts.seat.label,
                    complianceEvaluationReference: evaluation.reference,
                    engineVersion: readiness.engineVersion,
                  },
                },
                tx,
              );
              return { created: true, row };
            },
            { timeout: 15_000 },
          ),
        referenceCollision,
      );
    } catch (error) {
      return checkInDomainError(error);
    }
  }

  /** CUSTOMER overview of an owned booking: seats, readiness and check-ins. */
  async customerBooking(actor: AuthPrincipal, rawBooking: string) {
    const bookingReference = rawBooking.trim().toUpperCase();
    const booking = BOOKING_REFERENCE_PATTERN.test(bookingReference)
      ? await this.database.client.booking.findFirst({
          where: { reference: bookingReference, customerIdentityId: actor.identityId },
          select: {
            id: true,
            reference: true,
            trip: { select: tripSelect },
            seats: {
              where: { releasedAt: null },
              select: {
                seatMapCell: { select: { seatLabel: true } },
                passengerSeats: { select: { passengerId: true } },
              },
            },
            passengers: {
              orderBy: { createdAt: 'asc' },
              select: {
                passengerId: true,
                passenger: { select: { reference: true, givenName: true, familyName: true } },
              },
            },
          },
        })
      : null;
    if (!booking) throw CheckInErrors.subjectNotFound();
    const referenceOf = new Map(
      booking.passengers.map((link) => [link.passengerId, link.passenger.reference]),
    );
    const items = await Promise.all(
      booking.passengers.map(async (link) => {
        const { facts, readiness, guidance } = await this.readinessOf(this.database.client, {
          bookingId: booking.id,
          passengerId: link.passengerId,
          bookingReference: booking.reference,
          passengerReference: link.passenger.reference,
        });
        const checkIn = await this.database.client.passengerCheckIn.findUnique({
          where: {
            bookingId_passengerId: { bookingId: booking.id, passengerId: link.passengerId },
          },
          select: checkInSelect,
        });
        return {
          passenger: link.passenger,
          seat: facts.seat ? { label: facts.seat.label } : null,
          readiness: readinessView(readiness, guidance),
          checkIn: checkIn ? customerCheckInView(checkIn) : null,
        };
      }),
    );
    return {
      booking: { reference: booking.reference },
      trip: tripView(booking.trip),
      seats: booking.seats
        .map((seat) => ({
          label: seat.seatMapCell.seatLabel ?? '',
          assignedTo: seat.passengerSeats[0]
            ? (referenceOf.get(seat.passengerSeats[0].passengerId) ?? null)
            : null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true })),
      items,
    };
  }

  async customerCheckInQr(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeCheckInReference(rawReference);
    const row = reference
      ? await this.database.client.passengerCheckIn.findFirst({
          where: {
            reference,
            bookingPassenger: { booking: { customerIdentityId: actor.identityId } },
          },
          select: { reference: true, credentialReference: true },
        })
      : null;
    if (!row) throw CheckInErrors.checkInNotFound();
    return { reference: row.reference, svg: renderBoardingQrSvg(row.credentialReference) };
  }

  // ---------------------------------------------------------------- STAFF

  /** Bounded, filtered list of booking passengers; each page is audited. */
  async staffList(actor: AuthPrincipal, query: CheckInListQuery) {
    const [cursorBooking, cursorPassenger] = query.cursor?.split('.') ?? [];
    const where: Prisma.BookingPassengerWhereInput = {
      booking: {
        confirmedAt: { not: null },
        ...(query.bookingReference ? { reference: query.bookingReference } : {}),
        ...(query.tripReference ? { trip: { reference: query.tripReference } } : {}),
      },
      ...(query.passengerReference ? { passenger: { reference: query.passengerReference } } : {}),
      // Each status filter is its own AND clause, so combinations never overwrite.
      AND: [
        ...(query.checkInStatus === 'CHECKED_IN' ? [{ checkIn: { isNot: null } }] : []),
        ...(query.checkInStatus === 'NOT_CHECKED_IN' ? [{ checkIn: { is: null } }] : []),
        ...(query.boardingStatus === 'BOARDED' ? [{ checkIn: { boarding: { isNot: null } } }] : []),
        ...(query.boardingStatus === 'NOT_BOARDED'
          ? [{ OR: [{ checkIn: { is: null } }, { checkIn: { boarding: { is: null } } }] }]
          : []),
      ],
    };
    const rows = await this.database.client.bookingPassenger.findMany({
      where,
      take: query.limit + 1,
      ...(cursorBooking && cursorPassenger
        ? {
            cursor: {
              bookingId_passengerId: { bookingId: cursorBooking, passengerId: cursorPassenger },
            },
            skip: 1,
          }
        : {}),
      orderBy: [{ bookingId: 'asc' }, { passengerId: 'asc' }],
      select: {
        bookingId: true,
        passengerId: true,
        passenger: { select: { reference: true, givenName: true, familyName: true } },
        booking: { select: { reference: true, trip: { select: tripSelect } } },
        seatAssignment: {
          select: { bookingSeat: { select: { seatMapCell: { select: { seatLabel: true } } } } },
        },
        checkIn: {
          select: {
            reference: true,
            checkedInAt: true,
            boarding: { select: { reference: true, boardedAt: true } },
          },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const items = await Promise.all(
      page.map(async (row) => {
        const { readiness } = await this.readinessOf(this.database.client, {
          bookingId: row.bookingId,
          passengerId: row.passengerId,
          bookingReference: row.booking.reference,
          passengerReference: row.passenger.reference,
        });
        return {
          passenger: row.passenger,
          booking: { reference: row.booking.reference },
          trip: tripView(row.booking.trip),
          seat: row.seatAssignment
            ? { label: row.seatAssignment.bookingSeat.seatMapCell.seatLabel ?? '' }
            : null,
          readiness: { eligible: readiness.eligible, blockers: readiness.blockers },
          checkIn: row.checkIn
            ? { reference: row.checkIn.reference, checkedInAt: row.checkIn.checkedInAt }
            : null,
          boarding: row.checkIn?.boarding ?? null,
        };
      }),
    );
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_CHECKIN_READINESS_ACCESSED',
          resourceType: 'booking_passenger',
          metadata: {
            access: 'LIST',
            references: items.map(
              (item) => `${item.booking.reference}/${item.passenger.reference}`,
            ),
            filters: {
              tripReference: query.tripReference ?? null,
              bookingReference: query.bookingReference ?? null,
              passengerReference: query.passengerReference ?? null,
              checkInStatus: query.checkInStatus ?? null,
              boardingStatus: query.boardingStatus ?? null,
            },
          },
        },
        tx,
      ),
    );
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? `${last.bookingId}.${last.passengerId}` : null,
    };
  }

  /** STAFF detail: readiness, seats, check-in and boarding; the read is audited. */
  async staffDetail(actor: AuthPrincipal, subject: CheckInSubject) {
    const result = await this.readinessOf(this.database.client, subject);
    const booking = await this.database.client.booking.findUniqueOrThrow({
      where: { id: subject.bookingId },
      select: {
        trip: { select: tripSelect },
        seats: {
          where: { releasedAt: null },
          select: {
            seatMapCell: { select: { seatLabel: true } },
            passengerSeats: { select: { passengerId: true } },
          },
        },
        passengers: {
          where: { passengerId: subject.passengerId },
          select: {
            passenger: { select: { reference: true, givenName: true, familyName: true } },
          },
        },
      },
    });
    const checkIn = await this.database.client.passengerCheckIn.findUnique({
      where: {
        bookingId_passengerId: { bookingId: subject.bookingId, passengerId: subject.passengerId },
      },
      select: checkInSelect,
    });
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_CHECKIN_READINESS_ACCESSED',
          resourceType: 'booking_passenger',
          resourceId: `${subject.bookingReference}/${subject.passengerReference}`,
          metadata: { access: 'DETAIL', blockers: result.readiness.blockers.map((b) => b.code) },
        },
        tx,
      ),
    );
    return {
      passenger: booking.passengers[0]?.passenger ?? null,
      booking: { reference: subject.bookingReference },
      trip: tripView(booking.trip),
      seat: result.facts.seat ? { label: result.facts.seat.label } : null,
      seats: booking.seats
        .map((seat) => ({
          label: seat.seatMapCell.seatLabel ?? '',
          assigned: seat.passengerSeats.length > 0,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true })),
      readiness: readinessView(result.readiness, result.guidance),
      checkIn: checkIn
        ? staffCheckInView(checkIn, {
            readiness: result.readiness,
            fingerprint: result.fingerprint,
          })
        : null,
    };
  }

  async staffCheckInQr(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeCheckInReference(rawReference);
    const row = reference
      ? await this.database.client.passengerCheckIn.findUnique({
          where: { reference },
          select: { id: true, reference: true, credentialReference: true },
        })
      : null;
    if (!row) throw CheckInErrors.checkInNotFound();
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_CHECKIN_READINESS_ACCESSED',
          resourceType: 'passenger_check_in',
          resourceId: row.id,
          metadata: { access: 'QR_LABEL', checkInReference: row.reference },
        },
        tx,
      ),
    );
    return { reference: row.reference, svg: renderBoardingQrSvg(row.credentialReference) };
  }
}
