import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import type { AuditService } from '../authorization/audit.service.js';
import { BookingErrors } from './booking.errors.js';

/**
 * Inventory operations shared by bookings and trip cancellation. They run in
 * the caller's transaction. Lock order (no cycle, see docs/domain/bookings.md):
 *
 * - booking creation: trip FOR SHARE -> expired bookings FOR UPDATE (by id)
 *   -> new booking -> booking seats -> seat locks (sorted);
 * - booking cancellation: booking FOR UPDATE -> booking seats -> seat locks;
 * - trip cancellation: trip FOR UPDATE -> bookings FOR UPDATE (by id) ->
 *   booking seats -> seat locks.
 *
 * No path takes the trip after a booking.
 */

/** Current time of the database transaction (the clock every rule uses). */
export async function databaseNow(client: DatabaseTransaction): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
  return row!.now;
}

export interface BookableTrip {
  id: string;
  reference: string;
  routeVersionId: string;
  seatMapVersionId: string;
  fareTableVersionId: string;
  plannedDepartureAt: Date;
  /** Database time of the read. */
  now: Date;
  /** now + hold TTL, never after the departure. */
  holdExpiresAt: Date;
}

/**
 * Reads a trip that can be booked now, or throws the public reason. Unknown,
 * DRAFT and CANCELLED trips are indistinguishable (not bookable). With
 * `lock`, the trip row is taken FOR SHARE: bookings proceed in parallel while
 * a trip cancellation (FOR UPDATE) is serialized against them.
 */
export async function readBookableTrip(
  client: DatabaseTransaction,
  tripId: string,
  holdTtlSeconds: number,
  lock: boolean,
): Promise<BookableTrip> {
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      reference: string;
      status: string;
      route_version_id: string;
      seat_map_version_id: string | null;
      fare_table_version_id: string | null;
      planned_departure_at: Date | null;
      db_now: Date;
      hold_expires_at: Date | null;
    }>
  >`
    SELECT t."id", t."reference", t."status"::text AS "status", t."route_version_id",
      t."seat_map_version_id", t."fare_table_version_id", t."planned_departure_at",
      now() AS "db_now",
      LEAST(now() + ${holdTtlSeconds}::int * interval '1 second', t."planned_departure_at")
        AS "hold_expires_at"
    FROM "trip" t
    WHERE t."id" = ${tripId}::uuid
    ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}
  `;
  const row = rows[0];
  if (!row || row.status !== 'SCHEDULED') throw BookingErrors.tripNotBookable();
  if (!row.planned_departure_at || row.planned_departure_at.getTime() <= row.db_now.getTime()) {
    throw BookingErrors.tripDeparted();
  }
  if (!row.seat_map_version_id) throw BookingErrors.seatMapNotConfigured();
  if (!row.fare_table_version_id) throw BookingErrors.pricingNotConfigured();
  return {
    id: row.id,
    reference: row.reference,
    routeVersionId: row.route_version_id,
    seatMapVersionId: row.seat_map_version_id,
    fareTableVersionId: row.fare_table_version_id,
    plannedDepartureAt: row.planned_departure_at,
    now: row.db_now,
    holdExpiresAt: row.hold_expires_at ?? row.planned_departure_at,
  };
}

/**
 * Seats occupied on at least one segment of [origin, destination): a lock
 * counts only while its hold is active (not cancelled, not expired by the
 * database clock), so a stale lock of an expired hold never blocks a seat.
 */
