import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { BoardingScanInput } from './check-in.dto.js';
import { CheckInBlockedError, CheckInErrors } from './check-in.errors.js';
import {
  boardingPayloadFingerprint,
  generateBoardingReference,
  parseBoardingQrPayload,
  withFreshReferences,
} from './check-in-rules.js';
import { CheckInService, checkInDomainError, type CheckInSubject } from './check-in.service.js';
import { checkInSelect, readinessView, staffCheckInView } from './check-in-views.js';

const THIRTY_DAYS = 30 * 24 * 3_600_000;
const FIVE_MINUTES = 5 * 60_000;

const boardingSelect = {
  reference: true,
  checkInId: true,
  deviceId: true,
  clientEventId: true,
  payloadFingerprint: true,
  occurredAt: true,
  boardedAt: true,
} as const;

function boardingView(row: {
  reference: string;
  occurredAt: Date;
  boardedAt: Date;
  deviceId: string;
}) {
  return {
    reference: row.reference,
    boardedAt: row.boardedAt,
    occurredAt: row.occurredAt,
    deviceId: row.deviceId,
  };
}

/**
 * Boarding by authenticated QR scan. The QR only identifies a credential:
 * every scan re-derives all check-in gates, and PostgreSQL allows one
 * boarding per check-in, hence per BookingPassenger.
 */
