import { expect, expectTypeOf, it } from 'vitest';
import type { PermitRow } from '../../../src/regulatory-permits/regulatory-permit-views.js';
import {
  permitAuditSnapshot,
  permitDetailView,
  permitSummaryView,
} from '../../../src/regulatory-permits/regulatory-permit-views.js';

const row = {
  id: '01900000-0000-7000-8000-000000000001',
  reference: 'ETRP-000000000000',
  permitType: 'SYNTHETIC',
  title: 'Autorisation synthétique',
  issuingAuthority: 'Autorité synthétique',
  authorityReference: 'REF-1',
  jurisdictionCountryId: null,
  jurisdictionCountry: null,
  validFrom: new Date('2030-01-01T00:00:00.000Z'),
  validUntil: new Date('2030-12-31T00:00:00.000Z'),
  status: 'ACTIVE',
  scopeType: 'TRIP',
  scopeCountryId: null,
  scopeCountry: null,
  vehicleId: null,
  vehicle: null,
  routeVersionId: null,
  routeVersion: null,
  tripId: '01900000-0000-7000-8000-000000000002',
  trip: { reference: 'ET-TRIP-1' },
  sourceUrl: 'https://regulations.example.test/source',
  sourceCheckedOn: new Date('2029-12-01T00:00:00.000Z'),
  notes: 'Internal note that must not enter audit.',
  revision: 2,
  activatedAt: new Date('2030-01-01T00:00:00.000Z'),
  revokedAt: null,
  revocationReason: null,
  createdAt: new Date('2029-12-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
} satisfies PermitRow;

it('maps only public scope references and server-derived validity', () => {
  const view = permitSummaryView(row, '2030-06-01');
  expect(view).toMatchObject({
    reference: 'ETRP-000000000000',
    scope: { type: 'TRIP', trip: { reference: 'ET-TRIP-1' } },
    validityState: 'VALID',
    evaluatedOn: '2030-06-01',
  });
  expect(JSON.stringify(view)).not.toContain(row.id);
  expect(JSON.stringify(view)).not.toContain(row.tripId);
  expectTypeOf(view).not.toHaveProperty('id');
});

it('keeps notes and source out of audit while returning them in detail', () => {
  const detail = permitDetailView(row, '2030-06-01', []);
  const audit = permitAuditSnapshot(row, '2030-06-01');
  expect(detail.notes).toContain('Internal note');
  expect(detail.sourceUrl).toContain('regulations.example.test');
  expect(JSON.stringify(audit)).not.toContain('Internal note');
  expect(JSON.stringify(audit)).not.toContain('source');
  expect(audit).toMatchObject({
    title: 'Autorisation synthétique',
    issuingAuthority: 'Autorité synthétique',
    jurisdictionCountry: null,
    status: 'ACTIVE',
    revision: 2,
  });
});