export async function occupiedSeatCells(
  client: DatabaseTransaction,
  tripId: string,
  originSequence: number,
  destinationSequence: number,
): Promise<Set<string>> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT l."seat_map_cell_id" AS "id"
    FROM "seat_inventory_lock" l
    JOIN "booking_seat" bs ON bs."id" = l."booking_seat_id"
    JOIN "booking" b ON b."id" = bs."booking_id"
    WHERE l."trip_id" = ${tripId}::uuid
      AND l."segment_sequence" >= ${originSequence}::int
      AND l."segment_sequence" < ${destinationSequence}::int
      AND b."cancelled_at" IS NULL
      AND b."hold_expires_at" > now()
  `;
  return new Set(rows.map((row) => row.id));
}

/**
 * Physically releases the inventory of the trip's expired holds: their seats
 * are marked released at the hold expiry and their locks deleted. The
 * bookings themselves stay (EXPIRED is derived). Bookings are locked FOR
 * UPDATE in id order, so concurrent cleanups cannot deadlock.
 */
export async function releaseExpiredHolds(
  tx: DatabaseTransaction,
  tripId: string,
): Promise<string[]> {
  const expired = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT b."id"
    FROM "booking" b
    WHERE b."trip_id" = ${tripId}::uuid
      AND b."cancelled_at" IS NULL
      AND b."hold_expires_at" <= now()
      AND (
        EXISTS (
          SELECT 1 FROM "booking_seat" bs
          WHERE bs."booking_id" = b."id" AND bs."released_at" IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM "booking_seat" bs
          JOIN "seat_inventory_lock" l ON l."booking_seat_id" = bs."id"
          WHERE bs."booking_id" = b."id"
        )
      )
    ORDER BY b."id"
    FOR UPDATE OF b
  `;
  const ids = expired.map((row) => row.id);
  if (ids.length === 0) return ids;
  await tx.$executeRaw`
    UPDATE "booking_seat" bs
    SET "released_at" = b."hold_expires_at"
    FROM "booking" b
    WHERE bs."booking_id" = b."id"
      AND b."id" = ANY(${ids}::uuid[])
      AND bs."released_at" IS NULL
  `;
  await tx.$executeRaw`
    DELETE FROM "seat_inventory_lock" l
    USING "booking_seat" bs
    WHERE l."booking_seat_id" = bs."id" AND bs."booking_id" = ANY(${ids}::uuid[])
  `;
  return ids;
}

/**
 * Cancels one active hold, already locked FOR UPDATE by the caller: the
 * booking keeps its history, its seats are released and its locks deleted,
 * so the seats are immediately available again.
 */
export async function releaseCancelledHold(
  tx: DatabaseTransaction,
  bookingId: string,
  cancelledAt: Date,
  reason: string,
): Promise<void> {
  await tx.booking.update({
    where: { id: bookingId },
    data: { cancelledAt, cancellationReason: reason },
  });
  await tx.bookingSeat.updateMany({
    where: { bookingId, releasedAt: null },
    data: { releasedAt: cancelledAt },
  });
  await tx.$executeRaw`
    DELETE FROM "seat_inventory_lock" l
    USING "booking_seat" bs
    WHERE l."booking_seat_id" = bs."id" AND bs."booking_id" = ${bookingId}::uuid
  `;
}

export async function seatLabelsOf(tx: DatabaseTransaction, bookingId: string): Promise<string[]> {
  const seats = await tx.bookingSeat.findMany({
    where: { bookingId },
    select: { seatMapCell: { select: { seatLabel: true } } },
    orderBy: { seatMapCell: { seatLabel: 'asc' } },
  });
  return seats.map((seat) => seat.seatMapCell.seatLabel ?? '');
}

const MAX_REASON = 500;

/**
 * Trip cancellation cascade, inside the trip's transaction (trip already
 * locked FOR UPDATE): every active hold is cancelled, its seats released and
 * its locks deleted, each with a BOOKING_CANCELLED_BY_TRIP audit event by the
 * STAFF member cancelling the trip. Expired holds only get their inventory
 * released. Returns the number of holds cancelled.
 */
export async function cancelTripHolds(
  tx: DatabaseTransaction,
  audit: AuditService,
  input: { tripId: string; tripReference: string; actor: AuthPrincipal; reason: string },
): Promise<number> {
  await releaseExpiredHolds(tx, input.tripId);
  const active = await tx.$queryRaw<Array<{ id: string; reference: string }>>`
    SELECT b."id", b."reference"
    FROM "booking" b
    WHERE b."trip_id" = ${input.tripId}::uuid
      AND b."cancelled_at" IS NULL
      AND b."hold_expires_at" > now()
    ORDER BY b."id"
    FOR UPDATE OF b
  `;
  if (active.length === 0) return 0;
  const now = await databaseNow(tx);
  const reason = `Voyage annulé : ${input.reason}`.slice(0, MAX_REASON).trim();
  for (const booking of active) {
    const seatLabels = await seatLabelsOf(tx, booking.id);
    await releaseCancelledHold(tx, booking.id, now, reason);
    await audit.record(
      {
        actor: input.actor,
        action: 'BOOKING_CANCELLED_BY_TRIP',
        resourceType: 'booking',
        resourceId: booking.id,
        before: { status: 'HELD' },
        after: { status: 'CANCELLED', cancelledAt: now },
        metadata: {
          reference: booking.reference,
          tripId: input.tripId,
          tripReference: input.tripReference,
          seatLabels,
          reason,
        },
      },
      tx,
    );
  }
  return active.length;
}
