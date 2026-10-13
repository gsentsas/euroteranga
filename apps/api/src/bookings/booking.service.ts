import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { cancelPendingPayments, lockPendingPayments } from '../payments/payment-transitions.js';
import { findTripFare } from '../pricing/fare-resolution.service.js';
import { BOOKING_CONFIG, type BookingConfig } from './booking.config.js';
import type { AdminBookingListQuery, BookingCreate } from './booking.dto.js';
import { BookingErrors } from './booking.errors.js';
import {
  databaseNow,
  occupiedSeatCells,
  readBookableTrip,
  releaseCancelledHold,
  releaseExpiredHolds,
  seatLabelsOf,
} from './booking-inventory.js';
import {
  journeySegments,
  normalizeBookingReference,
  totalAmountMinor,
  withFreshReference,
} from './booking-rules.js';
import {
  adminBookingInclude,
  adminBookingView,
  bookingInclude,
  customerBookingView,
} from './booking-views.js';

const CUSTOMER_CANCELLATION_REASON = 'Annulation par le client';

/** Which unique index a P2002 error comes from (driver-adapter aware). */
function uniqueViolationOn(error: unknown, ...fragments: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const details = JSON.stringify(error.meta ?? {});
  return fragments.some((fragment) => details.includes(fragment));
}

/** Expected database failures become stable public errors. */
function translate(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (uniqueViolationOn(error, 'segment_sequence', 'seat_inventory_lock')) {
    throw BookingErrors.seatUnavailable();
  }
  throw error;
}

/**
 * Booking holds of authenticated CUSTOMERs (the booker, not a passenger) and
 * their STAFF administration. Every mutation and its audit event share one
 * transaction: an audit failure rolls the whole change back.
 */
