import { describe, expect, it } from 'vitest';
import { parsePilotArgs, productionRefusal } from '../../../src/pilot/pilot-args.js';
import {
  addDays,
  PILOT_CHECKPOINTS,
  PILOT_DATASET_VERSION,
  PILOT_PREVIOUS_VEHICLE_NAMES,
  PILOT_ROUTES,
  PILOT_SEAT_MAP,
  PILOT_STOPS,
  PILOT_VEHICLES,
  pilotTripSlots,
  zonedTimeToUtc,
} from '../../../src/pilot/pilot-dataset.js';
import { checkCells, seatCountOf } from '../../../src/seat-maps/seat-map-cells.js';
import { REALISTIC_VEHICLES } from '../../../src/seed/realistic/realistic-dataset.js';
import { checkTimetable } from '../../../src/trips/trip-timetable.js';

const HOUR = 3_600_000;

describe('pilot dataset', () => {
  it('describes a valid 53-seat coach with a driver, two doors, an aisle and a toilet', () => {
    const check = checkCells(PILOT_SEAT_MAP.cells);
    expect(check.ok).toBe(true);
    expect(seatCountOf(PILOT_SEAT_MAP.cells)).toBe(53);
    const count = (kind: string) => PILOT_SEAT_MAP.cells.filter((c) => c.kind === kind).length;
    expect([count('DRIVER'), count('DOOR'), count('TOILET')]).toEqual([1, 2, 1]);
    expect(count('AISLE')).toBe(14);
    const labels = PILOT_SEAT_MAP.cells.flatMap((cell) => (cell.seatLabel ? [cell.seatLabel] : []));
    expect(labels.slice(0, 4)).toEqual(['1A', '1B', '1C', '1D']);
    expect(labels.slice(-5)).toEqual(['13A', '13B', '13C', '13D', '13E']);
  });

  it('defines both directions over the same checkpoints, with valid timetables', () => {
    const [outbound, inbound] = PILOT_ROUTES;
    const codes = (route: (typeof PILOT_ROUTES)[number]) => route.waypoints.map((w) => w.code);
    expect(codes(outbound!)).toEqual(['PAR', ...PILOT_CHECKPOINTS.map((c) => c.code), 'DKR']);
    expect(codes(inbound!)).toEqual([...codes(outbound!)].reverse());
    for (const route of PILOT_ROUTES) {
      expect(route.timings).toHaveLength(route.waypoints.length);
      const waypoints = route.waypoints.map((_, index) => ({
        id: `w${index}`,
        sequence: index + 1,
      }));
      const base = Date.UTC(2030, 0, 1);
      const at = (hours: number | null) => (hours === null ? null : new Date(base + hours * HOUR));
      const check = checkTimetable(
        waypoints,
        route.timings.map((timing, index) => ({
          routeWaypointId: `w${index}`,
          plannedArrivalAt: at(timing.arrivalHour),
          plannedDepartureAt: at(timing.departureHour),
        })),
      );
      expect(check.ok, route.code).toBe(true);
      expect(route.fareAmountMinor).toBe(24_900);
    }
  });

  it('marks pilot records explicitly and never sets a VIN', () => {
    for (const vehicle of PILOT_VEHICLES) {
      expect(vehicle.code).toMatch(/^ET-COACH-\d{3}$/);
      expect(vehicle.registrationPlate).toMatch(/^DEMO-/);
      expect(vehicle).not.toHaveProperty('vin');
    }
    expect(PILOT_SEAT_MAP.name).toContain('(pilote)');
    expect(PILOT_STOPS.map((stop) => stop.code)).toEqual(['PAR', 'DKR']);
  });

  it('names its coaches "Teranga Pilote", never a name historical vehicles may hold (pilot-corridor/4)', () => {
    expect(PILOT_DATASET_VERSION).toBe('pilot-corridor/4');
    expect(PILOT_VEHICLES.map((vehicle) => [vehicle.code, vehicle.name])).toEqual([
      ['ET-COACH-001', 'Teranga Pilote 01'],
      ['ET-COACH-002', 'Teranga Pilote 02'],
    ]);
    expect(PILOT_PREVIOUS_VEHICLE_NAMES).toEqual({
      'ET-COACH-001': 'Teranga 01',
      'ET-COACH-002': 'Teranga 02',
    });
    // Every coach the seeds create has its own code, name and plate.
    const coaches = [...PILOT_VEHICLES, ...REALISTIC_VEHICLES];
    for (const field of ['code', 'name'] as const) {
      const values = coaches.map((coach) => coach[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
    const plates = PILOT_VEHICLES.map((coach) => coach.registrationPlate);
    expect(new Set(plates).size).toBe(plates.length);
    const previous = new Set(Object.values(PILOT_PREVIOUS_VEHICLE_NAMES));
    expect(coaches.filter((coach) => previous.has(coach.name))).toEqual([]);
  });

  it('plans fortnightly departures and alternates each coach between directions', () => {
    const slots = pilotTripSlots('2030-03-01', 4);
    expect(slots.map((slot) => slot.departureDate)).toEqual([
      '2030-03-15',
      '2030-03-15',
      '2030-03-29',
      '2030-03-29',
      '2030-04-12',
      '2030-04-12',
      '2030-04-26',
      '2030-04-26',
    ]);
    expect(slots[0]).toEqual({
      reference: 'ET-PILOT-PARDKR-20300315',
      routeCode: 'ET-PAR-DKR',
      vehicleCode: 'ET-COACH-001',
      departureDate: '2030-03-15',
    });
    const coach = (code: string) => slots.filter((slot) => slot.vehicleCode === code);
    expect(coach('ET-COACH-001').map((slot) => slot.routeCode)).toEqual([
      'ET-PAR-DKR',
      'ET-DKR-PAR',
      'ET-PAR-DKR',
      'ET-DKR-PAR',
    ]);
    expect(coach('ET-COACH-002').map((slot) => slot.routeCode)).toEqual([
      'ET-DKR-PAR',
      'ET-PAR-DKR',
      'ET-DKR-PAR',
      'ET-PAR-DKR',
    ]);
    expect(new Set(slots.map((slot) => slot.reference)).size).toBe(8);
  });

  it('converts local departure times to UTC across daylight-saving changes', () => {
    expect(zonedTimeToUtc('2030-01-15', '08:00', 'Europe/Paris').toISOString()).toBe(
      '2030-01-15T07:00:00.000Z',
    );
    expect(zonedTimeToUtc('2030-07-15', '08:00', 'Europe/Paris').toISOString()).toBe(
      '2030-07-15T06:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-10-25', '08:00', 'Europe/Paris').toISOString()).toBe(
      '2026-10-25T07:00:00.000Z',
    );
    expect(zonedTimeToUtc('2030-07-15', '08:00', 'Africa/Dakar').toISOString()).toBe(
      '2030-07-15T08:00:00.000Z',
    );
    expect(addDays('2030-12-25', 14)).toBe('2031-01-08');
  });
});

describe('pilot CLI arguments', () => {
  const now = new Date('2030-03-01T10:00:00Z');

  it('defaults to today, four departures per direction and a real run', () => {
    expect(parsePilotArgs([], now)).toEqual({
      ok: true,
      args: {
        dryRun: false,
        confirmProduction: false,
        anchorDate: '2030-03-01',
        tripsPerDirection: 4,
      },
    });
    expect(
      parsePilotArgs(
        ['--', '--dry-run', '--anchor-date', '2030-04-01', '--trips-per-direction', '2'],
        now,
      ),
    ).toMatchObject({
      ok: true,
      args: { dryRun: true, anchorDate: '2030-04-01', tripsPerDirection: 2 },
    });
  });

  it('refuses unknown options, past or malformed dates and out-of-range counts', () => {
    for (const argv of [
      ['--force'],
      ['positional'],
      ['--anchor-date', '2030-02-28'],
      ['--anchor-date', '01/03/2030'],
      ['--anchor-date', '2030-02-31x'],
      // Future days that do not exist: Date.parse would shift them to May 1 / March 1.
      ['--anchor-date', '2030-04-31'],
      ['--anchor-date', '2031-02-29'],
      ['--trips-per-direction', '0'],
      ['--trips-per-direction', '9'],
      ['--trips-per-direction', '2.5'],
    ]) {
      expect(parsePilotArgs(argv, now).ok, argv.join(' ')).toBe(false);
    }
  });

  it('refuses production unless explicitly confirmed; dry runs are always allowed', () => {
    const parsed = parsePilotArgs([], now);
    const dry = parsePilotArgs(['--dry-run'], now);
    const confirmed = parsePilotArgs(['--confirm-production'], now);
    if (!parsed.ok || !dry.ok || !confirmed.ok) throw new Error('unexpected parse failure');
    expect(productionRefusal('production', parsed.args)).toMatch(/--confirm-production/);
    expect(productionRefusal('production', dry.args)).toBeNull();
    expect(productionRefusal('production', confirmed.args)).toBeNull();
    for (const appEnv of ['local', 'ci', 'staging']) {
      expect(productionRefusal(appEnv, parsed.args)).toBeNull();
    }
  });
});
