import { randomBytes } from 'node:crypto';
import { decodeSecretKey, type ApiEnv } from '@euroteranga/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { signSandboxPayload } from '../../src/payments/providers/sandbox-payment.provider.js';
import { db } from './auth-helpers.js';
import type { BookableFixture, CustomerActor } from './booking-helpers.js';

export const WEBHOOK_PATH = '/v1/payments/webhooks/sandbox';

/** Customer payment calls (session cookie, customer origin, CSRF on POST). */
export function paymentApi(actor: CustomerActor) {
  return {
    create: async (
      bookingReference: string,
      options: { key?: string; csrf?: string | null; body?: unknown } = {},
    ) => {
      const csrf = options.csrf === undefined ? await actor.csrf() : options.csrf;
      return actor.http
        .post(
          `/v1/booking/bookings/${bookingReference}/payments`,
          options.body ?? {},
          actor.cookie,
          csrf ?? undefined,
        )
        .set(options.key ? { 'Idempotency-Key': options.key } : {});
    },
    list: (bookingReference: string) =>
      actor.http.get(`/v1/booking/bookings/${bookingReference}/payments`, actor.cookie),
    cancel: async (paymentReference: string, options: { csrf?: string | null } = {}) => {
      const csrf = options.csrf === undefined ? await actor.csrf() : options.csrf;
      return actor.http.post(
        `/v1/booking/payments/${paymentReference}/cancel`,
        {},
        actor.cookie,
        csrf ?? undefined,
      );
    },
  };
}

/** Fresh client idempotency key (as a browser would generate). */
export const idempotencyKey = () => randomBytes(16).toString('hex');

export interface SandboxEventInput {
  type: 'payment.succeeded' | 'payment.failed';
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  failureReason?: string;
  id?: string;
}

/** A SANDBOX provider event body (raw JSON, exactly as signed). */
export function sandboxEvent(input: SandboxEventInput): string {
  return JSON.stringify({
    id: input.id ?? `evt_${randomBytes(12).toString('hex')}`,
    type: input.type,
    data: {
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    },
  });
}

/** Sends a raw webhook, signed with the app's SANDBOX key unless overridden. */
export function sendWebhook(
  app: NestExpressApplication,
  env: ApiEnv,
  raw: string,
  options: {
    timestamp?: number;
    signature?: string | null;
    contentType?: string;
    signedBody?: string;
  } = {},
) {
  const key = decodeSecretKey(env.PAYMENT_SANDBOX_WEBHOOK_SECRET!);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    options.signature === undefined
      ? signSandboxPayload(key, timestamp, options.signedBody ?? raw)
      : options.signature;
  let call = request(app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set('Content-Type', options.contentType ?? 'application/json');
  if (signature !== null) call = call.set('ET-Sandbox-Signature', signature);
  return call.send(raw);
}

/** The provider's opaque id of an attempt (test harness only: never in a customer view). */
export async function providerPaymentIdOf(
  app: NestExpressApplication,
  paymentReference: string,
): Promise<string> {
  const payment = await db(app).payment.findUniqueOrThrow({
    where: { reference: paymentReference },
    select: { providerPaymentId: true },
  });
  return payment.providerPaymentId!;
}

/** Signed success (or failure) event for an attempt, as the provider would send it. */
export async function settle(
  app: NestExpressApplication,
  env: ApiEnv,
  payment: { reference: string; amountMinor: number; currencyCode: string },
  outcome: 'payment.succeeded' | 'payment.failed' = 'payment.succeeded',
  extra: Partial<SandboxEventInput> = {},
) {
  const raw = sandboxEvent({
    type: outcome,
    providerPaymentId: await providerPaymentIdOf(app, payment.reference),
    amountMinor: payment.amountMinor,
    currency: payment.currencyCode,
    ...extra,
  });
  return sendWebhook(app, env, raw);
}

/**
 * A real hold of the customer whose expiry is `ttlMs` away, written under
 * every PostgreSQL guard (the API TTL cannot be shorter than 60 s).
 */
export async function shortHold(
  app: NestExpressApplication,
  fixture: BookableFixture,
  customerIdentityId: string,
  origin: number,
  destination: number,
  seats: string[],
  ttlMs: number,
): Promise<{ id: string; reference: string }> {
  const prisma = db(app);
  const reference = `ETB-${Array.from(randomBytes(12), (byte) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[byte % 32]).join('')}`;
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
    const now = row!.now;
    const fare = await tx.fareEntry.findUniqueOrThrow({
      where: {
        fareTableVersionId_originRouteWaypointId_destinationRouteWaypointId: {
          fareTableVersionId: fixture.fareTableVersionId,
          originRouteWaypointId: fixture.wp[origin]!,
          destinationRouteWaypointId: fixture.wp[destination]!,
        },
      },
    });
    const [originWp, destinationWp] = await Promise.all([
      tx.routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[origin]! } }),
      tx.routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[destination]! } }),
    ]);
    const booking = await tx.booking.create({
      data: {
        reference,
        customerIdentityId,
        tripId: fixture.tripId,
        originRouteWaypointId: originWp.id,
        destinationRouteWaypointId: destinationWp.id,
        originSequence: originWp.sequence,
        destinationSequence: destinationWp.sequence,
        fareEntryId: fare.id,
        unitAmountMinor: fare.amountMinor,
        currencyCode: fixture.currencyCode,
        currencyMinorUnit: fixture.currencyMinorUnit,
        createdAt: now,
        holdExpiresAt: new Date(now.getTime() + ttlMs),
      },
    });
    for (const label of seats) {
      const seat = await tx.bookingSeat.create({
        data: { bookingId: booking.id, seatMapCellId: fixture.cells[label]!, createdAt: now },
      });
      for (let segment = originWp.sequence; segment < destinationWp.sequence; segment += 1) {
        await tx.seatInventoryLock.create({
          data: {
            bookingSeatId: seat.id,
            tripId: fixture.tripId,
            seatMapCellId: seat.seatMapCellId,
            segmentSequence: segment,
          },
        });
      }
    }
    return { id: booking.id, reference };
  });
}

/** Waits until the database clock has passed the hold expiry of a booking. */
export async function waitUntilExpired(app: NestExpressApplication, bookingId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db(app).$queryRaw<Array<{ expired: boolean }>>`
      SELECT "hold_expires_at" <= now() AS "expired" FROM "booking" WHERE "id" = ${bookingId}::uuid`;
    if (row?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('hold did not expire');
}
