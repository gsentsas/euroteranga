import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { adminApi, type StaffActor } from './admin-helpers.js';
import { db } from './auth-helpers.js';

type Api = ReturnType<typeof adminApi>;
const suffix = () => randomBytes(4).toString('hex').toUpperCase();

export interface PricedRoute {
  routeId: string;
  routeVersionId: string;
  /** A: boarding only; C: checkpoint; B: boarding and alighting; D: alighting only. */
  A: string;
  C: string;
  B: string;
  D: string;
}

/** Synthetic published route A -> C -> B -> D, written directly. */
export async function pricedRoute(
  app: NestExpressApplication,
  countryId: string,
): Promise<PricedRoute> {
  const stop = () =>
    db(app).stop.create({
      data: {
        code: `S_${suffix()}`,
        name: 'Arrêt',
        countryId,
        locality: 'L',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
  const [a, b, d] = [await stop(), await stop(), await stop()];
  const c = await db(app).checkpoint.create({
    data: {
      code: `C_${suffix()}`,
      name: 'CP',
      countryId,
      type: 'TECHNICAL',
      locality: 'L',
      latitude: 1,
      longitude: 1,
      timezone: 'Etc/UTC',
    },
  });
  const route = await db(app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
  const version = await db(app).routeVersion.create({ data: { routeId: route.id, version: 1 } });
  await db(app).routeWaypoint.createMany({
    data: [
      { routeVersionId: version.id, sequence: 1, stopId: a.id, boardingAllowed: true },
      { routeVersionId: version.id, sequence: 2, checkpointId: c.id },
      {
        routeVersionId: version.id,
        sequence: 3,
        stopId: b.id,
        boardingAllowed: true,
        alightingAllowed: true,
      },
      { routeVersionId: version.id, sequence: 4, stopId: d.id, alightingAllowed: true },
    ],
  });
  await db(app).routeVersion.update({
    where: { id: version.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  const [A, C, B, D] = await db(app).routeWaypoint.findMany({
    where: { routeVersionId: version.id },
    orderBy: { sequence: 'asc' },
  });
  return { routeId: route.id, routeVersionId: version.id, A: A!.id, C: C!.id, B: B!.id, D: D!.id };
}

export const fare = (
  originRouteWaypointId: string,
  destinationRouteWaypointId: string,
  amountMinor = 12345,
) => ({
  originRouteWaypointId,
  destinationRouteWaypointId,
  amountMinor,
});

export async function createFareTable(
  api: Api,
  routeId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await api.post('/pricing/fare-tables', {
    code: `FT_${suffix()}`,
    name: 'Tarif synthétique',
    routeId,
    currencyCode: 'EUR',
    currencyMinorUnit: 2,
    active: true,
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`fare table: ${response.status} ${response.text}`);
  return response.body as { id: string; code: string };
}

export async function createFareDraft(api: Api, fareTableId: string, routeVersionId: string) {
  const response = await api.post(`/pricing/fare-tables/${fareTableId}/versions`, {
    routeVersionId,
  });
  if (response.status !== 201) throw new Error(`draft: ${response.status} ${response.text}`);
  return (response.body.versions as Array<{ id: string; status: string; version: number }>).find(
    (version) => version.status === 'DRAFT',
  )!;
}

/** A fare table with one PUBLISHED version holding `fares` (default A->B, A->D). */
export async function publishedFareTable(actor: StaffActor, route: PricedRoute, fares?: unknown[]) {
  const api = adminApi(actor);
  const table = await createFareTable(api, route.routeId);
  const draft = await createFareDraft(api, table.id, route.routeVersionId);
  const replaced = await api.post(`/pricing/fare-tables/${table.id}/versions/${draft.id}/fares`, {
    fares: fares ?? [fare(route.A, route.B, 12345), fare(route.A, route.D, 20000)],
  });
  if (replaced.status !== 200) throw new Error(`fares: ${replaced.status} ${replaced.text}`);
  const published = await api.post(
    `/pricing/fare-tables/${table.id}/versions/${draft.id}/publish`,
    {},
  );
  if (published.status !== 200) throw new Error(`publish: ${published.status} ${published.text}`);
  return { api, table, versionId: draft.id };
}

/** A DRAFT trip on the priced route with a complete timetable (schedulable). */
export async function pricedTrip(app: NestExpressApplication, route: PricedRoute) {
  const trip = await db(app).trip.create({
    data: { reference: `ET-TEST-2030-${suffix()}`, routeVersionId: route.routeVersionId },
  });
  const at = (hour: number, minute = 0) => new Date(Date.UTC(2030, 2, 1, hour, minute));
  await db(app).tripWaypointTiming.createMany({
    data: [
      { tripId: trip.id, routeWaypointId: route.A, sequence: 1, plannedDepartureAt: at(8) },
      {
        tripId: trip.id,
        routeWaypointId: route.C,
        sequence: 2,
        plannedArrivalAt: at(9),
        plannedDepartureAt: at(9, 5),
      },
      {
        tripId: trip.id,
        routeWaypointId: route.B,
        sequence: 3,
        plannedArrivalAt: at(10),
        plannedDepartureAt: at(10, 10),
      },
      { tripId: trip.id, routeWaypointId: route.D, sequence: 4, plannedArrivalAt: at(12) },
    ],
  });
  await db(app).trip.update({
    where: { id: trip.id },
    data: { plannedDepartureAt: at(8), plannedArrivalAt: at(12) },
  });
  return trip;
}
