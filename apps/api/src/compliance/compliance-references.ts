import { randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

export const RULE_REFERENCE_PATTERN = /^ETCR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const EVALUATION_REFERENCE_PATTERN = /^ETCE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

function generate(prefix: 'ETCR' | 'ETCE', random: (max: number) => number): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `${prefix}-${body}`;
}

export const generateRuleReference = (random: (max: number) => number = (max) => randomInt(max)) =>
  generate('ETCR', random);

export const generateEvaluationReference = (
  random: (max: number) => number = (max) => randomInt(max),
) => generate('ETCE', random);

function normalize(value: string, pattern: RegExp): string | null {
  const reference = value.trim().toUpperCase();
  return pattern.test(reference) ? reference : null;
}

export const normalizeRuleReference = (value: string) => normalize(value, RULE_REFERENCE_PATTERN);
export const normalizeEvaluationReference = (value: string) =>
  normalize(value, EVALUATION_REFERENCE_PATTERN);

/** Retries a reference collision (unique violation) at most three times. */
export async function withFreshReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generateReference: () => string,
): Promise<T> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await attempt(generateReference());
    } catch (error) {
      if (index === 2 || !collision(error)) throw error;
    }
  }
  throw new Error('unreachable');
}
