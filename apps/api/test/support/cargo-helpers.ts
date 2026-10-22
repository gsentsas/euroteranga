import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { StaffActor } from './admin-helpers.js';
import { adminApi, operatorVehicle } from './admin-helpers.js';
import { db } from './auth-helpers.js';
import { syntheticCountry } from './booking-helpers.js';

const suffix = () => randomBytes(4).toString('hex').toUpperCase();

export function staffCargoApi(actor: StaffActor) {
  const api = adminApi(actor);
  return {
    list: (query = '') => api.get(`/cargo${query}`),
    detail: (reference: string) => api.get(`/cargo/${reference}`),
    create: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/cargo', body, options),
    update: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/cargo/${reference}/details`, body, options),
    assign: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/cargo/${reference}/assignment`, body, options),
    event: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/cargo/${reference}/events`, body, options),
    resolveQr: (qrPayload: string, options: { csrf?: string | null } = {}) =>
      api.post('/cargo/resolve-qr', { qrPayload }, options),
    scan: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/cargo/scan', body, options),
    qr: (reference: string) => api.get(`/cargo/${reference}/qr`),
    trackingTokens: (reference: string) => api.get(`/cargo/${reference}/tracking-tokens`),
    issueTrackingToken: (
      reference: string,
      body: unknown = {},
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/tracking-tokens`, body, options),
    revokeTrackingToken: (
      reference: string,
      tokenId: string,
      body: unknown,
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/tracking-tokens/${tokenId}/revoke`, body, options),
    quotes: (reference: string) => api.get(`/cargo/${reference}/quotes`),
    quote: (reference: string, quoteReference: string) =>
      api.get(`/cargo/${reference}/quotes/${quoteReference}`),
    createQuote: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/cargo/${reference}/quotes`, body, options),
    replaceQuoteLines: (
      reference: string,
      quoteReference: string,
      body: unknown,
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/quotes/${quoteReference}`, body, options),
    issueQuote: (
      reference: string,
      quoteReference: string,
      body: unknown = {},
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/quotes/${quoteReference}/issue`, body, options),
    acceptQuote: (
      reference: string,
      quoteReference: string,
      body: unknown = {},
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/quotes/${quoteReference}/accept`, body, options),
    cancelQuote: (
      reference: string,
      quoteReference: string,
      body: unknown,
      options: { csrf?: string | null } = {},
    ) => api.post(`/cargo/${reference}/quotes/${quoteReference}/cancel`, body, options),
  };
}

async function corridorStop(app: NestExpressApplication, code: 'PAR' | 'DKR', countryId: string) {
  const existing = await db(app).stop.findUnique({ where: { code } });
  if (existing) return existing.id;
  return (
    await db(app).stop.create({
      data: {
        code,
        name: code === 'PAR' ? 'Paris test cargo' : 'Dakar test cargo',
        countryId,
        locality: code,
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    })
  ).id;
}

export async function cargoTripFixture(
  app: NestExpressApplication,
  actor: StaffActor,
  capacities = { payloadCapacityKg: 1000, cargoVolumeLiters: 2000 },
) {
  const prisma = db(app);
  const countryId = await syntheticCountry(app);
  const [par, dkr] = await Promise.all([
    corridorStop(app, 'PAR', countryId),
    corridorStop(app, 'DKR', countryId),
  ]);
  const route = await prisma.route.create({
    data: { code: `CARGO_${suffix()}`, name: 'Route fret test Paris Dakar' },
  });
  const version = await prisma.routeVersion.create({
    data: { routeId: route.id, version: 1 },
  });
  const waypoints = await Promise.all([
    prisma.routeWaypoint.create({
      data: { routeVersionId: version.id, sequence: 1, stopId: par, boardingAllowed: true },
    }),
    prisma.routeWaypoint.create({
      data: { routeVersionId: version.id, sequence: 2, stopId: dkr, alightingAllowed: true },
    }),
  ]);
  await prisma.routeVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  const vehicleCode = `CG_${suffix()}`;
  const vehicleId = await operatorVehicle(
    actor,
    {
      code: vehicleCode,
      name: `Cargo mixte ${suffix()}`,
      manufacturer: 'Test',
      model: 'Cargo',
      role: 'MIXED',
      ...capacities,
    },
    ['ACTIVE'],
  );

  const trip = await prisma.trip.create({
    data: {
      reference: `ET-CARGO-${suffix()}`,
      routeVersionId: version.id,
      vehicleId,
    },
  });
  const departure = new Date(Date.now() + 48 * 3_600_000);
  const arrival = new Date(departure.getTime() + 72 * 3_600_000);
  await prisma.tripWaypointTiming.createMany({
    data: [
      {
        tripId: trip.id,
        routeWaypointId: waypoints[0]!.id,
        sequence: 1,
        plannedDepartureAt: departure,
      },
      {
        tripId: trip.id,
        routeWaypointId: waypoints[1]!.id,
        sequence: 2,
        plannedArrivalAt: arrival,
      },
    ],
  });
  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      plannedDepartureAt: departure,
      plannedArrivalAt: arrival,
      status: 'SCHEDULED',
      scheduledAt: new Date(),
    },
  });
  return {
    tripId: trip.id,
    tripReference: trip.reference,
    vehicleId,
    vehicleCode,
    waypointIds: waypoints.map((waypoint) => waypoint.id),
  };
}

export const cargoCreateBody = (overrides: Record<string, unknown> = {}) => ({
  direction: 'PAR_DKR',
  senderName: 'Expéditeur Test',
  senderContact: '+33102030405',
  recipientName: 'Destinataire Test',
  recipientContact: '+221770102030',
  weightKg: '100.000',
  volumeLiters: 500,
  packageCount: 2,
  declaredContents: 'Effets personnels autorisés',
  fragile: false,
  professional: false,
  pickupRequired: false,
  deliveryRequired: false,
  ...overrides,
});
