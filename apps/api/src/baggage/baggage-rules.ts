import { createHash, randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

export const BAGGAGE_REFERENCE_PATTERN = /^ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const BAGGAGE_QR_PATTERN = /^ETG1:(ETG-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12})$/;
export const BAGGAGE_WEIGHT_PATTERN = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,3})?$/;

export type BaggageLifecycle =
  'REGISTERED' | 'CHECKED_IN' | 'LOADED' | 'IN_TRANSIT' | 'ARRIVED' | 'DELIVERED' | 'REMOVED';
export type BaggageException = 'MISSING' | 'DAMAGED' | 'HELD_BY_CUSTOMS';
export type BaggageEvent =
  BaggageLifecycle | BaggageException | 'WEIGHT_UPDATED' | 'EXCEPTION_RESOLVED';

export interface BaggageProjection {
  lifecycleStatus: BaggageLifecycle;
  exceptionStatus: BaggageException | null;
  measuredWeightKg: string | null;
}

export class BaggageTransitionError extends Error {}

/** 60 bits of CSPRNG entropy, with no passenger or journey information. */
export function generateBaggageReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETG-${body}`;
}

export function normalizeBaggageReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return BAGGAGE_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/** Versioned, PII-free identifier. It grants no authority by itself. */
export function baggageQrPayload(reference: string): string {
  const normalized = normalizeBaggageReference(reference);
  if (!normalized) throw new Error('invalid baggage reference');
  return `ETG1:${normalized}`;
}

export function parseBaggageQrPayload(value: string): string | null {
  return value.trim().toUpperCase().match(BAGGAGE_QR_PATTERN)?.[1] ?? null;
}

/**
 * Canonical exact kilograms with three decimal places. No Number conversion
 * is used, so 12.345 remains exactly 12.345 through the API boundary.
 */
export function normalizeWeightKg(value: string): string | null {
  const raw = value.trim();
  if (!BAGGAGE_WEIGHT_PATTERN.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const normalized = `${whole}.${fraction.padEnd(3, '0')}`;
  if (normalized === '0.000') return null;
  return normalized;
}

const nextLifecycle: Partial<Record<BaggageLifecycle, BaggageLifecycle>> = {
  REGISTERED: 'CHECKED_IN',
  CHECKED_IN: 'LOADED',
  LOADED: 'IN_TRANSIT',
  IN_TRANSIT: 'ARRIVED',
  ARRIVED: 'DELIVERED',
};

/** Pure mirror of the PostgreSQL transition guard, used before any write. */
export function projectBaggageEvent(
  current: BaggageProjection,
  type: BaggageEvent,
  measuredWeightKg?: string,
): BaggageProjection {
  if (type === 'REGISTERED') throw new BaggageTransitionError('REGISTERED is initial only');
  // REMOVED is the historical terminal projection. Replays are handled before
  // this function; every genuinely new event is refused once it is reached.
  if (current.lifecycleStatus === 'REMOVED') {
    throw new BaggageTransitionError('REMOVED is terminal');
  }
  if (type === 'WEIGHT_UPDATED') {
    const weight = measuredWeightKg ? normalizeWeightKg(measuredWeightKg) : null;
    if (!weight || weight === current.measuredWeightKg) {
      throw new BaggageTransitionError('weight must change');
    }
    return { ...current, measuredWeightKg: weight };
  }
  if (type === 'EXCEPTION_RESOLVED') {
    if (!current.exceptionStatus) throw new BaggageTransitionError('no active exception');
    return { ...current, exceptionStatus: null };
  }
  if (type === 'MISSING' || type === 'DAMAGED' || type === 'HELD_BY_CUSTOMS') {
    if (current.exceptionStatus) {
      throw new BaggageTransitionError('exception cannot be opened');
    }
    return { ...current, exceptionStatus: type };
  }
  if (type === 'REMOVED') {
    if (current.lifecycleStatus === 'DELIVERED') {
      throw new BaggageTransitionError('baggage cannot be removed');
    }
    return { ...current, lifecycleStatus: 'REMOVED' };
  }
  if (current.exceptionStatus) {
    throw new BaggageTransitionError('active exception must be resolved');
  }
  if (nextLifecycle[current.lifecycleStatus] !== type) {
    throw new BaggageTransitionError('invalid lifecycle transition');
  }
  return { ...current, lifecycleStatus: type };
}

export interface FingerprintInput {
  type: BaggageEvent;
  occurredAt: Date;
  routeWaypointId: string | null;
  measuredWeightKg: string | null;
}

export function baggageEventFingerprint(input: FingerprintInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: input.type,
        occurredAt: input.occurredAt.toISOString(),
        routeWaypointId: input.routeWaypointId,
        measuredWeightKg: input.measuredWeightKg,
      }),
    )
    .digest('hex');
}

export async function withFreshBaggageReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generate: () => string = generateBaggageReference,
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
