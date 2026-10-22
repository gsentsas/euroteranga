import type {
  RoadFreightExceptionStatus,
  RoadFreightLifecycleStatus,
} from '@euroteranga/database';

export type PublicCargoTrackingStatus =
  | 'PREPARING'
  | 'RECEIVED'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'AVAILABLE'
  | 'DELIVERED'
  | 'ATTENTION'
  | 'CANCELLED';

export function publicCargoTrackingStatus(
  lifecycle: RoadFreightLifecycleStatus,
  exception: RoadFreightExceptionStatus | null,
): PublicCargoTrackingStatus {
  if (lifecycle === 'CANCELLED' || lifecycle === 'REFUSED') return 'CANCELLED';
  if (exception) return 'ATTENTION';
  switch (lifecycle) {
    case 'QUOTE':
    case 'BOOKED':
      return 'PREPARING';
    case 'RECEIVED':
    case 'INSPECTED':
    case 'ASSIGNED':
    case 'LOADED':
      return 'RECEIVED';
    case 'DEPARTED':
    case 'IN_TRANSIT':
      return 'IN_TRANSIT';
    case 'ARRIVED':
      return 'ARRIVED';
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'DELIVERED':
      return 'DELIVERED';
  }
}