@Injectable()
export class BookingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(BOOKING_CONFIG) private readonly config: BookingConfig,
  ) {}

  /**
   * Creates a provisional hold for the calling CUSTOMER. Lock order: trip FOR
   * SHARE, expired holds FOR UPDATE (by id), then the new booking, its seats
   * and its segment locks (sorted, so concurrent holds cannot deadlock). The
   * unique index on (trip, seat, segment) is the final authority against
   * overbooking: a lost race is BOOKING_SEAT_UNAVAILABLE, with no partial state.
   */
  async create(input: BookingCreate, actor: AuthPrincipal) {
    const seatIds = input.seatMapCellIds;
    if (new Set(seatIds).size !== seatIds.length) throw BookingErrors.seatInvalid();
    if (seatIds.length > this.config.maxSeatsPerHold) {
      throw BookingErrors.tooManySeats(this.config.maxSeatsPerHold);
    }
    const reference = await withFreshReference(
      async (candidate) => {
        try {
          return await this.database.client.$transaction((tx) =>
            this.createInTransaction(tx, input, actor, candidate),
          );
        } catch (error) {
          if (uniqueViolationOn(error, 'reference')) throw error;
          return translate(error);
        }
      },
      (error) => uniqueViolationOn(error, 'reference'),
    );
    return this.customerBooking(actor, reference);
  }

  private async createInTransaction(
    tx: DatabaseTransaction,
    input: BookingCreate,
    actor: AuthPrincipal,
    reference: string,
  ): Promise<string> {
    const trip = await readBookableTrip(tx, input.tripId, this.config.holdTtlSeconds, true);
    await releaseExpiredHolds(tx, trip.id);

    const fare = await findTripFare(
      tx,
      trip,
      input.originRouteWaypointId,
      input.destinationRouteWaypointId,
    );
    if (!fare.ok) {
      if (fare.reason === 'PRICING_NOT_CONFIGURED') throw BookingErrors.pricingNotConfigured();
      if (fare.reason === 'WAYPOINT_INVALID') throw BookingErrors.odInvalid();
      throw BookingErrors.fareNotConfigured();
    }

    // Seats of the trip's historical seat map (PR-07), never the vehicle's.
    const cells = await tx.seatMapCell.findMany({
      where: {
        id: { in: input.seatMapCellIds },
        seatMapVersionId: trip.seatMapVersionId,
        kind: 'SEAT',
      },
      select: { id: true, seatLabel: true },
    });
    if (cells.length !== input.seatMapCellIds.length) throw BookingErrors.seatInvalid();
    const occupied = await occupiedSeatCells(
      tx,
      trip.id,
      fare.originSequence,
      fare.destinationSequence,
    );
    if (cells.some((cell) => occupied.has(cell.id))) throw BookingErrors.seatUnavailable();

    const booking = await tx.booking.create({
      data: {
        reference,
        customerIdentityId: actor.identityId,
        tripId: trip.id,
        originRouteWaypointId: input.originRouteWaypointId,
        destinationRouteWaypointId: input.destinationRouteWaypointId,
        originSequence: fare.originSequence,
        destinationSequence: fare.destinationSequence,
        fareEntryId: fare.fareEntryId,
        unitAmountMinor: fare.amountMinor,
        currencyCode: fare.currencyCode,
        currencyMinorUnit: fare.currencyMinorUnit,
        holdExpiresAt: trip.holdExpiresAt,
        createdAt: trip.now,
      },
      select: { id: true },
    });
    const sortedCells = [...cells].sort((left, right) => left.id.localeCompare(right.id));
    await tx.bookingSeat.createMany({
      data: sortedCells.map((cell) => ({
        bookingId: booking.id,
        seatMapCellId: cell.id,
        createdAt: trip.now,
      })),
    });
    const seats = await tx.bookingSeat.findMany({
      where: { bookingId: booking.id },
      select: { id: true, seatMapCellId: true },
    });
    const segments = journeySegments(fare.originSequence, fare.destinationSequence);
    await tx.seatInventoryLock.createMany({
      data: [...seats]
        .sort((left, right) => left.seatMapCellId.localeCompare(right.seatMapCellId))
        .flatMap((seat) =>
          segments.map((segmentSequence) => ({
            bookingSeatId: seat.id,
            tripId: trip.id,
            seatMapCellId: seat.seatMapCellId,
            segmentSequence,
          })),
        ),
    });
    await this.audit.record(
      {
        actor,
        action: 'BOOKING_HELD',
        resourceType: 'booking',
        resourceId: booking.id,
        after: {
          reference,
          status: 'HELD',
          tripId: trip.id,
          tripReference: trip.reference,
          originRouteWaypointId: input.originRouteWaypointId,
          destinationRouteWaypointId: input.destinationRouteWaypointId,
          seatLabels: sortedCells.map((cell) => cell.seatLabel ?? ''),
          unitAmountMinor: fare.amountMinor,
          seatCount: cells.length,
          totalAmountMinor: totalAmountMinor(fare.amountMinor, cells.length),
          currencyCode: fare.currencyCode,
          holdExpiresAt: trip.holdExpiresAt,
        },
      },
      tx,
    );
    return reference;
  }

  /** The caller's own bookings, newest first; the cursor is a reference. */
  async customerBookings(
    actor: AuthPrincipal,
    query: { limit: number; cursor?: string | undefined },
  ) {
    const client = this.database.client;
    let cursorId: string | undefined;
    if (query.cursor) {
      const reference = normalizeBookingReference(query.cursor);
      const anchor = reference
        ? await client.booking.findFirst({
            where: { reference, customerIdentityId: actor.identityId },
            select: { id: true },
          })
        : null;
      if (!anchor) throw BookingErrors.notFound();
      cursorId = anchor.id;
    }
    const [rows, now] = await Promise.all([
      client.booking.findMany({
        take: query.limit + 1,
        where: {
          customerIdentityId: actor.identityId,
          ...(cursorId ? { id: { lt: cursorId } } : {}),
        },
        orderBy: { id: 'desc' },
        include: bookingInclude,
      }),
      databaseNow(client),
    ]);
    const items = rows.slice(0, query.limit).map((row) => customerBookingView(row, now));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.reference ?? null) : null,
    };
  }

  /** Never by reference alone: always scoped to the calling CUSTOMER. */
  async customerBooking(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) throw BookingErrors.notFound();
    const client = this.database.client;
    const [row, now] = await Promise.all([
      client.booking.findFirst({
        where: { reference, customerIdentityId: actor.identityId },
        include: bookingInclude,
      }),
      databaseNow(client),
    ]);
    if (!row) throw BookingErrors.notFound();
    return customerBookingView(row, now);
  }

  /** The owner cancels an active hold; unknown and foreign bookings are alike. */
  async cancelByCustomer(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) throw BookingErrors.notFound();
    const target = await this.database.client.booking.findFirst({
      where: { reference, customerIdentityId: actor.identityId },
      select: { id: true },
    });
    if (!target) throw BookingErrors.notFound();
    await this.cancel(
      target.id,
      (tx) => tx.$queryRaw<LockedBooking[]>`
        SELECT "id", "reference", "trip_id", "cancelled_at", "confirmed_at", "hold_expires_at"
        FROM "booking"
        WHERE "id" = ${target.id}::uuid AND "customer_identity_id" = ${actor.identityId}::uuid
        FOR UPDATE
      `,
      actor,
      CUSTOMER_CANCELLATION_REASON,
      'CUSTOMER',
    );
    return this.customerBooking(actor, reference);
  }

  /** booking.manage: cancel an active hold, with a mandatory reason. */
  async cancelByStaff(actor: AuthPrincipal, id: string, reason: string) {
    await this.cancel(
      id,
      (tx) => tx.$queryRaw<LockedBooking[]>`
        SELECT "id", "reference", "trip_id", "cancelled_at", "confirmed_at", "hold_expires_at"
        FROM "booking" WHERE "id" = ${id}::uuid
        FOR UPDATE
      `,
      actor,
      reason,
      'STAFF',
    );
    return this.adminBooking(id);
  }

  /**
   * Lock order: the booking's PENDING payments FOR UPDATE (by id) -> booking
   * FOR UPDATE -> seats -> locks, the same payment -> booking order as the
   * webhook pipeline. A second concurrent cancellation waits, then sees the
   * booking cancelled. A CONFIRMED booking is refused (no refund workflow
   * yet); a PENDING attempt is cancelled with its hold (PR-10).
   */
  private async cancel(
    bookingId: string,
    lock: (tx: DatabaseTransaction) => Promise<LockedBooking[]>,
    actor: AuthPrincipal,
    reason: string,
    by: 'CUSTOMER' | 'STAFF',
  ) {
    try {
      await this.database.client.$transaction(async (tx) => {
        const pendingPayments = await lockPendingPayments(tx, { bookingId });
        const [booking] = await lock(tx);
        if (!booking) throw BookingErrors.notFound();
        if (booking.cancelled_at) throw BookingErrors.cancelled();
        if (booking.confirmed_at) throw BookingErrors.confirmed();
        const now = await databaseNow(tx);
        if (booking.hold_expires_at.getTime() <= now.getTime()) throw BookingErrors.expired();
        // An attempt started between the two locks cannot be locked now
        // without inverting the order: report a conflict instead.
        const pendingNow = await tx.payment.count({
          where: { bookingId: booking.id, status: 'PENDING' },
        });
        if (pendingNow !== pendingPayments.length) throw BookingErrors.cancelConflict();
        await cancelPendingPayments(tx, this.audit, pendingPayments, {
          actor,
          reason,
          cancelledBy: by,
        });
        const seatLabels = await seatLabelsOf(tx, booking.id);
        await releaseCancelledHold(tx, booking.id, now, reason);
        await this.audit.record(
          {
            actor,
            action: 'BOOKING_CANCELLED',
            resourceType: 'booking',
            resourceId: booking.id,
            before: { status: 'HELD' },
            after: { status: 'CANCELLED', cancelledAt: now },
            metadata: {
              reference: booking.reference,
              tripId: booking.trip_id,
              seatLabels,
              reason,
              cancelledBy: by,
            },
          },
          tx,
        );
      });
    } catch (error) {
      translate(error);
    }
  }

  async adminBookings(query: AdminBookingListQuery) {
    const client = this.database.client;
    const now = await databaseNow(client);
    const statusFilter: Prisma.BookingWhereInput =
      query.status === 'CANCELLED'
        ? { cancelledAt: { not: null } }
        : query.status === 'CONFIRMED'
          ? { cancelledAt: null, confirmedAt: { not: null } }
          : query.status === 'EXPIRED'
            ? { cancelledAt: null, confirmedAt: null, holdExpiresAt: { lte: now } }
            : query.status === 'HELD'
              ? { cancelledAt: null, confirmedAt: null, holdExpiresAt: { gt: now } }
              : {};
    const rows = await client.booking.findMany({
      take: query.limit + 1,
      where: {
        ...statusFilter,
        ...(query.tripId ? { tripId: query.tripId } : {}),
        ...(query.reference ? { reference: query.reference } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      include: bookingInclude,
    });
    const items = rows.slice(0, query.limit).map((row) => adminBookingView(row, now));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Booking detail. Its payment attempts are included only for callers
   * holding payment.read (financial details are minimized under RBAC).
   */
  async adminBooking(id: string, options: { withPayments?: boolean } = {}) {
    const client = this.database.client;
    const [row, now] = await Promise.all([
      client.booking.findUnique({ where: { id }, include: adminBookingInclude }),
      databaseNow(client),
    ]);
    if (!row) throw BookingErrors.notFound();
    return adminBookingView(row, now, options);
  }
}

interface LockedBooking {
  id: string;
  reference: string;
  trip_id: string;
  cancelled_at: Date | null;
  confirmed_at: Date | null;
  hold_expires_at: Date;
}
