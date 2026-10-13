import { randomBytes } from 'node:crypto';
import { adminApi, type StaffActor } from './admin-helpers.js';

type Api = ReturnType<typeof adminApi>;

export const syntheticSeatMapCode = () => `SM_${randomBytes(4).toString('hex').toUpperCase()}`;

/** DRIVER + 2 seats around an aisle (capacity 2). */
export const basicLayout = (prefix = '1') => [
  { deck: 1, row: 1, column: 1, kind: 'DRIVER' },
  { deck: 1, row: 2, column: 1, kind: 'SEAT', seatLabel: `${prefix}A` },
  { deck: 1, row: 2, column: 2, kind: 'AISLE' },
  { deck: 1, row: 2, column: 3, kind: 'SEAT', seatLabel: `${prefix}B` },
];

export async function createSeatMap(api: Api) {
  const response = await api.post('/seat-maps', {
    code: syntheticSeatMapCode(),
    name: 'Plan synthétique',
    active: true,
  });
  if (response.status !== 201) throw new Error(`seat map: ${response.status} ${response.text}`);
  return response.body as { id: string; code: string };
}

export async function createDraft(api: Api, seatMapId: string) {
  const response = await api.post(`/seat-maps/${seatMapId}/versions`, {});
  if (response.status !== 201) throw new Error(`draft: ${response.status} ${response.text}`);
  const versions = response.body.versions as Array<{ id: string; status: string; version: number }>;
  return versions.find((version) => version.status === 'DRAFT')!;
}

/** A seat map with one PUBLISHED version holding `cells`. */
export async function publishedSeatMap(actor: StaffActor, cells: unknown[] = basicLayout()) {
  const api = adminApi(actor);
  const map = await createSeatMap(api);
  const draft = await createDraft(api, map.id);
  const replaced = await api.post(`/seat-maps/${map.id}/versions/${draft.id}/cells`, { cells });
  if (replaced.status !== 200) throw new Error(`cells: ${replaced.status} ${replaced.text}`);
  const published = await api.post(`/seat-maps/${map.id}/versions/${draft.id}/publish`, {});
  if (published.status !== 200) throw new Error(`publish: ${published.status} ${published.text}`);
  return { api, map, versionId: draft.id };
}
