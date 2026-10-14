import type { ApiEnv } from '@euroteranga/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bookableFixture, bookingApi, holdBody, type CustomerActor } from './booking-helpers.js';
import { paymentApi, settle } from './payment-helpers.js';

/** Safe synthetic PDF fixture: magic/header only, never real identity data. */
export const SYNTHETIC_PDF = Buffer.from(
  '%PDF-1.7\nEURO TERANGA synthetic passenger document\n%%EOF\n',
  'ascii',
);

export async function confirmedBooking(
  app: NestExpressApplication,
  env: ApiEnv,
  actor: CustomerActor,
  seats: string[] = ['1A'],
) {
  const fixture = await bookableFixture(app, { amount: () => 1_000 });
  const hold = await bookingApi(actor).post('/bookings', holdBody(fixture, 1, 3, seats));
  if (hold.status !== 201) throw new Error(`hold fixture failed: ${hold.status} ${hold.text}`);
  const payment = await paymentApi(actor).create(hold.body.reference as string);
  if (payment.status !== 201) {
    throw new Error(`payment fixture failed: ${payment.status} ${payment.text}`);
  }
  const webhook = await settle(app, env, payment.body.payment);
  if (webhook.status !== 200) {
    throw new Error(`confirmation fixture failed: ${webhook.status} ${webhook.text}`);
  }
  return { fixture, reference: hold.body.reference as string };
}

export async function createPassenger(
  actor: CustomerActor,
  bookingReference: string,
  nationalityCountryId: string,
  overrides: Record<string, unknown> = {},
) {
  return bookingApi(actor).post(`/bookings/${bookingReference}/passengers`, {
    givenName: 'Awa',
    familyName: 'Ndiaye',
    dateOfBirth: '1990-05-12',
    nationalityCountryId,
    ...overrides,
  });
}

export async function uploadDocument(
  app: NestExpressApplication,
  actor: CustomerActor,
  passengerReference: string,
  options: {
    bytes?: Buffer;
    filename?: string;
    mimeType?: string;
    type?: string;
    expiresAt?: string;
    csrf?: string | null;
  } = {},
) {
  const csrf = options.csrf === undefined ? await actor.csrf() : options.csrf;
  let call = request(app.getHttpServer())
    .post(`/v1/booking/passengers/${passengerReference}/documents`)
    .set('Origin', actor.http.origin)
    .set('X-Forwarded-For', actor.http.ip)
    .set('Cookie', actor.cookie)
    .field('type', options.type ?? 'PASSPORT');
  if (csrf !== null && csrf !== undefined) call = call.set('X-CSRF-Token', csrf);
  if (options.expiresAt !== undefined) call = call.field('expiresAt', options.expiresAt);
  return call.attach('file', options.bytes ?? SYNTHETIC_PDF, {
    filename: options.filename ?? 'document.pdf',
    contentType: options.mimeType ?? 'application/pdf',
  });
}
