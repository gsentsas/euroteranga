import { createHash, randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

export const CARGO_REFERENCE_PATTERN = /^ETC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
export const CARGO_WEIGHT_PATTERN = /^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?$/;

export type CargoLifecycle =
  | 'QUOTE'
  | 'BOOKED'
  | 'RECEIVED'
  | 'INSPECTED'
  | 'ASSIGNED'
  | 'LOADED'
  | 'DEPARTED'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'AVAILABLE'
  | 'DELIVERED'
  | 'REFUSED'
  | 'CANCELLED';

export type CargoException = 'HELD' | 'CUSTOMS_HOLD' | 'DAMAGED';

export type CargoEvent =
  CargoLifecycle | CargoException | 'EXCEPTION_RESOLVED' | 'ASSIGNMENT_UPDATED';

export interface CargoProjection {
  lifecycleStatus: CargoLifecycle;
  exceptionStatus: CargoException | null;
}

export class CargoTransitionError extends Error {}

/** 60 bits of CSPRNG entropy and no sender, recipient, journey or routing data. */
export function generateCargoReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETC-${body}`;
}

export function normalizeCargoReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return CARGO_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/** Exact kilograms with three decimal places; no Number conversion. */
export function normalizeCargoWeightKg(value: string): string | null {
  const raw = value.trim();
  if (!CARGO_WEIGHT_PATTERN.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const normalized = `${whole}.${fraction.padEnd(3, '0')}`;
  if (normalized === '0.000') return null;
  return normalized;
}

const nextLifecycle: Partial<Record<CargoLifecycle, CargoLifecycle>> = {
  QUOTE: 'BOOKED',
  BOOKED: 'RECEIVED',
  RECEIVED: 'INSPECTED',
  INSPECTED: 'ASSIGNED',
  ASSIGNED: 'LOADED',
  LOADED: 'DEPARTED',
  DEPARTED: 'IN_TRANSIT',
  IN_TRANSIT: 'ARRIVED',
  ARRIVED: 'AVAILABLE',
  AVAILABLE: 'DELIVERED',
};

const terminal = new Set<CargoLifecycle>(['DELIVERED', 'REFUSED', 'CANCELLED']);
const cancellable = new Set<CargoLifecycle>([
  'QUOTE',
  'BOOKED',
  'RECEIVED',
  'INSPECTED',
  'ASSIGNED',
]);
const exceptionEligible = new Set<CargoLifecycle>([
  'BOOKED',
  'RECEIVED',
  'INSPECTED',
  'ASSIGNED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED',
  'AVAILABLE',
]);

/** Pure mirror of the PostgreSQL transition guard. */
export function projectCargoEvent(current: CargoProjection, type: CargoEvent): CargoProjection {
  if (type === 'QUOTE') throw new CargoTransitionError('QUOTE is initial only');
  if (terminal.has(current.lifecycleStatus)) throw new CargoTransitionError('terminal shipment');

  if (type === 'ASSIGNMENT_UPDATED') {
    if (current.lifecycleStatus !== 'ASSIGNED' || current.exceptionStatus) {
      throw new CargoTransitionError('assignment update is not allowed');
    }
    return current;
  }

  if (type === 'EXCEPTION_RESOLVED') {
    if (!current.exceptionStatus) throw new CargoTransitionError('no active exception');
    return { ...current, exceptionStatus: null };
  }

  if (type === 'HELD' || type === 'CUSTOMS_HOLD' || type === 'DAMAGED') {
    if (current.exceptionStatus || !exceptionEligible.has(current.lifecycleStatus)) {
      throw new CargoTransitionError('exception cannot be opened');
    }
    return { ...current, exceptionStatus: type };
  }

  if (type === 'REFUSED') {
    return { lifecycleStatus: 'REFUSED', exceptionStatus: null };
  }

  if (type === 'CANCELLED') {
    if (!cancellable.has(current.lifecycleStatus)) {
      throw new CargoTransitionError('shipment cannot be cancelled');
    }
    return { lifecycleStatus: 'CANCELLED', exceptionStatus: null };
  }

  if (current.exceptionStatus) {
    throw new CargoTransitionError('active exception must be resolved');
  }

  if (nextLifecycle[current.lifecycleStatus] !== type) {
    throw new CargoTransitionError('invalid lifecycle transition');
  }
  return { lifecycleStatus: type, exceptionStatus: null };
}

export interface CargoEventFingerprintInput {
  type: CargoEvent;
  occurredAt: Date;
  routeWaypointId: string | null;
  tripId: string | null;
  vehicleId: string | null;
}

export function cargoEventFingerprint(input: CargoEventFingerprintInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: input.type,
        occurredAt: input.occurredAt.toISOString(),
        routeWaypointId: input.routeWaypointId,
        tripId: input.tripId,
        vehicleId: input.vehicleId,
      }),
    )
    .digest('hex');
}

export async function withFreshCargoReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generate: () => string = generateCargoReference,
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
