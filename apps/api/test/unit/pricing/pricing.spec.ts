import { describe, expect, it } from 'vitest';
import { checkFares, isFarePair, type FareWaypoint } from '../../../src/pricing/fare-entries.js';
import {
  fareTableCreateSchema,
  fareTableFaresSchema,
  fareTableUpdateSchema,
} from '../../../src/pricing/pricing.dto.js';
import { tripFareQuerySchema, tripFareTableSchema } from '../../../src/trips/trip.dto.js';

const waypoint = (
  id: string,
  sequence: number,
  overrides: Partial<FareWaypoint> = {},
): FareWaypoint => ({
  id,
  sequence,
  isStop: true,
  boardingAllowed: true,
  alightingAllowed: true,
  label: id.toUpperCase(),
  ...overrides,
});

// A (board) -> C (checkpoint) -> B (board + alight) -> D (alight)
const route = [
  waypoint('a', 1, { alightingAllowed: false }),
  waypoint('c', 2, { isStop: false, boardingAllowed: false, alightingAllowed: false }),
  waypoint('b', 3),
  waypoint('d', 4, { boardingAllowed: false }),
];
const fare = (origin: string, destination: string, amountMinor = 12550) => ({
  originRouteWaypointId: origin,
  destinationRouteWaypointId: destination,
  amountMinor,
});

describe('fare matrix rules', () => {
  it('accepts a partial matrix of boarding -> later alighting stop pairs', () => {
    expect(
      checkFares(route, [fare('a', 'b'), fare('a', 'd', 20000), fare('b', 'd', 7500)]).ok,
    ).toBe(true);
    expect(checkFares(route, [fare('a', 'd')]).ok).toBe(true); // A->B not priced: allowed
    expect(checkFares(route, []).ok).toBe(true);
  });

  it.each<[string, ReturnType<typeof fare>[], RegExp]>([
    ['an unknown waypoint', [fare('a', 'x')], /deux points de la version/],
    ['a checkpoint', [fare('a', 'c')], /uniquement des arrêts/],
    ['an origin without boarding', [fare('d', 'b')], /montée n’est pas autorisée à D/],
    ['a destination without alighting', [fare('b', 'a')], /descente n’est pas autorisée à A/],
    ['an origin after the destination', [fare('b', 'b')], /doit précéder/],
    ['a duplicated pair', [fare('a', 'b'), fare('a', 'b', 1)], /tarifé deux fois/],
    ['a zero amount', [fare('a', 'b', 0)], /entier positif/],
    ['a fractional amount', [fare('a', 'b', 125.5)], /entier positif/],
  ])('refuses %s', (_label, fares, message) => {
    const result = checkFares(route, fares);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it('uses one pair rule for configuration and resolution', () => {
    const [a, c, b, d] = route as [FareWaypoint, FareWaypoint, FareWaypoint, FareWaypoint];
    expect(isFarePair(a, b)).toBe(true);
    expect(isFarePair(b, d)).toBe(true);
    expect(isFarePair(a, c)).toBe(false);
    expect(isFarePair(d, b)).toBe(false);
    expect(isFarePair(b, a)).toBe(false);
  });
});

describe('pricing input validation', () => {
  const base = {
    code: ' route_test_eur ',
    name: 'Tarif test',
    routeId: '01900000-0000-7000-8000-000000000001',
    currencyCode: ' eur ',
    currencyMinorUnit: 2,
    active: true,
  };

  it('normalizes codes and currency, bounds the minor unit', () => {
    expect(fareTableCreateSchema.parse(base)).toMatchObject({
      code: 'ROUTE_TEST_EUR',
      currencyCode: 'EUR',
    });
    expect(
      fareTableCreateSchema.safeParse({ ...base, currencyCode: 'XOF', currencyMinorUnit: 0 })
        .success,
    ).toBe(true);
    for (const override of [
      { currencyCode: 'EU' },
      { currencyCode: 'EURO' },
      { currencyCode: 'E1R' },
      { currencyMinorUnit: 4 },
      { currencyMinorUnit: 1.5 },
      { currencyMinorUnit: -1 },
    ]) {
      expect(
        fareTableCreateSchema.safeParse({ ...base, ...override }).success,
        JSON.stringify(override),
      ).toBe(false);
    }
  });

  it('never updates the route, the currency or the code', () => {
    expect(fareTableUpdateSchema.safeParse({ name: 'Renommé' }).success).toBe(true);
    for (const forbidden of [
      { currencyCode: 'XOF' },
      { currencyMinorUnit: 0 },
      { routeId: base.routeId },
      { code: 'X' },
    ]) {
      expect(fareTableUpdateSchema.safeParse(forbidden).success, JSON.stringify(forbidden)).toBe(
        false,
      );
    }
    expect(fareTableUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('accepts only positive integer amounts in minor units', () => {
    const body = (amountMinor: unknown) => ({
      fares: [
        {
          originRouteWaypointId: base.routeId,
          destinationRouteWaypointId: base.routeId,
          amountMinor,
        },
      ],
    });
    expect(fareTableFaresSchema.safeParse(body(12550)).success).toBe(true);
    for (const amount of [0, -1, 125.5, '12550', 2_147_483_648, null]) {
      expect(fareTableFaresSchema.safeParse(body(amount)).success, String(amount)).toBe(false);
    }
  });

  it('validates trip pricing bodies and fare queries', () => {
    expect(tripFareTableSchema.safeParse({ fareTableVersionId: null }).success).toBe(true);
    expect(tripFareTableSchema.safeParse({}).success).toBe(false);
    expect(
      tripFareTableSchema.parse({ fareTableVersionId: null, expectedFareTableVersionId: null })
        .expectedFareTableVersionId,
    ).toBeNull();
    expect(tripFareQuerySchema.safeParse({ originRouteWaypointId: base.routeId }).success).toBe(
      false,
    );
    expect(
      tripFareQuerySchema.safeParse({
        originRouteWaypointId: base.routeId,
        destinationRouteWaypointId: 'x',
      }).success,
    ).toBe(false);
  });
});
