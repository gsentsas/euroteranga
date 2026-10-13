import type {
  AssignedSeatMapVersion,
  SeatMapCellKind,
  SeatMapVersionStatus,
} from '@euroteranga/auth-client';

export const KIND_LABELS: Record<SeatMapCellKind, string> = {
  SEAT: 'Siège',
  AISLE: 'Allée',
  DRIVER: 'Conducteur',
  DOOR: 'Porte',
  TOILET: 'Toilettes',
  STAIRS: 'Escalier',
  OTHER: 'Autre',
};

export const VERSION_STATUS_LABELS: Record<SeatMapVersionStatus, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
};

export const seatsLabel = (count: number) => `${count} siège${count > 1 ? 's' : ''}`;

/** "CODE v2 — 49 sièges", plus a note when the version has been retired. */
export function assignedLabel(version: AssignedSeatMapVersion | null): string {
  if (!version) return 'Aucun';
  const retired = version.status === 'RETIRED' ? ' (version retirée depuis)' : '';
  return `${version.seatMap.code} v${version.version} — ${seatsLabel(version.seatCount)}${retired}`;
}
