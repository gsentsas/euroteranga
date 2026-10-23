/**
 * DATA-1: the pilot dataset of the Paris ↔ Dakar corridor.
 *
 * Three data categories never mix:
 *
 * - REFERENCE: facts of the real world that operations can keep (ISO country
 *   codes, city coordinates, IANA time zones);
 * - PILOT: synthetic but consistent operational data, clearly marked
 *   (vehicle codes `ET-COACH-*`, plates `DEMO-*`, trip references
 *   `ET-PILOT-*`, the `(pilote)` seat-map name), to be replaced or retired
 *   by operations;
 * - CI fixtures: only in tests, never here.
 *
 * Checkpoint positions, the timetable and the fare are pilot assumptions to
 * be validated by operations. Checkpoints are operational points only: they
 * carry no regulatory, customs or legal meaning.
 */

export const PILOT_SOURCE = 'pilot-bootstrap';
/**
 * /2: neutral make and model for the coaches (no Setra claim).
 * /3: coach names "Teranga Pilote 01/02": "Teranga 01/02" can belong to
 * historical operator vehicles (unique names, see PILOT_PREVIOUS_VEHICLE_NAMES).
 * /4: every future pilot trip receives CHECKPOINT_ONLY tracking with no GPS device.
 */
export const PILOT_DATASET_VERSION = 'pilot-corridor/4';

export interface PilotCountry {
  iso2: string;
  iso3: string;
  name: string;
}

