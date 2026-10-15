import { describe, expect, it } from 'vitest';
import {
  buildManifestSnapshot,
  canonicalManifestJson,
  compareSeatLabels,
  generateManifestReference,
  manifestContentHash,
  MANIFEST_REFERENCE_PATTERN,
  renderManifestCsv,
  type ManifestPassengerSnapshot,
} from '../../../src/manifests/manifest-rules.js';

function passenger(
  passengerReference: string,
  seatLabel: string,
  overrides: Partial<ManifestPassengerSnapshot> = {},
): ManifestPassengerSnapshot {
  return {
    bookingReference: 'ETB-111111111111',
    passengerReference,
    givenName: 'Awa',
    familyName: 'Diop',
    dateOfBirth: '1990-04-03',
    nationality: { iso2: 'SN', iso3: 'SEN' },
    origin: { sequence: 1, code: 'DKR', name: 'Dakar', countryIso2: 'SN' },
    destination: { sequence: 5, code: 'PAR', name: 'Paris', countryIso2: 'FR' },
    seat: { label: seatLabel },
    checkIn: { reference: 'ETK-222222222222', checkedInAt: '2030-01-01T08:00:00.000Z' },
    boarding: null,
    ...overrides,
  };
}

const trip = {
  reference: 'ET-TEST-2030-0001',
  plannedDepartureAt: '2030-01-01T10:00:00.000Z',
  plannedArrivalAt: '2030-01-02T08:00:00.000Z',
  vehicle: { code: 'BUS-01', registrationPlate: 'DK-1234-AB' },
};

describe('passenger manifest rules', () => {
  it('generates a Crockford ETM reference from a bounded random source', () => {
    const values = [0, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 31];
    const reference = generateManifestReference(() => values.shift() ?? 0);
    expect(reference).toBe('ETM-01ABCDEFGHJZ');
    expect(reference).toMatch(MANIFEST_REFERENCE_PATTERN);
  });

  it('sorts naturally by seat then passenger reference and hashes canonically', () => {
    const first = buildManifestSnapshot({
      trip,
      passengers: [
        passenger('ETV-333333333333', '10A'),
        passenger('ETV-222222222222', '2A'),
        passenger('ETV-111111111111', '2A'),
      ],
    });
    const second = buildManifestSnapshot({
      passengers: [...first.passengers].reverse(),
      trip: { ...trip, vehicle: { ...trip.vehicle } },
    });
    expect(first.passengers.map((item) => [item.seat.label, item.passengerReference])).toEqual([
      ['2A', 'ETV-111111111111'],
      ['2A', 'ETV-222222222222'],
      ['10A', 'ETV-333333333333'],
    ]);
    expect(canonicalManifestJson(first)).toBe(canonicalManifestJson(second));
    expect(manifestContentHash(first)).toBe(manifestContentHash(second));
    expect(manifestContentHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(compareSeatLabels('9B', '10A')).toBeLessThan(0);
  });

  it('copies only the allowlisted minimized fields', () => {
    const unsafe = {
      ...passenger('ETV-111111111111', '1A'),
      credentialReference: 'ETQ-DO-NOT-COPY',
      deviceId: 'gate-secret',
      customerEmail: 'private@example.test',
      readinessSnapshot: { secret: true },
      paymentReference: 'ETP-SECRET',
      documentNumber: 'P1234567',
      baggage: [{ reference: 'ETG-SECRET' }],
      checkIn: {
        ...passenger('ETV-111111111111', '1A').checkIn,
        checkedInByIdentityId: '00000000-0000-7000-8000-000000000001',
      },
    };
    const snapshot = buildManifestSnapshot({ trip, passengers: [unsafe] });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      'credentialReference',
      'deviceId',
      'customerEmail',
      'readinessSnapshot',
      'paymentReference',
      'documentNumber',
      'baggage',
      'checkedInByIdentityId',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('renders RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    const snapshot = buildManifestSnapshot({
      trip,
      passengers: [
        passenger('ETV-111111111111', '1A', {
          familyName: '=HYPERLINK("https://evil.test")',
          givenName: 'Awa, dite "Amy"\nDeuxième ligne',
        }),
        passenger('ETV-222222222222', '2A', {
          familyName: '+SUM(1,1)',
          givenName: '@cmd',
          boarding: { reference: 'ETE-333333333333', boardedAt: '2030-01-01T09:00:00.000Z' },
        }),
      ],
    });
    const csv = renderManifestCsv({
      reference: 'ETM-000000000000',
      version: 2,
      snapshot,
    });
    expect(csv).toContain('manifest_reference,manifest_version,trip_reference');
    expect(csv).toContain('"\'=HYPERLINK(""https://evil.test"")"');
    expect(csv).toContain('"Awa, dite ""Amy""\nDeuxième ligne"');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain("'@cmd");
    expect(csv).toContain(',true,2030-01-01T09:00:00.000Z\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
