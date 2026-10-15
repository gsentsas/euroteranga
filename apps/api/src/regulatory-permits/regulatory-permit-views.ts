import { Prisma } from '@euroteranga/database';
import { derivePermitValidity, isoDay } from './regulatory-permit-rules.js';

export const permitSelect = {
  id: true,
  reference: true,
  permitType: true,
  title: true,
  issuingAuthority: true,
  authorityReference: true,
  jurisdictionCountryId: true,
  jurisdictionCountry: { select: { iso2: true, iso3: true, name: true } },
  validFrom: true,
  validUntil: true,
  status: true,
  scopeType: true,
  scopeCountryId: true,
  scopeCountry: { select: { iso2: true, iso3: true, name: true } },
  vehicleId: true,
  vehicle: { select: { code: true, registrationPlate: true } },
  routeVersionId: true,
  routeVersion: { select: { version: true, route: { select: { code: true, name: true } } } },
  tripId: true,
  trip: { select: { reference: true } },
  sourceUrl: true,
  sourceCheckedOn: true,
  notes: true,
  revision: true,
  activatedAt: true,
  revokedAt: true,
  revocationReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RegulatoryPermitSelect;

export type PermitRow = Prisma.RegulatoryPermitGetPayload<{ select: typeof permitSelect }>;

export type PermitHistoryEntry = {
  action: string;
  occurredAt: Date;
  status: string | null;
  revision: number | null;
  reason: string | null;
};

export function permitScopeView(row: PermitRow) {
  switch (row.scopeType) {
    case 'OPERATOR':
      return { type: 'OPERATOR' as const, label: 'EURO TERANGA' };
    case 'COUNTRY':
      return { type: 'COUNTRY' as const, country: row.scopeCountry! };
    case 'VEHICLE':
      return { type: 'VEHICLE' as const, vehicle: row.vehicle! };
    case 'ROUTE_VERSION':
      return {
        type: 'ROUTE_VERSION' as const,
        route: row.routeVersion!.route,
        routeVersion: row.routeVersion!.version,
      };
    case 'TRIP':
      return { type: 'TRIP' as const, trip: row.trip! };
  }
}

export function permitSummaryView(row: PermitRow, evaluatedOn: string) {
  const validFrom = isoDay(row.validFrom);
  const validUntil = isoDay(row.validUntil);
  return {
    reference: row.reference,
    permitType: row.permitType,
    title: row.title,
    issuingAuthority: row.issuingAuthority,
    authorityReference: row.authorityReference,
    jurisdictionCountry: row.jurisdictionCountry,
    scope: permitScopeView(row),
    validFrom,
    validUntil,
    status: row.status,
    validityState: derivePermitValidity({ status: row.status, validFrom, validUntil }, evaluatedOn),
    evaluatedOn,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activatedAt: row.activatedAt,
    revokedAt: row.revokedAt,
  };
}

export function permitDetailView(
  row: PermitRow,
  evaluatedOn: string,
  history: PermitHistoryEntry[],
) {
  return {
    ...permitSummaryView(row, evaluatedOn),
    sourceUrl: row.sourceUrl,
    sourceCheckedOn: row.sourceCheckedOn ? isoDay(row.sourceCheckedOn) : null,
    notes: row.notes,
    revocationReason: row.revocationReason,
    history,
  };
}

/** Explicit allow-list for audit: no notes, URLs, actors or internal ids. */
export function permitAuditSnapshot(row: PermitRow, evaluatedOn: string) {
  const summary = permitSummaryView(row, evaluatedOn);
  return {
    permitReference: summary.reference,
    permitType: summary.permitType,
    title: summary.title,
    issuingAuthority: summary.issuingAuthority,
    jurisdictionCountry: summary.jurisdictionCountry,
    scope: summary.scope,
    status: summary.status,
    validityState: summary.validityState,
    validFrom: summary.validFrom,
    validUntil: summary.validUntil,
    revision: summary.revision,
  };
}
