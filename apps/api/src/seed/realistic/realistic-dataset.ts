import type { Navigation } from '@euroteranga/content';
import type { VEHICLE_AMENITIES } from '../../fleet/fleet.dto.js';

/**
 * SEED-REALISTIC-1: the demonstration layer stacked on the DATA-1 pilot
 * corridor. Everything here is synthetic and identifiable:
 *
 * - catalogue additions (a third coach, a second seat map, on-board
 *   equipment, public pages and navigation) use the pilot code families
 *   (`ET-COACH-*`, `ET-SM-*`) and are written by the `realistic-seed`
 *   system actor, so the audit trail tells them apart from operator data;
 * - no commercial fact is invented: fares, schedules and coach identities
 *   come from the pilot dataset (owner assumptions to confirm), and every
 *   value an owner must confirm is centralised below.
 */

export const REALISTIC_NAMESPACE = 'ET_REALISTIC_V1';
export const REALISTIC_SOURCE = 'realistic-seed';

/** Upcoming departures per direction (DATA-1 plans them every 14 days from today). */
export const REALISTIC_TRIPS_PER_DIRECTION = 6;

export type VehicleAmenity = (typeof VEHICLE_AMENITIES)[number];

/**
 * DEMO equipment per coach, shown on the public website. The real equipment
 * of each coach is owner data: these values are placeholders to confirm or
 * correct in OPS → Flotte before any public opening.
 */
export const REALISTIC_AMENITIES: Readonly<Record<string, readonly VehicleAmenity[]>> = {
  'ET-COACH-001': [
    'AIR_CONDITIONING',
    'RECLINING_SEATS',
    'USB_CHARGING',
    'WIFI',
    'TOILET',
    'ENTERTAINMENT',
  ],
  'ET-COACH-002': ['AIR_CONDITIONING', 'RECLINING_SEATS', 'USB_CHARGING', 'TOILET'],
  'ET-COACH-003': [
    'AIR_CONDITIONING',
    'RECLINING_SEATS',
    'USB_CHARGING',
    'WIFI',
    'TOILET',
    'WHEELCHAIR_ACCESS',
  ],
};

export interface RealisticSeatCell {
  deck: number;
  row: number;
  column: number;
  kind: 'SEAT' | 'AISLE' | 'DRIVER' | 'DOOR' | 'TOILET' | 'OTHER';
  seatLabel?: string;
}

/**
 * DEMO seat map: one deck, A B | aisle | C D, 49 seats. Row 1: driver and
 * front door. Row 7: toilet and middle door on the right. Row 8: a
 * wheelchair space (OTHER) on the right. Back bench of five seats.
 */
function wheelchairCoachCells(): RealisticSeatCell[] {
  const cells: RealisticSeatCell[] = [
    { deck: 1, row: 1, column: 1, kind: 'DRIVER' },
    { deck: 1, row: 1, column: 3, kind: 'AISLE' },
    { deck: 1, row: 1, column: 5, kind: 'DOOR' },
  ];
  let seatRow = 0;
  const seats = (row: number, letters: readonly string[], columns: readonly number[]) => {
    seatRow += 1;
    letters.forEach((letter, index) =>
      cells.push({
        deck: 1,
        row,
        column: columns[index]!,
        kind: 'SEAT',
        seatLabel: `${seatRow}${letter}`,
      }),
    );
  };
  for (let row = 2; row <= 13; row += 1) {
    if (row === 7 || row === 8) {
      seats(row, ['A', 'B'], [1, 2]);
      cells.push({ deck: 1, row, column: 3, kind: 'AISLE' });
      if (row === 7) {
        cells.push(
          { deck: 1, row, column: 4, kind: 'TOILET' },
          { deck: 1, row, column: 5, kind: 'DOOR' },
        );
      } else {
        cells.push(
          { deck: 1, row, column: 4, kind: 'OTHER' },
          { deck: 1, row, column: 5, kind: 'OTHER' },
        );
      }
      continue;
    }
    seats(row, ['A', 'B'], [1, 2]);
    cells.push({ deck: 1, row, column: 3, kind: 'AISLE' });
    seatRow -= 1;
    seats(row, ['C', 'D'], [4, 5]);
  }
  seats(14, ['A', 'B', 'C', 'D', 'E'], [1, 2, 3, 4, 5]);
  return cells;
}