@Injectable()
export class BoardingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly checkIns: CheckInService,
  ) {}

  private credential(qrPayload: string): string {
    const credential = parseBoardingQrPayload(qrPayload);
    if (!credential) throw CheckInErrors.qrInvalid();
    return credential;
  }

  private subjectOf(checkIn: {
    bookingId: string;
    passengerId: string;
    bookingPassenger: { booking: { reference: string }; passenger: { reference: string } };
  }): CheckInSubject {
    return {
      bookingId: checkIn.bookingId,
      passengerId: checkIn.passengerId,
      bookingReference: checkIn.bookingPassenger.booking.reference,
      passengerReference: checkIn.bookingPassenger.passenger.reference,
    };
  }

  /** Authenticated lookup before boarding: passenger, seat, trip and current gates. */
  async resolve(actor: AuthPrincipal, qrPayload: string) {
    const credentialReference = this.credential(qrPayload);
    const row = await this.database.client.passengerCheckIn.findUnique({
      where: { credentialReference },
      select: checkInSelect,
    });
    if (!row) throw CheckInErrors.credentialNotFound();
    const subject = this.subjectOf(row);
    const current = await this.checkIns.readinessOf(this.database.client, subject);
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_BOARDING_ACCESSED',
          resourceType: 'passenger_check_in',
          resourceId: row.id,
          metadata: {
            access: 'RESOLVE',
            checkInReference: row.reference,
            blockers: current.readiness.blockers.map((blocker) => blocker.code),
          },
        },
        tx,
      ),
    );
    return {
      checkIn: staffCheckInView(row, current),
      readiness: readinessView(current.readiness, []),
    };
  }

  /**
   * SCAN → AUTH → RBAC (guards) → parse/version → lock → replay → revalidate
   * every gate → board → audit, in one transaction. A same clientEventId with
   * the same payload returns the original boarding (created: false).
   */
  async scan(actor: AuthPrincipal, input: BoardingScanInput) {
    const credentialReference = this.credential(input.qrPayload);
    const occurredAt = input.occurredAt ?? new Date();
    const now = Date.now();
    if (occurredAt.getTime() < now - THIRTY_DAYS || occurredAt.getTime() > now + FIVE_MINUTES) {
      throw CheckInErrors.invalidTimestamp();
    }
    await this.rateLimits.consume(RATE_LIMITS.boardingScanIdentity, actor.identityId);
    const payloadFingerprint = boardingPayloadFingerprint({
      credentialReference,
      deviceId: input.deviceId,
      occurredAt,
    });

    // Filled inside the transaction callback when a stale credential is refused.
    const refusal: { value: { checkInId: string; checkInReference: string } | null } = {
      value: null,
    };
    try {
      return await withFreshReferences(
        () =>
          this.database.client.$transaction(
            async (tx) => {
              const [locked] = await tx.$queryRaw<
                Array<{ id: string; reference: string; checked_in_at: Date }>
              >`
                SELECT "id", "reference", "checked_in_at" FROM "passenger_check_in"
                WHERE "credential_reference" = ${credentialReference}
                FOR UPDATE`;
              if (!locked) throw CheckInErrors.credentialNotFound();

              if (input.clientEventId) {
                const replay = await tx.passengerBoarding.findUnique({
                  where: {
                    deviceId_clientEventId: {
                      deviceId: input.deviceId,
                      clientEventId: input.clientEventId,
                    },
                  },
                  select: boardingSelect,
                });
                if (replay) {
                  if (
                    replay.checkInId !== locked.id ||
                    replay.payloadFingerprint !== payloadFingerprint
                  ) {
                    throw CheckInErrors.idempotencyConflict();
                  }
                  return { created: false, boarding: boardingView(replay) };
                }
              }
              const existing = await tx.passengerBoarding.findUnique({
                where: { checkInId: locked.id },
                select: { id: true },
              });
              if (existing) throw CheckInErrors.alreadyBoarded();
              if (occurredAt.getTime() < locked.checked_in_at.getTime() - FIVE_MINUTES) {
                throw CheckInErrors.invalidTimestamp();
              }

              const row = await tx.passengerCheckIn.findUniqueOrThrow({
                where: { id: locked.id },
                select: checkInSelect,
              });
              const subject = this.subjectOf(row);
              const current = await this.checkIns.readinessOf(tx, subject);
              if (!current.readiness.eligible) {
                refusal.value = { checkInId: locked.id, checkInReference: locked.reference };
                throw CheckInErrors.stale(current.readiness.blockers);
              }
              const boarding = await tx.passengerBoarding.create({
                data: {
                  reference: generateBoardingReference(),
                  checkInId: locked.id,
                  deviceId: input.deviceId,
                  ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
                  payloadFingerprint,
                  readinessFingerprint: current.fingerprint,
                  occurredAt,
                  boardedByIdentityId: actor.identityId,
                },
                select: boardingSelect,
              });
              await this.audit.record(
                {
                  actor,
                  action: 'PASSENGER_BOARDED',
                  resourceType: 'passenger_check_in',
                  resourceId: locked.id,
                  metadata: {
                    boardingReference: boarding.reference,
                    checkInReference: locked.reference,
                    bookingReference: subject.bookingReference,
                    passengerReference: subject.passengerReference,
                    tripReference: current.facts.trip.reference,
                    seatLabel: current.facts.seat?.label ?? null,
                    deviceId: input.deviceId,
                    factsChangedSinceCheckIn: current.fingerprint !== row.readinessFingerprint,
                  },
                },
                tx,
              );
              return { created: true, boarding: boardingView(boarding) };
            },
            { timeout: 15_000 },
          ),
        (error) => String(error).includes('passenger_boarding_reference_key'),
      );
    } catch (error) {
      if (error instanceof CheckInBlockedError && refusal.value) {
        await this.auditRefusal(actor, refusal.value, input.deviceId, error);
      }
      if (String(error).includes('passenger_boarding_check_in_id_key')) {
        throw CheckInErrors.alreadyBoarded();
      }
      if (String(error).includes('boarding occurred_at is outside')) {
        throw CheckInErrors.invalidTimestamp();
      }
      if (String(error).includes('boarding requires a confirmed')) {
        throw CheckInErrors.stale([]);
      }
      return checkInDomainError(error);
    }
  }

  /** A refused stale credential is a security-relevant fact: audit it apart. */
  private async auditRefusal(
    actor: AuthPrincipal,
    refused: { checkInId: string; checkInReference: string },
    deviceId: string,
    error: CheckInBlockedError,
  ) {
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'PASSENGER_BOARDING_REFUSED',
          resourceType: 'passenger_check_in',
          resourceId: refused.checkInId,
          metadata: {
            checkInReference: refused.checkInReference,
            code: error.code,
            blockers: error.blockers.map((blocker) => blocker.code),
            deviceId,
          },
        },
        tx,
      ),
    );
  }
}
