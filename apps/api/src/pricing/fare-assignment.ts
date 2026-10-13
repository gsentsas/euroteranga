import type { DatabaseTransaction, FareTableVersionStatus } from '@euroteranga/database';
import { PricingErrors } from './pricing.errors.js';

/** Summary of a fare table version as embedded in trips. */
export const fareTableVersionSummarySelect = {
  id: true,
  version: true,
  status: true,
  publishedAt: true,
  retiredAt: true,
  routeVersionId: true,
  fareTable: {
    select: {
      id: true,
      code: true,
      name: true,
      currencyCode: true,
      currencyMinorUnit: true,
      active: true,
    },
  },
  _count: { select: { entries: true } },
} as const;

export function fareTableVersionView<T extends { _count: { entries: number } }>(
  version: T | null,
): (Omit<T, '_count'> & { entryCount: number }) | null {
  if (!version) return null;
  const { _count, ...rest } = version;
  return { ...rest, entryCount: _count.entries };
}

export const fareTableLabel = (
  code: string | null,
  version: number | null,
  currency: string | null,
) => (code && version !== null ? `${code} v${version}${currency ? ` (${currency})` : ''}` : null);

export interface AssignableFareTableVersion {
  id: string;
  version: number;
  routeVersionId: string;
  code: string;
  currencyCode: string;
}

/**
 * Lock and check a fare table version for a NEW trip assignment: it must
 * exist, be currently PUBLISHED and belong to an active fare table.
 * Lock order: fare_table FOR SHARE, then fare_table_version FOR SHARE — the
 * same order as publication. Callers lock the trip first; publication never
 * locks trips, so no cycle is possible.
 */
export async function lockAssignableFareTableVersion(
  tx: DatabaseTransaction,
  id: string,
): Promise<AssignableFareTableVersion> {
  const found = await tx.fareTableVersion.findUnique({
    where: { id },
    select: { fareTableId: true },
  });
  if (!found) throw PricingErrors.versionNotFound();
  const tables = await tx.$queryRaw<
    Array<{ code: string; active: boolean; currency_code: string }>
  >`
    SELECT "code", "active", "currency_code" FROM "fare_table" WHERE "id" = ${found.fareTableId}::uuid FOR SHARE
  `;
  const versions = await tx.$queryRaw<
    Array<{ version: number; status: FareTableVersionStatus; route_version_id: string }>
  >`
    SELECT "version", "status", "route_version_id" FROM "fare_table_version"
    WHERE "id" = ${id}::uuid FOR SHARE
  `;
  const table = tables[0];
  const version = versions[0];
  if (!table || !version) throw PricingErrors.versionNotFound();
  if (version.status === 'DRAFT') throw PricingErrors.versionNotPublished();
  if (version.status === 'RETIRED') throw PricingErrors.versionRetired();
  if (!table.active) throw PricingErrors.fareTableInactive();
  return {
    id,
    version: version.version,
    routeVersionId: version.route_version_id,
    code: table.code,
    currencyCode: table.currency_code,
  };
}
