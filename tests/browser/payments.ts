import { createHmac, randomBytes } from 'node:crypto';
import { createDatabaseClient } from '@euroteranga/database';
import { expect, type APIRequestContext } from '@playwright/test';
import { API_URL } from './apps.js';
import { bookingSeed, paymentSeed } from './fixtures.js';

/**
 * Test harness standing in for the SANDBOX payment provider: it signs events
 * with the API's webhook key (HMAC over "<timestamp>.<raw body>") and posts
 * them to the local API. No external service is ever contacted.
 */
function webhookKey(): Buffer {
  const secret = process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
  if (!secret) throw new Error('PAYMENT_SANDBOX_WEBHOOK_SECRET is required by the browser tests');
  return Buffer.from(secret, /[-_]/.test(secret) ? 'base64url' : 'base64');
}

function database() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Browser tests need DATABASE_URL (disposable test database)');
  return createDatabaseClient({ databaseUrl });
}

/** Sends a signed SANDBOX success event for the latest attempt of a booking. */
export async function sandboxSuccess(request: APIRequestContext, bookingReference: string) {
  const db = database();
  try {
    const payment = await db.payment.findFirstOrThrow({
      where: { booking: { reference: bookingReference }, status: 'PENDING' },
      orderBy: { id: 'desc' },
      include: { quote: true },
    });
    // What the provider collected: the quote's presentment amount (PAY-HUB-1).
    const raw = JSON.stringify({
      id: `evt_${randomBytes(12).toString('hex')}`,
      type: 'payment.succeeded',
      data: {
        providerPaymentId: payment.providerPaymentId,
        amountMinor: Number(payment.quote?.presentmentAmountMinor ?? payment.amountMinor),
        currency: payment.quote?.presentmentCurrencyCode ?? payment.currencyCode,
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', webhookKey()).update(`${timestamp}.${raw}`).digest('hex');
    const response = await request.post(`${API_URL}/v1/payments/webhooks/sandbox`, {
      headers: {
        'Content-Type': 'application/json',
        'ET-Sandbox-Signature': `t=${timestamp},v1=${digest}`,
      },
      data: raw,
    });
    expect(response.status()).toBe(200);
    return payment.reference;
  } finally {
    await db.$disconnect();
  }
}

/**
 * A real HELD booking of the payment customer on the payment trip, expiring
 * in `ttlMs`, written under every PostgreSQL guard (the API hold lifetime
 * cannot be that short): it lets the scenario reach the expiry quickly.
 */
export async function shortPaymentHold(
  customerEmail: string,
  seatLabel: string,
  ttlMs: number,
): Promise<{ id: string; reference: string }> {
  const db = database();
  const seed = paymentSeed();
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const reference = `ETB-${Array.from(randomBytes(12), (byte) => alphabet[byte % 32]).join('')}`;
  try {
    const customer = await db.authIdentity.findUniqueOrThrow({
      where: { realm_normalizedEmail: { realm: 'CUSTOMER', normalizedEmail: customerEmail } },
    });
    const trip = await db.trip.findUniqueOrThrow({
      where: { reference: seed.tripReference },
      include: { timings: { orderBy: { sequence: 'asc' } } },
    });
    const [origin, destination] = trip.timings;
    const fare = await db.fareEntry.findFirstOrThrow({
      where: {
        fareTableVersionId: trip.fareTableVersionId!,
        originRouteWaypointId: origin!.routeWaypointId,
        destinationRouteWaypointId: destination!.routeWaypointId,
      },
    });
    const cell = await db.seatMapCell.findFirstOrThrow({
      where: { seatMapVersionId: trip.seatMapVersionId!, seatLabel },
    });
    return await db.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
      const booking = await tx.booking.create({
        data: {
          reference,
          customerIdentityId: customer.id,
          tripId: trip.id,
          originRouteWaypointId: origin!.routeWaypointId,
          destinationRouteWaypointId: destination!.routeWaypointId,
          originSequence: 1,
          destinationSequence: 2,
          fareEntryId: fare.id,
          unitAmountMinor: fare.amountMinor,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          createdAt: now,
          holdExpiresAt: new Date(now.getTime() + ttlMs),
        },
      });
      const seat = await tx.bookingSeat.create({
        data: { bookingId: booking.id, seatMapCellId: cell.id, createdAt: now },
      });
      await tx.seatInventoryLock.create({
        data: {
          bookingSeatId: seat.id,
          tripId: trip.id,
          seatMapCellId: cell.id,
          segmentSequence: 1,
        },
      });
      return { id: booking.id, reference };
    });
  } finally {
    await db.$disconnect();
  }
}

/** Waits until the database clock has passed a booking's hold expiry. */
export async function waitForHoldExpiry(bookingId: string, timeoutMs: number): Promise<void> {
  const db = database();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<Array<{ expired: boolean }>>`
        SELECT "hold_expires_at" <= now() AS "expired" FROM "booking" WHERE "id" = ${bookingId}::uuid`;
      if (row?.expired) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the hold did not expire in time');
  } finally {
    await db.$disconnect();
  }
}

/** Origin and destination of the booking seed (shared by the payment trip). */
export function paymentSearch() {
  const booking = bookingSeed();
  return {
    origin: `Gare de départ réservation (Ville départ, ${booking.countryName})`,
    destination: `Gare d’arrivée réservation (Ville arrivée, ${booking.countryName})`,
    ...paymentSeed(),
  };
}
