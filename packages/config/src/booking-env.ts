import { z } from 'zod';

/**
 * Booking hold settings (PR-09). Server-side only: a client never chooses the
 * hold duration or the seat limit.
 *
 * - BOOKING_HOLD_TTL_SECONDS: lifetime of a provisional hold, 60 s to 1 h
 *   (default 15 min). A hold never outlasts the trip departure.
 * - BOOKING_MAX_SEATS_PER_HOLD: seats per hold, 1 to 20 (default 8). With
 *   amounts bounded by PostgreSQL INTEGER, totals stay exact JavaScript
 *   integers (20 x 2 147 483 647 < 2^53).
 */
export const BOOKING_HOLD_TTL_SECONDS_BOUNDS = { min: 60, max: 3600, default: 900 } as const;
export const BOOKING_MAX_SEATS_PER_HOLD_BOUNDS = { min: 1, max: 20, default: 8 } as const;

export const bookingEnvShape = {
  BOOKING_HOLD_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(BOOKING_HOLD_TTL_SECONDS_BOUNDS.min)
    .max(BOOKING_HOLD_TTL_SECONDS_BOUNDS.max)
    .default(BOOKING_HOLD_TTL_SECONDS_BOUNDS.default),
  BOOKING_MAX_SEATS_PER_HOLD: z.coerce
    .number()
    .int()
    .min(BOOKING_MAX_SEATS_PER_HOLD_BOUNDS.min)
    .max(BOOKING_MAX_SEATS_PER_HOLD_BOUNDS.max)
    .default(BOOKING_MAX_SEATS_PER_HOLD_BOUNDS.default),
};
