import { adminApi, type StaffActor } from './admin-helpers.js';

export function manifestApi(actor: StaffActor) {
  const api = adminApi(actor);
  return {
    list: (tripReference: string, query = '') =>
      api.get(
        `/manifests?tripReference=${encodeURIComponent(tripReference)}${query ? `&${query}` : ''}`,
      ),
    detail: (reference: string) => api.get(`/manifests/${encodeURIComponent(reference)}`),
    generate: (tripReference: string, body: unknown = {}, options: { csrf?: string | null } = {}) =>
      api.post(`/manifests/trips/${encodeURIComponent(tripReference)}`, body, options),
    exportCsv: (reference: string) =>
      api.get(`/manifests/${encodeURIComponent(reference)}/export.csv`),
  };
}