export const REALISTIC_SEAT_MAP = {
  code: 'ET-SM-COACH-49',
  name: 'Autocar grand tourisme 49 places, espace fauteuil (démo)',
  cells: wheelchairCoachCells(),
} as const;

export interface RealisticVehicle {
  code: string;
  name: string;
  manufacturer: string;
  model: string;
  /** PLANNED: registered, not yet in service, hence absent from the public site. */
  status: 'PLANNED';
  seatMapCode: string;
}

/** DEMO: a third coach being prepared, without plate or VIN until it is real. */
export const REALISTIC_VEHICLES: readonly RealisticVehicle[] = [
  {
    code: 'ET-COACH-003',
    name: 'Teranga 03',
    manufacturer: 'Autocar grand tourisme',
    model: 'Modèle à confirmer',
    status: 'PLANNED',
    seatMapCode: REALISTIC_SEAT_MAP.code,
  },
];

/** Public pages of UI-PUBLIC-2, created from their templates when missing (never indexed). */
export const REALISTIC_PAGE_TEMPLATES = [
  'trip-paris-dakar',
  'trip-dakar-paris',
  'fleet',
  'services',
] as const;

/**
 * The public navigation, published only when the site has none yet (an
 * operator navigation is never replaced). Links to inner pages are kept
 * only when the page is published, so no link can be dead.
 */
export function realisticNavigation(publishedPaths: ReadonlySet<string>): Navigation {
  const page = (label: string, path: string) =>
    publishedPaths.has(path) ? [{ label, target: { kind: 'page' as const, path } }] : [];
  return {
    header: [
      ...page('Paris → Dakar', '/paris-dakar'),
      ...page('Dakar → Paris', '/dakar-paris'),
      ...page('Nos bus', '/nos-bus'),
      ...page('Services', '/services'),
    ],
    headerCta: { label: 'Réserver', target: { kind: 'app', app: 'booking' } },
    footer: [
      {
        title: 'Voyager',
        links: [
          { label: 'Accueil', target: { kind: 'page', path: '/' } },
          ...page('Paris → Dakar', '/paris-dakar'),
          ...page('Dakar → Paris', '/dakar-paris'),
          { label: 'Réserver', target: { kind: 'app', app: 'booking' } },
        ],
      },
      {
        title: 'Mon voyage',
        links: [
          { label: 'Suivre mon voyage', target: { kind: 'app', app: 'tracking' } },
          { label: 'Espace client', target: { kind: 'app', app: 'client' } },
          ...page('Nos bus', '/nos-bus'),
          ...page('Services', '/services'),
        ],
      },
    ],
  };
}

// -- commerce (local and CI only: SANDBOX payments) -------------------------

/**
 * A synthetic customer: a reserved `example.test` address that can receive
 * no mail, ACTIVE as the database requires to hold seats, and no password
 * (no credential row), so no one can ever sign in with it.
 */
export function realisticCustomerEmail(key: string): string {
  return `etr-v1-${key}@example.test`;
}

/** What happens to a booking after its hold: the states the domain supports. */
export type RealisticBookingState = 'confirmed' | 'pending' | 'failed' | 'cancelled';

export interface RealisticBookingGroup {
  seats: number;
  state: RealisticBookingState;
}

const confirmed = (...sizes: number[]): RealisticBookingGroup[] =>
  sizes.map((seats) => ({ seats, state: 'confirmed' }));

/**
 * Bookings of the upcoming departures, by position in each direction (0 is
 * the soonest), on a 53-seat coach: about 85 % and 30 % full Paris → Dakar,
 * 60 % and 6 % Dakar → Paris, one nearly empty departure, the rest empty.
 * Families travel together; a few holds are cancelled, abandoned with a
 * pending payment or refused by the bank (their seats are released when the
 * hold expires).
 */
export const REALISTIC_BOOKING_PLAN: Readonly<
  Record<'outbound' | 'inbound', readonly (readonly RealisticBookingGroup[])[]>
