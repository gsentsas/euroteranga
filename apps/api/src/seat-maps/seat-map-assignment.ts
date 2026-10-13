import type { DatabaseTransaction, SeatMapVersionStatus } from '@euroteranga/database';
import { SeatMapErrors } from './seat-map.errors.js';

/**
 * Summary of a seat-map version with its computed capacity, as embedded in
 * vehicles and trips.
 */
export const seatMapVersionSummarySelect = {
  id: true,
  version: true,
  status: true,
  publishedAt: true,
  retiredAt: true,
  seatMap: { select: { id: true, code: true, name: true, active: true } },
  _count: { select: { cells: { where: { kind: 'SEAT' } } } },
} as const;

export function seatMapVersionView<T extends { _count: { cells: number } }>(
  version: T | null,
): (Omit<T, '_count'> & { seatCount: number }) | null {
  if (!version) return null;
  const { _count, ...rest } = version;
  return { ...rest, seatCount: _count.cells };
}

export interface AssignableSeatMapVersion {
  id: string;
  version: number;
  seatMapCode: string;
}

export const seatMapLabel = (code: string | null, version: number | null) =>
  code && version !== null ? `${code} v${version}` : null;

/**
 * Lock and check a seat-map version for a NEW assignment (vehicle or trip):
 * it must exist, be currently PUBLISHED, and belong to an active seat map.
 *
 * Lock order: seat_map FOR SHARE, then seat_map_version FOR SHARE — the same
 * order as publication (seat_map, then versions), so no cycle is possible.
 * Callers lock their own row (trip, vehicle) first.
 */
export async function lockAssignableSeatMapVersion(
  tx: DatabaseTransaction,
  id: string,
): Promise<AssignableSeatMapVersion> {
  const found = await tx.seatMapVersion.findUnique({ where: { id }, select: { seatMapId: true } });
  if (!found) throw SeatMapErrors.versionNotFound();
  const maps = await tx.$queryRaw<Array<{ code: string; active: boolean }>>`
    SELECT "code", "active" FROM "seat_map" WHERE "id" = ${found.seatMapId}::uuid FOR SHARE
  `;
  const versions = await tx.$queryRaw<Array<{ version: number; status: SeatMapVersionStatus }>>`
    SELECT "version", "status" FROM "seat_map_version" WHERE "id" = ${id}::uuid FOR SHARE
  `;
  const map = maps[0];
  const version = versions[0];
  if (!map || !version) throw SeatMapErrors.versionNotFound();
  if (version.status === 'DRAFT') throw SeatMapErrors.versionNotPublished();
  if (version.status === 'RETIRED') throw SeatMapErrors.versionRetired();
  if (!map.active) throw SeatMapErrors.seatMapInactive();
  return { id, version: version.version, seatMapCode: map.code };
}
