import type { ApiEnv } from '@euroteranga/config';

export interface BookingConfig {
  /** Lifetime of a provisional hold, capped by the trip departure. */
  holdTtlSeconds: number;
  /** Seats per hold, decided by the server only. */
  maxSeatsPerHold: number;
}

export const BOOKING_CONFIG = Symbol('BOOKING_CONFIG');

export function buildBookingConfig(env: ApiEnv): BookingConfig {
  return {
    holdTtlSeconds: env.BOOKING_HOLD_TTL_SECONDS,
    maxSeatsPerHold: env.BOOKING_MAX_SEATS_PER_HOLD,
  };
}
