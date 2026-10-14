import type { ApiEnv } from '@euroteranga/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { StaffActor } from './admin-helpers.js';
import { adminApi } from './admin-helpers.js';
import type { CustomerActor } from './booking-helpers.js';
import { bookingApi } from './booking-helpers.js';
import { confirmedBooking, createPassenger } from './passenger-document-helpers.js';

export function customerBaggageApi(actor: CustomerActor) {
  const api = bookingApi(actor);
  return {
    register: (
      bookingReference: string,
      passengerReference: string,
      body: unknown = { type: 'SUITCASE' },
      options: { csrf?: string | null } = {},
    ) =>
      api.post(
        `/bookings/${bookingReference}/passengers/${passengerReference}/baggage`,
        body,
        options,
      ),
    list: (bookingReference: string) => api.get(`/bookings/${bookingReference}/baggage`),
    detail: (reference: string) => api.get(`/baggage/${reference}`),
    qr: (reference: string) => api.get(`/baggage/${reference}/qr`),
  };
}

export function staffBaggageApi(actor: StaffActor) {
  const api = adminApi(actor);
  return {
    list: (query = '') => api.get(`/baggage${query}`),
    detail: (reference: string) => api.get(`/baggage/${reference}`),
    qr: (reference: string) => api.get(`/baggage/${reference}/qr`),
    register: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/baggage', body, options),
    weight: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/baggage/${reference}/weight`, body, options),
    event: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/baggage/${reference}/events`, body, options),
    scan: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/baggage/scan', body, options),
    resolveQr: (qrPayload: string, options: { csrf?: string | null } = {}) =>
      api.post('/baggage/resolve-qr', { qrPayload }, options),
  };
}

export async function confirmedPassenger(
  app: NestExpressApplication,
  env: ApiEnv,
  actor: CustomerActor,
  seats: string[] = ['1A'],
) {
  const confirmed = await confirmedBooking(app, env, actor, seats);
  const passenger = await createPassenger(actor, confirmed.reference, confirmed.fixture.countryId);
  if (passenger.status !== 201) {
    throw new Error(`passenger fixture failed: ${passenger.status} ${passenger.text}`);
  }
  return {
    fixture: confirmed.fixture,
    bookingReference: confirmed.reference,
    passengerReference: passenger.body.reference as string,
  };
}