export interface PilotPlace {
  code: string;
  name: string;
  countryIso2: string;
  locality: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface PilotCheckpoint extends PilotPlace {
  type: 'BORDER' | 'FERRY_TERMINAL' | 'PORT' | 'TECHNICAL';
}

export type PilotWaypoint =
  | { kind: 'STOP'; code: string; boardingAllowed: boolean; alightingAllowed: boolean }
  | { kind: 'CHECKPOINT'; code: string };

/** Planned times, in hours after the departure from the first waypoint. */
export interface PilotTiming {
  arrivalHour: number | null;
  departureHour: number | null;
}

export interface PilotRoute {
  code: string;
  name: string;
  direction: 'PARDKR' | 'DKRPAR';
  waypoints: readonly PilotWaypoint[];
  timings: readonly PilotTiming[];
  /** Local departure time at the first stop, in its own time zone. */
  departureLocalTime: string;
  fareTable: { code: string; name: string; currencyCode: string; currencyMinorUnit: number };
  /** Base fare from the first to the last stop, in minor units. */
  fareAmountMinor: number;
}

export interface PilotSeatCell {
  deck: number;
  row: number;
  column: number;
  kind: 'SEAT' | 'AISLE' | 'DRIVER' | 'DOOR' | 'TOILET';
  seatLabel?: string;
}

export interface PilotVehicle {
  code: string;
  name: string;
  manufacturer: string;
  model: string;
  /** Unknown until the owner confirms the real coaches: never invented. */
  modelYear: number | null;
  registrationPlate: string;
  registrationCountryIso2: string;
}

/** REFERENCE: ISO 3166-1 codes and French names. */
export const PILOT_COUNTRIES: readonly PilotCountry[] = [
  { iso2: 'FR', iso3: 'FRA', name: 'France' },
  { iso2: 'ES', iso3: 'ESP', name: 'Espagne' },
  { iso2: 'MA', iso3: 'MAR', name: 'Maroc' },
  { iso2: 'MR', iso3: 'MRT', name: 'Mauritanie' },
  { iso2: 'SN', iso3: 'SEN', name: 'Sénégal' },
];

/** REFERENCE: city-level positions; the exact boarding points are an owner decision. */
export const PILOT_STOPS: readonly PilotPlace[] = [
  {
    code: 'PAR',
    name: 'Paris',
    countryIso2: 'FR',
    locality: 'Paris',
    latitude: 48.8566,
    longitude: 2.3522,
    timezone: 'Europe/Paris',
  },
  {
    code: 'DKR',
    name: 'Dakar',
    countryIso2: 'SN',
    locality: 'Dakar',
    latitude: 14.7167,
    longitude: -17.4677,
    timezone: 'Africa/Dakar',
  },
];

/** PILOT: approximate operational points of the corridor, in travel order from Paris. */
export const PILOT_CHECKPOINTS: readonly PilotCheckpoint[] = [
  {
    code: 'CP-FR-ES-BIRIATOU',
    name: 'Passage France – Espagne (Biriatou)',
    countryIso2: 'FR',
    type: 'BORDER',
    locality: 'Biriatou',
    latitude: 43.3339,
    longitude: -1.7417,
    timezone: 'Europe/Paris',
  },
  {
    code: 'CP-ES-ALGECIRAS',
    name: 'Terminal ferry d’Algésiras',
    countryIso2: 'ES',
    type: 'FERRY_TERMINAL',
    locality: 'Algeciras',
    latitude: 36.13,
    longitude: -5.438,
    timezone: 'Europe/Madrid',
  },
  {
    code: 'CP-MA-TANGER-MED',
    name: 'Port de Tanger Med',
    countryIso2: 'MA',
    type: 'PORT',
    locality: 'Tanger',
    latitude: 35.8833,
    longitude: -5.5,
    timezone: 'Africa/Casablanca',
  },
  {
    code: 'CP-MR-NORD',
    name: 'Entrée en Mauritanie (secteur de Nouadhibou)',
    countryIso2: 'MR',
    type: 'BORDER',
    locality: 'Nouadhibou',
    latitude: 20.9,
    longitude: -17.05,
    timezone: 'Africa/Nouakchott',
  },
  {
    code: 'CP-MR-SN-ROSSO',
    name: 'Passage Mauritanie – Sénégal (Rosso)',
    countryIso2: 'MR',
    type: 'BORDER',
    locality: 'Rosso',
    latitude: 16.5138,
    longitude: -15.805,
    timezone: 'Africa/Nouakchott',
  },
];

const CHECKPOINT_CODES = PILOT_CHECKPOINTS.map((checkpoint) => checkpoint.code);

const PILOT_FARE = { currencyCode: 'EUR', currencyMinorUnit: 2 } as const;

export const PILOT_ROUTES: readonly PilotRoute[] = [
  {
    code: 'ET-PAR-DKR',
    name: 'Paris → Dakar',
    direction: 'PARDKR',
    waypoints: [
      { kind: 'STOP', code: 'PAR', boardingAllowed: true, alightingAllowed: false },
      ...CHECKPOINT_CODES.map((code) => ({ kind: 'CHECKPOINT' as const, code })),
      { kind: 'STOP', code: 'DKR', boardingAllowed: false, alightingAllowed: true },
    ],
    timings: [
      { arrivalHour: null, departureHour: 0 },
      { arrivalHour: 9, departureHour: 9.5 },
      { arrivalHour: 21, departureHour: 23 },
      { arrivalHour: 24.5, departureHour: 26.5 },
      { arrivalHour: 56.5, departureHour: 59.5 },
      { arrivalHour: 73.5, departureHour: 76.5 },
      { arrivalHour: 82.5, departureHour: null },
    ],
    departureLocalTime: '08:00',
    fareTable: { code: 'ET-FT-PAR-DKR-EUR', name: 'Paris → Dakar (pilote, EUR)', ...PILOT_FARE },
    fareAmountMinor: 24_900,
  },
  {
    code: 'ET-DKR-PAR',
    name: 'Dakar → Paris',
    direction: 'DKRPAR',
    waypoints: [
      { kind: 'STOP', code: 'DKR', boardingAllowed: true, alightingAllowed: false },
      ...[...CHECKPOINT_CODES].reverse().map((code) => ({ kind: 'CHECKPOINT' as const, code })),
      { kind: 'STOP', code: 'PAR', boardingAllowed: false, alightingAllowed: true },
    ],
    timings: [
      { arrivalHour: null, departureHour: 0 },
      { arrivalHour: 6, departureHour: 9 },
      { arrivalHour: 23, departureHour: 26 },
      { arrivalHour: 56, departureHour: 58 },
      { arrivalHour: 59.5, departureHour: 61.5 },
      { arrivalHour: 73.5, departureHour: 74 },
      { arrivalHour: 83, departureHour: null },
    ],
    departureLocalTime: '08:00',
    fareTable: { code: 'ET-FT-DKR-PAR-EUR', name: 'Dakar → Paris (pilote, EUR)', ...PILOT_FARE },
    fareAmountMinor: 24_900,
  },
];

const LEFT = ['A', 'B'] as const;
const RIGHT = ['C', 'D'] as const;

/**
 * PILOT seat map: one deck, five columns (A B | aisle | C D), 53 seats.
 * Row 1: driver and front door. Row 8: toilet and middle door on the right.
 * Row 15: back bench of five seats.
 */
function coachCells(): PilotSeatCell[] {
  const cells: PilotSeatCell[] = [
    { deck: 1, row: 1, column: 1, kind: 'DRIVER' },
    { deck: 1, row: 1, column: 3, kind: 'AISLE' },
    { deck: 1, row: 1, column: 5, kind: 'DOOR' },
  ];
  let seatRow = 0;
  for (let row = 2; row <= 14; row += 1) {
    if (row === 8) {
      cells.push(
        { deck: 1, row, column: 3, kind: 'AISLE' },
        { deck: 1, row, column: 4, kind: 'TOILET' },
        { deck: 1, row, column: 5, kind: 'DOOR' },
      );
      continue;
    }
    seatRow += 1;
    LEFT.forEach((letter, index) =>
      cells.push({
        deck: 1,
        row,
        column: index + 1,
        kind: 'SEAT',
        seatLabel: `${seatRow}${letter}`,
      }),
    );
    cells.push({ deck: 1, row, column: 3, kind: 'AISLE' });
    RIGHT.forEach((letter, index) =>
      cells.push({
        deck: 1,
        row,
        column: index + 4,
        kind: 'SEAT',
        seatLabel: `${seatRow}${letter}`,
      }),
    );
  }
  seatRow += 1;
  ['A', 'B', 'C', 'D', 'E'].forEach((letter, index) =>
    cells.push({
      deck: 1,
      row: 15,
      column: index + 1,
      kind: 'SEAT',
      seatLabel: `${seatRow}${letter}`,
    }),
  );
  return cells;
}

export const PILOT_SEAT_MAP = {
  code: 'ET-SM-COACH-53',
  name: 'Autocar grand tourisme 53 places (pilote)',
  cells: coachCells(),
} as const;

/**
 * PILOT: fictitious vehicles; `DEMO-*` plates identify no real vehicle and no
 * VIN is set. The make, model and year of the real coaches are owner data:
 * until confirmed they stay neutral, so that the public website never claims
 * a brand or a model EURO TERANGA does not operate.
 *
 * Their names say "Pilote": vehicle names are unique, and "Teranga 01" and
 * "Teranga 02" can already belong to historical operator vehicles (even
 * retired ones), which the bootstrap never takes over or renames.
 */
export const PILOT_VEHICLES: readonly PilotVehicle[] = [
  {
    code: 'ET-COACH-001',
    name: 'Teranga Pilote 01',
    manufacturer: 'Autocar grand tourisme',
    model: 'Modèle à confirmer',
    modelYear: null,
    registrationPlate: 'DEMO-ET-001',
    registrationCountryIso2: 'FR',
  },
  {
    code: 'ET-COACH-002',
    name: 'Teranga Pilote 02',
    manufacturer: 'Autocar grand tourisme',
    model: 'Modèle à confirmer',
    modelYear: null,
    registrationPlate: 'DEMO-ET-002',
    registrationCountryIso2: 'FR',
  },
];

/**
 * The names pilot-corridor/2 gave the coaches. A coach still carrying one is
 * renamed by the bootstrap only if the audit trail proves the bootstrap
 * created it and no person changed it since; otherwise it is a conflict.
 */
export const PILOT_PREVIOUS_VEHICLE_NAMES: Readonly<Record<string, string>> = {
  'ET-COACH-001': 'Teranga 01',
  'ET-COACH-002': 'Teranga 02',
};

export interface PilotTripSlot {
  reference: string;
  routeCode: string;
  vehicleCode: string;
  /** Local calendar date of the departure at the first stop (YYYY-MM-DD). */
  departureDate: string;
}

/**
 * Departures every 14 days from the anchor date (J+14, J+28, ...). Each
 * coach alternates directions, so a coach is always at the departure stop
 * of its next trip and never serves two overlapping trips.
 */
export function pilotTripSlots(anchorDate: string, tripsPerDirection: number): PilotTripSlot[] {
  const slots: PilotTripSlot[] = [];
  for (let index = 0; index < tripsPerDirection * 2; index += 1) {
    const departureDate = addDays(anchorDate, 14 * (Math.floor(index / 2) + 1));
    const firstCoachOutbound = Math.floor(index / 2) % 2 === 0;
    const outbound = index % 2 === 0;
    const route = PILOT_ROUTES[outbound ? 0 : 1]!;
    const vehicle = PILOT_VEHICLES[outbound === firstCoachOutbound ? 0 : 1]!;
    slots.push({
      reference: `ET-PILOT-${route.direction}-${departureDate.replaceAll('-', '')}`,
      routeCode: route.code,
      vehicleCode: vehicle.code,
      departureDate,
    });
  }
  return slots;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function addDays(date: string, days: number): string {
  const match = DATE.exec(date);
  if (!match) throw new Error(`invalid date ${date}`);
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return value.toISOString().slice(0, 10);
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (Intl only, no dependency). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The UTC instant of a local wall-clock time (`HH:MM`) on `date` in `timeZone`. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const match = DATE.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) throw new Error(`invalid local time ${date} ${time}`);
  const naive = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(clock[1]),
    Number(clock[2]),
  );
  // Two passes settle the offset around daylight-saving transitions.
  let instant = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  instant = new Date(naive - offsetMinutes(instant, timeZone) * 60_000);
  return instant;
}
