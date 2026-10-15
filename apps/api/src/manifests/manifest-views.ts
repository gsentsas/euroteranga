import { Prisma } from '@euroteranga/database';
import type { PassengerManifestSnapshot } from './manifest-rules.js';

export const manifestSelect = {
  id: true,
  reference: true,
  version: true,
  schemaVersion: true,
  contentHash: true,
  passengerCount: true,
  boardedCount: true,
  snapshot: true,
  generatedAt: true,
  trip: { select: { reference: true } },
} as const satisfies Prisma.PassengerManifestSelect;

export type ManifestRow = Prisma.PassengerManifestGetPayload<{ select: typeof manifestSelect }>;

export function manifestSummaryView(row: ManifestRow) {
  return {
    reference: row.reference,
    tripReference: row.trip.reference,
    version: row.version,
    schemaVersion: row.schemaVersion,
    contentHash: row.contentHash,
    passengerCount: row.passengerCount,
    boardedCount: row.boardedCount,
    generatedAt: row.generatedAt,
  };
}

export function manifestDetailView(row: ManifestRow) {
  return {
    ...manifestSummaryView(row),
    snapshot: row.snapshot as unknown as PassengerManifestSnapshot,
  };
}
