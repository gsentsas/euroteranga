import { randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

export const INCIDENT_REFERENCE_PATTERN = /^ETI-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

export function generateIncidentReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETI-${body}`;
}

export function normalizeIncidentReference(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return INCIDENT_REFERENCE_PATTERN.test(normalized) ? normalized : null;
}
