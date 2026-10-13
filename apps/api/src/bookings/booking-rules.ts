import { randomInt } from 'node:crypto';

/** Crockford base32 (no I, L, O, U): unambiguous when read aloud or typed. */
export const BOOKING_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Same format as the booking_reference_format CHECK. */
export const BOOKING_REFERENCE_PATTERN = /^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const REFERENCE_LENGTH = 12;

/**
 * Public booking reference: ETB- followed by 12 characters drawn with a
 * CSPRNG (60 bits). Never sequential, never derived from the customer, the
 * trip or the time.
 */
export function generateBookingReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETB-${body}`;
}

/** Customer input: trimmed, uppercase; anything else is simply not found. */
export function normalizeBookingReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return BOOKING_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/**
 * Runs `attempt` with a fresh reference, retrying when the unique index on
 * the reference reports an (extremely rare) collision.
 */
export async function withFreshReference<T>(
  attempt: (reference: string) => Promise<T>,
  isCollision: (error: unknown) => boolean,
  generate: () => string = generateBookingReference,
  maxAttempts = 3,
): Promise<T> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (attemptNumber >= maxAttempts || !isCollision(error)) throw error;
    }
  }
}

/**
 * Segments occupied by a journey: segment n runs from waypoint sequence n to
 * n + 1, so origin 2 -> destination 5 occupies [2, 5) = 2, 3, 4.
 */
export function journeySegments(originSequence: number, destinationSequence: number): number[] {
  if (!Number.isInteger(originSequence) || !Number.isInteger(destinationSequence)) {
    throw new Error('sequences must be integers');
  }
  const segments: number[] = [];
  for (let segment = originSequence; segment < destinationSequence; segment += 1) {
    segments.push(segment);
  }
  return segments;
}

export type BookingStatus = 'HELD' | 'EXPIRED' | 'CANCELLED';

/**
 * Derived, never stored: CANCELLED when cancelled, else EXPIRED once the hold
 * time has passed (database clock), else HELD. No background job is needed
 * for inventory safety.
 */
export function bookingStatus(
  booking: { cancelledAt: Date | null; holdExpiresAt: Date },
  now: Date,
): BookingStatus {
  if (booking.cancelledAt) return 'CANCELLED';
  return booking.holdExpiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'HELD';
}

/**
 * Exact total in minor units: integer arithmetic only (BigInt), returned as a
 * number only when it is a safe integer.
 */
export function totalAmountMinor(unitAmountMinor: number, seatCount: number): number {
  const total = BigInt(unitAmountMinor) * BigInt(seatCount);
  const value = Number(total);
  if (!Number.isSafeInteger(value) || BigInt(value) !== total) {
    throw new Error('booking total exceeds the safe integer range');
  }
  return value;
}
