import { randomBytes } from 'node:crypto';
import { adminApi, type StaffActor } from './admin-helpers.js';

type Api = ReturnType<typeof adminApi>;

let isoSequence = 0;

/** Distinct synthetic ISO codes (letters only), unique within one database. */
export function syntheticIso(): { iso2: string; iso3: string } {
  const value = isoSequence++;
  const letter = (n: number) => String.fromCharCode(65 + (n % 26));
  const a = letter(Math.floor(value / 26));
  const b = letter(value);
  return { iso2: `${a}${b}`, iso3: `${a}${b}Q` };
}

/** Synthetic network code (uppercase letters, digits, `_`). */
export function syntheticCode(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function createCountry(api: Api, overrides: Record<string, unknown> = {}) {
  const response = await api.post('/network/countries', {
    ...syntheticIso(),
    name: `Pays synthétique ${randomBytes(2).toString('hex')}`,
    active: true,
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`country: ${response.status} ${response.text}`);
  return response.body as { id: string; iso2: string; iso3: string; name: string };
}

export async function createStop(
  api: Api,
  countryId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await api.post('/network/stops', {
    code: syntheticCode('STOP'),
    name: 'Arrêt synthétique',
    countryId,
    locality: 'Localité synthétique',
    latitude: 10.5,
    longitude: -2.25,
    timezone: 'Etc/UTC',
    active: true,
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`stop: ${response.status} ${response.text}`);
  return response.body as { id: string; code: string };
}

export async function createCheckpoint(
  api: Api,
  countryId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await api.post('/network/checkpoints', {
    code: syntheticCode('CP'),
    name: 'Checkpoint synthétique',
    countryId,
    type: 'TECHNICAL',
    locality: 'Localité synthétique',
    latitude: 11.5,
    longitude: -2.5,
    timezone: 'Etc/UTC',
    active: true,
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`checkpoint: ${response.status} ${response.text}`);
  return response.body as { id: string; code: string };
}

export async function createRoute(api: Api) {
  const response = await api.post('/network/routes', {
    code: syntheticCode('RT'),
    name: 'Route synthétique',
    active: true,
  });
  if (response.status !== 201) throw new Error(`route: ${response.status} ${response.text}`);
  return response.body as { id: string; code: string };
}

export async function createDraft(api: Api, routeId: string) {
  const response = await api.post(`/network/routes/${routeId}/versions`, {});
  if (response.status !== 201) throw new Error(`draft: ${response.status} ${response.text}`);
  return response.body as { id: string; version: number; status: string };
}

export const stopWaypoint = (stopId: string) => ({
  kind: 'STOP' as const,
  stopId,
  boardingAllowed: true,
  alightingAllowed: true,
});

export const checkpointWaypoint = (checkpointId: string) => ({
  kind: 'CHECKPOINT' as const,
  checkpointId,
});

/**
 * A route with a DRAFT holding a valid, publishable order:
 * stop → checkpoint → stop (synthetic data only).
 */
export async function publishableDraft(actor: StaffActor) {
  const api = adminApi(actor);
  const country = await createCountry(api);
  const origin = await createStop(api, country.id);
  const destination = await createStop(api, country.id);
  const checkpoint = await createCheckpoint(api, country.id);
  const route = await createRoute(api);
  const draft = await createDraft(api, route.id);
  const replaced = await api.post(`/network/routes/${route.id}/versions/${draft.id}/waypoints`, {
    waypoints: [
      stopWaypoint(origin.id),
      checkpointWaypoint(checkpoint.id),
      stopWaypoint(destination.id),
    ],
  });
  if (replaced.status !== 200) throw new Error(`waypoints: ${replaced.status} ${replaced.text}`);
  return { api, country, origin, destination, checkpoint, route, draft };
}
