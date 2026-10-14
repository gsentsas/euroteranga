import type { DatabaseTransaction } from '@euroteranga/database';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import type { AuditService } from '../authorization/audit.service.js';

/** A PENDING attempt already locked FOR UPDATE by the caller. */
export interface LockedPendingPayment {
  id: string;
  reference: string;
  bookingReference: string;
}

/**
 * Locks the PENDING attempts of the given bookings, in id order. Callers lock
 * payments before bookings (lock hierarchy trip -> payment -> booking), like
 * the webhook pipeline, so no cycle can form.
 */
export async function lockPendingPayments(
  tx: DatabaseTransaction,
  where: { bookingId: string } | { tripId: string },
): Promise<LockedPendingPayment[]> {
  const rows =
    'bookingId' in where
      ? await tx.$queryRaw<Array<{ id: string; reference: string; booking_reference: string }>>`
          SELECT p."id", p."reference", b."reference" AS "booking_reference"
          FROM "payment" p JOIN "booking" b ON b."id" = p."booking_id"
          WHERE p."booking_id" = ${where.bookingId}::uuid AND p."status" = 'PENDING'
          ORDER BY p."id"
          FOR UPDATE OF p
        `
      : await tx.$queryRaw<Array<{ id: string; reference: string; booking_reference: string }>>`
          SELECT p."id", p."reference", b."reference" AS "booking_reference"
          FROM "payment" p JOIN "booking" b ON b."id" = p."booking_id"
          WHERE b."trip_id" = ${where.tripId}::uuid AND p."status" = 'PENDING'
          ORDER BY p."id"
          FOR UPDATE OF p
        `;
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    bookingReference: row.booking_reference,
  }));
}

/**
 * Cancels locked PENDING attempts (never a terminal one), each with a
 * PAYMENT_CANCELLED audit event in the caller's transaction. Cancelling an
 * attempt is not cancelling its booking. No provider is called: SANDBOX has
 * nothing to void; a real provider will need a void step (deferred, ADR-027).
 */
export async function cancelPendingPayments(
  tx: DatabaseTransaction,
  audit: AuditService,
  payments: readonly LockedPendingPayment[],
  input: { actor?: AuthPrincipal; reason: string; cancelledBy: 'CUSTOMER' | 'STAFF' | 'TRIP' },
): Promise<void> {
  if (payments.length === 0) return;
  // Database clock (no import of the booking inventory: it imports this file).
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
  for (const payment of payments) {
    await tx.payment.update({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    await audit.record(
      {
        actor: input.actor,
        action: 'PAYMENT_CANCELLED',
        resourceType: 'payment',
        resourceId: payment.id,
        before: { status: 'PENDING' },
        after: { status: 'CANCELLED', cancelledAt: now },
        metadata: {
          reference: payment.reference,
          bookingReference: payment.bookingReference,
          reason: input.reason,
          cancelledBy: input.cancelledBy,
        },
      },
      tx,
    );
  }
}
