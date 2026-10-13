import {
  formatMoney,
  type AdminFareWaypoint,
  type AssignedFareTableVersion,
  type FareTableVersionStatus,
} from '@euroteranga/auth-client';

export const FARE_VERSION_STATUS_LABELS: Record<FareTableVersionStatus, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
};

export const faresLabel = (count: number) =>
  `${count} paire${count > 1 ? 's' : ''} tarifée${count > 1 ? 's' : ''}`;

/** Waypoints are the route version's, read with the fare table. */
export interface FarePlace {
  id: string;
  sequence: number;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  stop: { code: string; name: string } | null;
}

export const placeLabel = (waypoint: Pick<AdminFareWaypoint, 'sequence' | 'stop'>) =>
  waypoint.stop
    ? `${waypoint.sequence}. ${waypoint.stop.code} — ${waypoint.stop.name}`
    : `${waypoint.sequence}. Checkpoint`;

/** Fares are defined between stops: origins allow boarding. */
export const fareOrigins = <T extends FarePlace>(waypoints: readonly T[]) =>
  waypoints.filter((waypoint) => waypoint.stop !== null && waypoint.boardingAllowed);

/** Destinations allow alighting and come after the chosen origin. */
export const fareDestinations = <T extends FarePlace>(waypoints: readonly T[], origin?: T) =>
  origin
    ? waypoints.filter(
        (waypoint) =>
          waypoint.stop !== null &&
          waypoint.alightingAllowed &&
          waypoint.sequence > origin.sequence,
      )
    : [];

/** "CODE v2 (EUR) — 3 paires tarifées", plus a note when retired since. */
export function assignedFareLabel(version: AssignedFareTableVersion | null): string {
  if (!version) return 'Aucune';
  const retired = version.status === 'RETIRED' ? ' (version retirée depuis)' : '';
  return `${version.fareTable.code} v${version.version} (${version.fareTable.currencyCode}) — ${faresLabel(version.entryCount)}${retired}`;
}

export const money = (amountMinor: number, currencyCode: string, minorUnit: number) =>
  formatMoney(amountMinor, currencyCode, minorUnit);
