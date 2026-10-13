import type { VehicleStatus } from '@euroteranga/database';

/**
 * Allowed status transitions. The PR-05 migration enforces the same matrix
 * in PostgreSQL (trigger vehicle_lifecycle_guard); this copy gives callers a
 * stable public error instead of a database exception.
 */
export const VEHICLE_TRANSITIONS: Readonly<Record<VehicleStatus, readonly VehicleStatus[]>> = {
  PLANNED: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['OUT_OF_SERVICE', 'RETIRED'],
  OUT_OF_SERVICE: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

export function isAllowedVehicleTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return VEHICLE_TRANSITIONS[from].includes(to);
}