> = {
  outbound: [
    confirmed(4, 2, 5, 3, 2, 4, 1, 3, 5, 2, 4, 1, 3, 2, 4),
    [
      ...confirmed(2, 1, 3, 2, 4, 1, 3),
      { seats: 2, state: 'cancelled' },
      { seats: 1, state: 'pending' },
    ],
    confirmed(2),
  ],
  inbound: [
    [...confirmed(3, 2, 4, 1, 2, 5, 3, 2, 1, 4, 2, 3), { seats: 2, state: 'failed' }],
    confirmed(2, 1),
  ],
};

/** Fictitious travellers: given names and an initial only, never a real person. */
export const REALISTIC_GIVEN_NAMES = [
  'Awa',
  'Mamadou',
  'Fatou',
  'Ibrahima',
  'Mariama',
  'Ousmane',
  'Aminata',
  'Cheikh',
  'Khady',
  'Moussa',
  'Ndeye',
  'Abdoulaye',
  'Coumba',
  'Babacar',
  'Aïssatou',
  'Seydou',
  'Marie',
  'Thomas',
  'Camille',
  'Lucas',
  'Yacine',
  'Salif',
  'Rokhaya',
  'Modou',
  'Astou',
  'Pape',
  'Sokhna',
  'Lamine',
  'Inès',
  'Hugo',
] as const;

export const REALISTIC_FAMILY_INITIALS = 'BCDFGKLMNSTW'.split('');

/** Nationalities of the travellers (corridor countries), by weight. */
export const REALISTIC_NATIONALITIES: ReadonlyArray<[iso2: string, weight: number]> = [
  ['SN', 60],
  ['FR', 25],
  ['MR', 7],
  ['MA', 5],
  ['ES', 3],
];

// -- operations (local and CI only, with the commerce layer) ----------------

/** The seed's own STAFF identity: author of the operational facts it records. */
export const REALISTIC_OPERATOR_EMAIL = 'etr-v1-operations@example.test';

/** Synthetic crew members (CREW realm, no password: the Crew app cannot be opened with them). */
export const realisticCrewEmail = (key: string) => `etr-v1-${key}@example.test`;

/**
 * Crew pairs of the upcoming departures by position. A pair that drives
 * Paris → Dakar at J+14 drives Dakar → Paris at J+28, and the other way
 * round, like the coaches.
 */
export const REALISTIC_CREW_PLAN: Readonly<
  Record<'outbound' | 'inbound', readonly (readonly string[])[]>
> = {
  outbound: [
    ['crew-01', 'crew-02'],
    ['crew-03', 'crew-04'],
  ],
  inbound: [
    ['crew-03', 'crew-04'],
    ['crew-01', 'crew-02'],
  ],
};

/** Bags declared online per traveller of the soonest departures, by weight. */
export const REALISTIC_BAGS_PER_TRAVELLER: ReadonlyArray<[bags: number, weight: number]> = [
  [0, 25],
  [1, 50],
  [2, 25],
];

export const REALISTIC_BAGGAGE_TYPES: ReadonlyArray<
  [type: 'SUITCASE' | 'TRAVEL_BAG' | 'BOX' | 'OTHER', weight: number]
> = [
  ['SUITCASE', 55],
  ['TRAVEL_BAG', 25],
  ['BOX', 15],
  ['OTHER', 5],
];

/**
 * Benign operational notes on the soonest departures, clearly marked as
 * demonstration: no accident, no security or health event, no breakdown.
 */
export const REALISTIC_INCIDENTS: ReadonlyArray<{
  direction: 'outbound' | 'inbound';
  key: string;
  type: 'DELAY' | 'OTHER';
  description: string;
}> = [
  {
    direction: 'outbound',
    key: 'delay',
    type: 'DELAY',
    description:
      'Embarquement prévu avec 30 minutes de décalage : travaux d’accès au terminal de départ (donnée de démonstration).',
  },
  {
    direction: 'inbound',
    key: 'check',
    type: 'OTHER',
    description:
      'Contrôle préventif de l’autocar programmé la veille du départ (donnée de démonstration).',
  },
];
