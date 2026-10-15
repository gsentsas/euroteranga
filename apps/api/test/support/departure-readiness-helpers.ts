import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { adminApi, type StaffActor } from './admin-helpers.js';
import { db } from './auth-helpers.js';
import type { CustomerActor } from './booking-helpers.js';
import { boardingApi, compliantPassenger, staffCheckInApi } from './check-in-helpers.js';
import { manifestApi } from './manifest-helpers.js';

export function departureApi(actor: StaffActor) {
  const api = adminApi(actor);
  const trip = (reference: string) => encodeURIComponent(reference);
  return {
    readiness: (reference: string) => api.get(`/departure/trips/${trip(reference)}/readiness`),
    publishPolicy: (
      reference: string,
      requirements: unknown[] = [],
      options: { csrf?: string | null } = {},
    ) => api.post(`/departure/trips/${trip(reference)}/permit-policy`, { requirements }, options),
    authorize: (reference: string, body: unknown = {}, options: { csrf?: string | null } = {}) =>
      api.post(`/departure/trips/${trip(reference)}/authorize`, body, options),
    depart: (reference: string, body: unknown = {}, options: { csrf?: string | null } = {}) =>
      api.post(`/departure/trips/${trip(reference)}/depart`, body, options),
    complete: (reference: string, body: unknown = {}, options: { csrf?: string | null } = {}) =>
      api.post(`/departure/trips/${trip(reference)}/complete`, body, options),
  };
}

export interface DepartureFixture {
  tripReference: string;
  tripId: string;
  bookingReference: string;
  passengerReference: string;
  checkInReference: string;
  qrPayload: string;
  vehicleId: string;
  vehicleCode: string;
  manifestReference?: string;
}

/**
 * Real PR-10..16 chain: confirmed booking -> synthetic compliance -> seat ->
 * ACTIVE compatible vehicle -> check-in -> optional manifest -> boarding ->
 * optional current manifest. Nothing bypasses a database invariant.
 */
export async function departureFixture(
  app: NestExpressApplication,
  env: ApiEnv,
  customer: CustomerActor,
  ruleManager: StaffActor,
  operator: StaffActor,
  options: { manifestBeforeBoarding?: boolean; generateManifest?: boolean } = {},
): Promise<DepartureFixture> {
  const ready = await compliantPassenger(app, env, customer, ruleManager);
  const trip = await db(app).trip.findUniqueOrThrow({
    where: { reference: ready.journey.tripReference },
    select: { id: true, seatMapVersionId: true },
  });
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const vehicle = await db(app).vehicle.create({
    data: {
      code: `VH_DEP_${suffix}`,
      manufacturer: 'Synthétique',
      model: 'Départ',
      seatMapVersionId: trip.seatMapVersionId,
    },
  });
  await db(app).vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } });
  await db(app).trip.update({ where: { id: trip.id }, data: { vehicleId: vehicle.id } });

  const checkedIn = await staffCheckInApi(operator).checkIn(
    ready.bookingReference,
    ready.passengerReference,
  );
  if (checkedIn.status !== 201) {
    throw new Error(`departure check-in fixture failed: ${checkedIn.status} ${checkedIn.text}`);
  }

  let manifestReference: string | undefined;
  if (options.manifestBeforeBoarding) {
    const manifest = await manifestApi(operator).generate(ready.journey.tripReference);
    if (manifest.status !== 201) {
      throw new Error(`departure pre-boarding manifest fixture failed: ${manifest.text}`);
    }
    manifestReference = manifest.body.reference as string;
  }

  const boarded = await boardingApi(operator).scan({
    qrPayload: checkedIn.body.checkIn.qrPayload,
    deviceId: `gate-departure-${suffix.toLowerCase()}`,
  });
  if (boarded.status !== 201) {
    throw new Error(`departure boarding fixture failed: ${boarded.status} ${boarded.text}`);
  }

  if (options.generateManifest !== false && !options.manifestBeforeBoarding) {
    const manifest = await manifestApi(operator).generate(ready.journey.tripReference);
    if (manifest.status !== 201) {
      throw new Error(`departure manifest fixture failed: ${manifest.status} ${manifest.text}`);
    }
    manifestReference = manifest.body.reference as string;
  }

  return {
    tripReference: ready.journey.tripReference,
    tripId: trip.id,
    bookingReference: ready.bookingReference,
    passengerReference: ready.passengerReference,
    checkInReference: checkedIn.body.checkIn.reference as string,
    qrPayload: checkedIn.body.checkIn.qrPayload as string,
    vehicleId: vehicle.id,
    vehicleCode: vehicle.code,
    ...(manifestReference ? { manifestReference } : {}),
  };
}
