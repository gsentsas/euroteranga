import { randomBytes, randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

const REFERENCE_LENGTH = 12;
export const PASSENGER_REFERENCE_PATTERN = /^ETV-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const DOCUMENT_REFERENCE_PATTERN = /^ETD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

function generateReference(prefix: 'ETV' | 'ETD', random: (max: number) => number): string {
  let body = '';
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `${prefix}-${body}`;
}

export function generatePassengerReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  return generateReference('ETV', random);
}

export function generateDocumentReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  return generateReference('ETD', random);
}

function normalizeReference(value: string, pattern: RegExp): string | null {
  const reference = value.trim().toUpperCase();
  return pattern.test(reference) ? reference : null;
}

export const normalizePassengerReference = (value: string): string | null =>
  normalizeReference(value, PASSENGER_REFERENCE_PATTERN);

export const normalizeDocumentReference = (value: string): string | null =>
  normalizeReference(value, DOCUMENT_REFERENCE_PATTERN);

/** 256 random bits; never derived from a name, passenger, account or date. */
export function generateDocumentObjectKey(bytes: () => Buffer = () => randomBytes(32)): string {
  const body = bytes().toString('hex');
  if (!/^[0-9a-f]{64}$/.test(body)) throw new Error('object key source must return 32 bytes');
  return `passenger-documents/${body.slice(0, 2)}/${body}`;
}

export async function withFreshPassengerReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generate: () => string = generatePassengerReference,
): Promise<T> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (index === 2 || !collision(error)) throw error;
    }
  }
  throw new Error('unreachable');
}

export async function withFreshDocumentIdentity<T>(
  attempt: (reference: string, objectKey: string) => Promise<T>,
  collision: (error: unknown) => boolean,
): Promise<T> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await attempt(generateDocumentReference(), generateDocumentObjectKey());
    } catch (error) {
      if (index === 2 || !collision(error)) throw error;
    }
  }
  throw new Error('unreachable');
}

export function downloadFilename(reference: string, mimeType: string): string {
  const extension =
    mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return `${reference}.${extension}`;
}
