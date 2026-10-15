import { randomInt } from 'node:crypto';
import { canonicalJson, fingerprint, type CanonicalValue } from '../compliance/canonical-json.js';

export const MANIFEST_SCHEMA_VERSION = 'passenger-manifest/1';
export const MANIFEST_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const MANIFEST_REFERENCE_PATTERN = /^ETM-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const REFERENCE_LENGTH = 12;

export interface ManifestPlaceSnapshot {
  sequence: number;
  code: string;
  name: string;
  countryIso2: string;
}

export interface ManifestPassengerSnapshot {
  bookingReference: string;
  passengerReference: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  nationality: { iso2: string; iso3: string };
  origin: ManifestPlaceSnapshot;
  destination: ManifestPlaceSnapshot;
  seat: { label: string };
  checkIn: { reference: string; checkedInAt: string };
  boarding: { reference: string; boardedAt: string } | null;
}

export interface PassengerManifestSnapshot {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  trip: {
    reference: string;
    plannedDepartureAt: string;
    plannedArrivalAt: string;
    vehicle: { code: string | null; registrationPlate: string | null };
  };
  passengers: ManifestPassengerSnapshot[];
}

export interface ManifestSnapshotInput {
  trip: PassengerManifestSnapshot['trip'];
  passengers: readonly ManifestPassengerSnapshot[];
}

/** ETM- + 12 Crockford characters, sampled with a CSPRNG (60 bits). */
export function generateManifestReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    body += MANIFEST_REFERENCE_ALPHABET[random(MANIFEST_REFERENCE_ALPHABET.length)];
  }
  return `ETM-${body}`;
}

export function normalizeManifestReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return MANIFEST_REFERENCE_PATTERN.test(reference) ? reference : null;
}

export async function withFreshManifestReference<T>(
  attempt: (reference: string) => Promise<T>,
  isCollision: (error: unknown) => boolean,
  generate: () => string = generateManifestReference,
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

function chunks(value: string): string[] {
  return value.toUpperCase().match(/[0-9]+|[^0-9]+/gu) ?? [];
}

/** Locale-independent natural order: 2A precedes 10A, then raw text breaks ties. */
export function compareSeatLabels(left: string, right: string): number {
  const a = chunks(left);
  const b = chunks(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (/^[0-9]+$/u.test(x) && /^[0-9]+$/u.test(y)) {
      const numeric = BigInt(x) - BigInt(y);
      if (numeric < 0n) return -1;
      if (numeric > 0n) return 1;
    }
    return x < y ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rebuilds every allowed field explicitly. Extra live-model properties are
 * therefore never copied into the immutable PII-minimised snapshot.
 */
export function buildManifestSnapshot(input: ManifestSnapshotInput): PassengerManifestSnapshot {
  const passengers = input.passengers
    .map((passenger): ManifestPassengerSnapshot => ({
      bookingReference: passenger.bookingReference,
      passengerReference: passenger.passengerReference,
      givenName: passenger.givenName,
      familyName: passenger.familyName,
      dateOfBirth: passenger.dateOfBirth,
      nationality: {
        iso2: passenger.nationality.iso2,
        iso3: passenger.nationality.iso3,
      },
      origin: {
        sequence: passenger.origin.sequence,
        code: passenger.origin.code,
        name: passenger.origin.name,
        countryIso2: passenger.origin.countryIso2,
      },
      destination: {
        sequence: passenger.destination.sequence,
        code: passenger.destination.code,
        name: passenger.destination.name,
        countryIso2: passenger.destination.countryIso2,
      },
      seat: { label: passenger.seat.label },
      checkIn: {
        reference: passenger.checkIn.reference,
        checkedInAt: passenger.checkIn.checkedInAt,
      },
      boarding: passenger.boarding
        ? {
            reference: passenger.boarding.reference,
            boardedAt: passenger.boarding.boardedAt,
          }
        : null,
    }))
    .sort(
      (left, right) =>
        compareSeatLabels(left.seat.label, right.seat.label) ||
        (left.passengerReference < right.passengerReference
          ? -1
          : left.passengerReference > right.passengerReference
            ? 1
            : 0),
    );

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    trip: {
      reference: input.trip.reference,
      plannedDepartureAt: input.trip.plannedDepartureAt,
      plannedArrivalAt: input.trip.plannedArrivalAt,
      vehicle: {
        code: input.trip.vehicle.code,
        registrationPlate: input.trip.vehicle.registrationPlate,
      },
    },
    passengers,
  };
}

export function canonicalManifestJson(snapshot: PassengerManifestSnapshot): string {
  return canonicalJson(JSON.parse(JSON.stringify(snapshot)) as CanonicalValue);
}

export function manifestContentHash(snapshot: PassengerManifestSnapshot): string {
  return fingerprint(JSON.parse(JSON.stringify(snapshot)) as CanonicalValue);
}

function safeCsvText(value: string): string {
  const protectedValue = /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(protectedValue)
    ? `"${protectedValue.replaceAll('"', '""')}"`
    : protectedValue;
}

function csvRow(values: readonly (string | number)[]): string {
  return values
    .map((value) => (typeof value === 'number' ? String(value) : safeCsvText(value)))
    .join(',');
}

const CSV_COLUMNS = [
  'manifest_reference',
  'manifest_version',
  'trip_reference',
  'booking_reference',
  'passenger_reference',
  'family_name',
  'given_name',
  'date_of_birth',
  'nationality_iso2',
  'origin_code',
  'destination_code',
  'seat_label',
  'checked_in_at',
  'boarded',
  'boarded_at',
] as const;

/** RFC 4180 CSV, derived solely from the stored immutable snapshot. */
export function renderManifestCsv(input: {
  reference: string;
  version: number;
  snapshot: PassengerManifestSnapshot;
}): string {
  const rows = input.snapshot.passengers.map((passenger) =>
    csvRow([
      input.reference,
      input.version,
      input.snapshot.trip.reference,
      passenger.bookingReference,
      passenger.passengerReference,
      passenger.familyName,
      passenger.givenName,
      passenger.dateOfBirth,
      passenger.nationality.iso2,
      passenger.origin.code,
      passenger.destination.code,
      passenger.seat.label,
      passenger.checkIn.checkedInAt,
      passenger.boarding ? 'true' : 'false',
      passenger.boarding?.boardedAt ?? '',
    ]),
  );
  return [csvRow(CSV_COLUMNS), ...rows].join('\r\n') + '\r\n';
}
