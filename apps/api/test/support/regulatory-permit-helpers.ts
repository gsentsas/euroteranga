import { randomBytes } from 'node:crypto';
import type { StaffActor } from './admin-helpers.js';
import { adminApi } from './admin-helpers.js';

export function regulatoryPermitApi(actor: StaffActor) {
  const api = adminApi(actor);
  return {
    list: (query = '') => api.get(`/regulatory-permits${query}`),
    detail: (reference: string) => api.get(`/regulatory-permits/${reference}`),
    create: (body: unknown, options: { csrf?: string | null } = {}) =>
      api.post('/regulatory-permits', body, options),
    update: (reference: string, body: unknown, options: { csrf?: string | null } = {}) =>
      api.post(`/regulatory-permits/${reference}`, body, options),
    activate: (
      reference: string,
      expectedRevision: number,
      options: { csrf?: string | null } = {},
    ) => api.post(`/regulatory-permits/${reference}/activate`, { expectedRevision }, options),
    revoke: (
      reference: string,
      expectedRevision: number,
      reason = 'Révocation synthétique motivée',
      options: { csrf?: string | null } = {},
    ) => api.post(`/regulatory-permits/${reference}/revoke`, { expectedRevision, reason }, options),
  };
}

export function syntheticPermit(overrides: Record<string, unknown> = {}) {
  const suffix = randomBytes(5).toString('hex').toUpperCase();
  return {
    permitType: `SYNTHETIC_${suffix}`,
    title: `Autorisation synthétique ${suffix}`,
    issuingAuthority: 'Autorité synthétique de test',
    authorityReference: `REF-${suffix}`,
    scope: { type: 'OPERATOR' },
    validFrom: '2025-01-01',
    validUntil: '2035-12-31',
    sourceUrl: `https://regulations.example.test/${suffix}`,
    sourceCheckedOn: '2025-01-01',
    notes: 'Note synthétique sans portée juridique.',
    ...overrides,
  };
}
