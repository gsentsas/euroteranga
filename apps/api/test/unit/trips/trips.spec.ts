import { describe, expect, it } from 'vitest';
import { checkTimetable, type TimetableEntry } from '../../../src/trips/trip-timetable.js';
import {
  tripCancelSchema,
  tripCreateSchema,
  tripListQuerySchema,
  tripTimetableSchema,
  tripVehicleSchema,
} from '../../../src/trips/trip.dto.js';

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2030, 0, 15, 8) + hours * HOUR);
const waypoints = [
  { id: 'w1', sequence: 1 },
  { id: 'w2', sequence: 2 },
  { id: 'w3', sequence: 3 },
];
const valid = (): TimetableEntry[] => [
  { routeWaypointId: 'w1', plannedArrivalAt: null, plannedDepartureAt: at(0) },
  { routeWaypointId: 'w2', plannedArrivalAt: at(2), plannedDepartureAt: at(2.25) },
  { routeWaypointId: 'w3', plannedArrivalAt: at(4), plannedDepartureAt: null },
];

describe('timetable rules', () => {
  it('accepts a complete chronological timetable, in any input order', () => {
    const result = checkTimetable(waypoints, [...valid()].reverse());
    expect(result).toMatchObject({ ok: true, plannedDepartureAt: at(0), plannedArrivalAt: at(4) });
    if (result.ok) expect(result.timings.map((timing) => timing.sequence)).toEqual([1, 2, 3]);
  });

  it('allows a zero dwell at an intermediate waypoint', () => {
    const entries = valid();
    entries[1] = { routeWaypointId: 'w2', plannedArrivalAt: at(2), plannedDepartureAt: at(2) };
    expect(checkTimetable(waypoints, entries).ok).toBe(true);
  });

  const broken: Array<[string, (entries: TimetableEntry[]) => TimetableEntry[], RegExp]> = [
    ['a missing waypoint', (e) => e.slice(0, 2), /exactement/],
    [
      'an unknown waypoint',
      (e) => [e[0]!, { ...e[1]!, routeWaypointId: 'other' }, e[2]!],
      /exactement/,
    ],
    ['a duplicated waypoint', (e) => [...e, e[1]!], /seul horaire/],
    [
      'an arrival at the first waypoint',
      (e) => [{ ...e[0]!, plannedArrivalAt: at(-1) }, e[1]!, e[2]!],
      /premier/,
    ],
    [
      'no departure at the first waypoint',
      (e) => [{ ...e[0]!, plannedDepartureAt: null }, e[1]!, e[2]!],
      /premier/,
    ],
    [
      'a departure at the last waypoint',
      (e) => [e[0]!, e[1]!, { ...e[2]!, plannedDepartureAt: at(5) }],
      /dernier/,
    ],
    [
      'no arrival at the last waypoint',
      (e) => [e[0]!, e[1]!, { ...e[2]!, plannedArrivalAt: null }],
      /dernier/,
    ],
    [
      'an intermediate without departure',
      (e) => [e[0]!, { ...e[1]!, plannedDepartureAt: null }, e[2]!],
      /point 2/,
    ],
    [
      'an intermediate departing before arriving',
      (e) => [e[0]!, { ...e[1]!, plannedArrivalAt: at(3), plannedDepartureAt: at(2.5) }, e[2]!],
      /point 2/,
    ],
    [
      'an arrival equal to the previous departure',
      (e) => [e[0]!, { ...e[1]!, plannedArrivalAt: at(0) }, e[2]!],
      /postérieure/,
    ],
    [
      'an arrival before the previous departure',
      (e) => [e[0]!, e[1]!, { ...e[2]!, plannedArrivalAt: at(2) }],
      /postérieure/,
    ],
  ];
  it.each(broken)('refuses %s', (_label, mutate, message) => {
    const result = checkTimetable(waypoints, mutate(valid()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it('refuses a route version with fewer than two waypoints', () => {
    expect(checkTimetable([{ id: 'w1', sequence: 1 }], valid().slice(0, 1)).ok).toBe(false);
  });
});

describe('trip input validation', () => {
  it('normalizes the reference and bounds its format', () => {
    expect(
      tripCreateSchema.parse({
        reference: ' et-test-2030-0001 ',
        routeVersionId: '01900000-0000-7000-8000-000000000001',
      }).reference,
    ).toBe('ET-TEST-2030-0001');
    for (const reference of ['ET', 'ET TEST', '-ET-TEST', 'E'.repeat(33)]) {
      expect(
        tripCreateSchema.safeParse({
          reference,
          routeVersionId: '01900000-0000-7000-8000-000000000001',
        }).success,
        reference,
      ).toBe(false);
    }
    expect(
      tripCreateSchema.safeParse({
        reference: 'ET-TEST-2030-0001',
        routeVersionId: '01900000-0000-7000-8000-000000000001',
        status: 'SCHEDULED',
      }).success,
    ).toBe(false);
  });

  it('requires explicit UTC offsets in timetable instants', () => {
    const timing = (plannedDepartureAt: string) => ({
      timings: [
        {
          routeWaypointId: '01900000-0000-7000-8000-000000000001',
          plannedArrivalAt: null,
          plannedDepartureAt,
        },
        {
          routeWaypointId: '01900000-0000-7000-8000-000000000002',
          plannedArrivalAt: '2030-01-15T12:00:00Z',
          plannedDepartureAt: null,
        },
      ],
    });
    const parsed = tripTimetableSchema.parse(timing('2030-01-15T09:00:00+01:00'));
    expect(parsed.timings[0]?.plannedDepartureAt?.toISOString()).toBe('2030-01-15T08:00:00.000Z');
    expect(tripTimetableSchema.safeParse(timing('2030-01-15T08:00:00')).success).toBe(false);
    expect(tripTimetableSchema.safeParse(timing('15/01/2030 08:00')).success).toBe(false);
  });

  it('requires a reason to cancel, and validates vehicle assignment bodies', () => {
    expect(tripCancelSchema.safeParse({}).success).toBe(false);
    expect(tripCancelSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(
      tripCancelSchema.safeParse({ reason: 'Annulation', expectedStatus: 'SCHEDULED' }).success,
    ).toBe(true);
    expect(tripVehicleSchema.safeParse({ vehicleId: null }).success).toBe(true);
    expect(tripVehicleSchema.safeParse({}).success).toBe(false);
    expect(tripVehicleSchema.safeParse({ vehicleId: 'not-a-uuid' }).success).toBe(false);
    expect(
      tripVehicleSchema.parse({ vehicleId: null, expectedVehicleId: null }).expectedVehicleId,
    ).toBeNull();
  });

  it('bounds list filters', () => {
    expect(tripListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(tripListQuerySchema.safeParse({ status: 'IN_PROGRESS' }).success).toBe(false);
    expect(
      tripListQuerySchema.parse({ departureFrom: '2030-01-01T00:00:00Z' }).departureFrom,
    ).toEqual(new Date('2030-01-01T00:00:00Z'));
  });
});
