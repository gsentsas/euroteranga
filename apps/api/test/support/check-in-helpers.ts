import type { ApiEnv } from '@euroteranga/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { adminApi, type StaffActor } from './admin-helpers.js';
import { bookingApi, type CustomerActor } from './booking-helpers.js';
import {
  complianceApi,
  confirmedJourney,
  coverage,
  journeyPassenger,
  publishRule,
  type Journey,
} from './compliance-helpers.js';

type Csrf = { csrf?: string | null };

export function customerCheckInApi(actor: CustomerActor) {
  const api = bookingApi(actor);
  const subject = (booking: string, passenger: string) =>
    `/bookings/${booking}/passengers/${passenger}`;
  return {
    booking: (booking: string) => api.get(`/bookings/${booking}/check-in`),
    readiness: (booking: string, passenger: string) =>
      api.get(`${subject(booking, passenger)}/check-in-readiness`),
    seat: (booking: string, passenger: string, body: unknown, options: Csrf = {}) =>
      api.post(`${subject(booking, passenger)}/seat`, body, options),
    checkIn: (booking: string, passenger: string, body: unknown = {}, options: Csrf = {}) =>
      api.post(`${subject(booking, passenger)}/check-in`, body, options),
    qr: (reference: string) => api.get(`/check-ins/${reference}/qr`),
  };
}

export function staffCheckInApi(actor: StaffActor) {
  const api = adminApi(actor);
  const subject = (booking: string, passenger: string) =>
    `/check-in/bookings/${booking}/passengers/${passenger}`;
  return {
    list: (query = '') => api.get(`/check-in/booking-passengers${query}`),
    detail: (booking: string, passenger: string) => api.get(subject(booking, passenger)),
    seat: (booking: string, passenger: string, body: unknown, options: Csrf = {}) =>
      api.post(`${subject(booking, passenger)}/seat`, body, options),
    checkIn: (booking: string, passenger: string, body: unknown = {}, options: Csrf = {}) =>
      api.post(`${subject(booking, passenger)}/check-in`, body, options),
    qr: (reference: string) => api.get(`/check-in/check-ins/${reference}/qr`),
  };
}

export function boardingApi(actor: StaffActor) {
  const api = adminApi(actor);
  return {
    resolve: (qrPayload: string, options: Csrf = {}) =>
      api.post('/boarding/resolve', { qrPayload }, options),
    scan: (body: unknown, options: Csrf = {}) => api.post('/boarding/scan', body, options),
  };
}

export interface ReadyPassenger {
  journey: Journey;
  bookingReference: string;
  passengerReference: string;
}

/**
 * A confirmed journey whose passenger is compliant by a published synthetic
 * rule (no document required) — every gate passes once a seat is assigned.
 */
export async function compliantPassenger(
  app: NestExpressApplication,
  env: ApiEnv,
  customer: CustomerActor,
  ruleManager: StaffActor,
  options: { seats?: string[]; seat?: string | null } = {},
): Promise<ReadyPassenger> {
  const journey = await confirmedJourney(app, env, customer, {
    seats: options.seats ?? ['1A'],
  });
  const passengerReference = await journeyPassenger(customer, journey, journey.origin.id);
  await publishRule(ruleManager, { definition: coverage(journey) });
  const evaluated = await complianceApi(customer).evaluate(
    journey.bookingReference,
    passengerReference,
  );
  if (evaluated.status !== 200 || evaluated.body.status !== 'COMPLIANT_BY_RULES') {
    throw new Error(`compliance fixture failed: ${evaluated.status} ${evaluated.text}`);
  }
  const seat = options.seat === undefined ? (options.seats?.[0] ?? '1A') : options.seat;
  if (seat) {
    const assigned = await customerCheckInApi(customer).seat(
      journey.bookingReference,
      passengerReference,
      { seatLabel: seat },
    );
    if (assigned.status !== 201) throw new Error(`seat fixture failed: ${assigned.text}`);
  }
  return { journey, bookingReference: journey.bookingReference, passengerReference };
}
