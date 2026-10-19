import { createHash } from 'node:crypto';
import type { PrismaClient } from '@euroteranga/database';
import type { SystemCustomerActor } from '../../auth/session/auth-principal.js';
import type { AuditService } from '../../authorization/audit.service.js';
import { bookingCreateSchema } from '../../bookings/booking.dto.js';
import type { BookingService } from '../../bookings/booking.service.js';
import type { PublicBookingService } from '../../bookings/public-booking.service.js';
import { passengerCreateSchema } from '../../passenger-documents/passenger-document.dto.js';
import type { PassengerDocumentService } from '../../passenger-documents/passenger-document.service.js';
import type { PaymentService } from '../../payments/payment.service.js';
import type { PaymentWebhookService } from '../../payments/payment-webhook.service.js';
import {
  REALISTIC_BOOKING_PLAN,
  REALISTIC_FAMILY_INITIALS,
  REALISTIC_GIVEN_NAMES,
  REALISTIC_NATIONALITIES,
  REALISTIC_SOURCE,
  realisticCustomerEmail,
  type RealisticBookingGroup,
} from './realistic-dataset.js';
import { ensureSyntheticIdentity } from './realistic-identities.js';
import { RealisticConflict, type RealisticReporter } from './realistic-report.js';

export interface RealisticCommerceServices {
  audit: AuditService;
  bookings: BookingService;
  publicBooking: PublicBookingService;
  passengers: PassengerDocumentService;
  payments: PaymentService;
  webhooks: PaymentWebhookService;
}

export const DIRECTIONS = [
  { name: 'outbound', short: 'out', routeCode: 'ET-PAR-DKR' },
  { name: 'inbound', short: 'in', routeCode: 'ET-DKR-PAR' },
] as const;

/** Seed customers are recognised by their reserved address, never by guessing. */
const SEED_EMAIL_PREFIX = 'etr-v1-';
const SEED_EMAIL_SUFFIX = '@example.test';

export interface UpcomingTrip {
  id: string;
  reference: string;
  plannedDepartureAt: Date;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
}

interface SeatCell {
  id: string;
  row: number;
  column: number;
  seatLabel: string | null;
  available?: boolean;
}

/** Deterministic pseudo-random numbers from a text seed (mulberry32 over FNV-1a). */
export function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  let state = hash;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seats for one party: side by side in a row when possible (a couple on A-B,
 * a family on two rows of the same side, the back bench for five), otherwise
 * the closest free seats. Travellers alone prefer a window. Never a seat
 * that is not free.
 */
export function chooseSeats<T extends SeatCell>(
  cells: readonly T[],
  size: number,
  random: () => number,
): T[] | null {
  const free = cells.filter((cell) => cell.available !== false);
  if (free.length < size) return null;
  const byRow = new Map<number, T[]>();
  for (const cell of free) byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell]);
  const runs: T[][] = [];
  for (const row of byRow.values()) {
    const sorted = [...row].sort((a, b) => a.column - b.column);
    let run: T[] = [];
    for (const cell of sorted) {
      if (run.length > 0 && cell.column !== run.at(-1)!.column + 1) {
        runs.push(run);
        run = [];
      }
      run.push(cell);
    }
    if (run.length > 0) runs.push(run);
  }
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  if (size === 1) {
    const maxColumn = Math.max(...free.map((cell) => cell.column));
    const windows = free.filter((cell) => cell.column === 1 || cell.column === maxColumn);
    return [pick(windows.length > 0 ? windows : free)];
  }
  const blocks = runs.filter((run) => run.length >= size);
  if (blocks.length > 0) {
    const run = pick(blocks);
    const start = Math.floor(random() * (run.length - size + 1));
    return run.slice(start, start + size);
  }
  // Pairs on consecutive rows of the same side, then any closest free seats.
  const pairs = runs.filter((run) => run.length >= 2).map((run) => run.slice(0, 2));
  if (pairs.length * 2 >= size) {
    const sorted = [...pairs].sort((a, b) => a[0]!.row - b[0]!.row || a[0]!.column - b[0]!.column);
    const start = Math.floor(random() * (sorted.length - Math.ceil(size / 2) + 1));
    return sorted
      .slice(start, start + Math.ceil(size / 2))
      .flat()
      .slice(0, size);
  }
  const ordered = [...free].sort((a, b) => a.row - b.row || a.column - b.column);
  const start = Math.floor(random() * (ordered.length - size + 1));
  return ordered.slice(start, start + size);
}

/** A fictitious traveller of a party: shared family initial, plausible age and nationality. */
export function travellerOf(key: string, index: number, partySize: number) {
  const random = seededRandom(`${key}#traveller#${index}`);
  const family = seededRandom(`${key}#family`);
  const pick = <T>(items: readonly T[], value: number) => items[Math.floor(value * items.length)]!;
  const total = REALISTIC_NATIONALITIES.reduce((sum, [, weight]) => sum + weight, 0);
  let draw = family() * total;
  const nationality =
    REALISTIC_NATIONALITIES.find(([, weight]) => (draw -= weight) < 0)?.[0] ?? 'SN';
  // In a family of three or more, the last travellers are children.
  const child = partySize >= 3 && index >= 2;
  const year = child ? 2010 + Math.floor(random() * 10) : 1958 + Math.floor(random() * 46);
  const month = 1 + Math.floor(random() * 12);
  const day = 1 + Math.floor(random() * 28);
  // Distinct given names within a party: a stride coprime with the list size.
  const base = Math.floor(family() * REALISTIC_GIVEN_NAMES.length);
  return {
    givenName: REALISTIC_GIVEN_NAMES[(base + index * 7) % REALISTIC_GIVEN_NAMES.length]!,
    familyName: `${pick(REALISTIC_FAMILY_INITIALS, family())}.`,
    dateOfBirth: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    nationalityIso2: nationality,
  };
}

/** Upcoming SCHEDULED pilot departures of a route, soonest first, with their journey ends. */
export async function upcomingPilotTrips(
  db: PrismaClient,
  routeCode: string,
  now: Date,
): Promise<UpcomingTrip[]> {
  const trips = await db.trip.findMany({
    where: {
      status: 'SCHEDULED',
      plannedDepartureAt: { gt: now },
      reference: { startsWith: 'ET-PILOT-' },
      routeVersion: { route: { code: routeCode } },
    },
    orderBy: { plannedDepartureAt: 'asc' },
    select: {
      id: true,
      reference: true,
      plannedDepartureAt: true,
      routeVersion: {
        select: {
          waypoints: {
            orderBy: { sequence: 'asc' },
            select: { id: true, boardingAllowed: true, alightingAllowed: true },
          },
        },
      },
    },
  });
  return trips.flatMap((trip) => {
    const origin = trip.routeVersion.waypoints.find((waypoint) => waypoint.boardingAllowed);
    const destination = trip.routeVersion.waypoints.findLast(
      (waypoint) => waypoint.alightingAllowed,
    );
    return origin && destination && trip.plannedDepartureAt
      ? [
          {
            id: trip.id,
            reference: trip.reference,
            plannedDepartureAt: trip.plannedDepartureAt,
            originRouteWaypointId: origin.id,
            destinationRouteWaypointId: destination.id,
          },
        ]
      : [];
  });
}

/**
 * SEED-REALISTIC-1 commerce layer (local and CI only): synthetic customers
 * book the upcoming pilot departures through the booking service, pay
 * through the SANDBOX provider and its signed-event pipeline, and name their
 * passengers. A departure that already has seed bookings is left as it is,
 * so a second run, or a run weeks later, never piles bookings up.
 */
export class RealisticCommerce {
  constructor(
    private readonly db: PrismaClient,
    private readonly services: RealisticCommerceServices,
    private readonly reporter: RealisticReporter,
  ) {}

  async run(options: { dryRun: boolean; now: Date }): Promise<void> {
    const countries = new Map(
      (await this.db.country.findMany({ select: { id: true, iso2: true } })).map((country) => [
        country.iso2,
        country.id,
      ]),
    );
    for (const direction of DIRECTIONS) {
      const trips = await upcomingPilotTrips(this.db, direction.routeCode, options.now);
      const plan = REALISTIC_BOOKING_PLAN[direction.name];
      for (const [position, groups] of plan.entries()) {
        const trip = trips[position];
        const tripKey = `${direction.short}${position}`;
        if (!trip) {
          this.reporter.report({
            layer: 'commerce',
            outcome: options.dryRun ? 'planned' : 'skipped',
            entity: 'booking',
            key: tripKey,
            detail: options.dryRun
              ? `${groups.length} bookings once the departure exists`
              : 'no upcoming departure at this position',
            count: groups.length,
          });
          continue;
        }
        await this.reporter.guarded('commerce', 'booking', trip.reference, [], () =>
          this.ensureTripBookings(trip, tripKey, groups, countries, options.dryRun),
        );
      }
    }
  }

  private async ensureTripBookings(
    trip: UpcomingTrip,
    tripKey: string,
    groups: readonly RealisticBookingGroup[],
    countries: Map<string, string>,
    dry: boolean,
  ): Promise<string | null> {
    const existing = await this.db.booking.count({
      where: {
        tripId: trip.id,
        customerIdentity: {
          normalizedEmail: { startsWith: SEED_EMAIL_PREFIX, endsWith: SEED_EMAIL_SUFFIX },
        },
      },
    });
    if (existing > 0) {
      this.reporter.report({
        layer: 'commerce',
        outcome: 'existing',
        entity: 'booking',
        key: trip.reference,
        detail: `${existing} seed bookings kept`,
        count: existing,
      });
      return trip.id;
    }
    if (dry) {
      const seats = groups.reduce((sum, group) => sum + group.seats, 0);
      this.reporter.report({
        layer: 'commerce',
        outcome: 'planned',
        entity: 'booking',
        key: trip.reference,
        detail: `${groups.length} bookings, ${seats} seats`,
        count: groups.length,
      });
      return null;
    }
    for (const [index, group] of groups.entries()) {
      const key = `${tripKey}-${String(index + 1).padStart(2, '0')}`;
      await this.book(trip, key, group, countries);
    }
    return trip.id;
  }

  private async book(
    trip: UpcomingTrip,
    key: string,
    group: RealisticBookingGroup,
    countries: Map<string, string>,
  ): Promise<void> {
    const { bookings, publicBooking, passengers, payments } = this.services;
    const customer = await this.ensureCustomer(key);
    const actor: SystemCustomerActor = {
      kind: 'system',
      source: REALISTIC_SOURCE,
      customerIdentityId: customer,
    };
    const availability = await publicBooking.availability(
      trip.id,
      trip.originRouteWaypointId,
      trip.destinationRouteWaypointId,
    );
    const cells = (availability.cells as SeatCell[]).filter((cell) => cell.seatLabel !== null);
    const seats = chooseSeats(
      cells.filter((cell) => cell.available === true),
      group.seats,
      seededRandom(`${trip.reference}#${key}`),
    );
    if (!seats) throw new RealisticConflict(`not enough free seats for ${key}`);
    const booking = await bookings.create(
      bookingCreateSchema.parse({
        tripId: trip.id,
        originRouteWaypointId: trip.originRouteWaypointId,
        destinationRouteWaypointId: trip.destinationRouteWaypointId,
        seatMapCellIds: seats.map((seat) => seat.id),
      }),
      actor,
    );
    const labels = seats.map((seat) => seat.seatLabel).join(' ');
    this.reporter.report({
      layer: 'commerce',
      outcome: 'created',
      entity: 'booking',
      key: booking.reference,
      detail: `${trip.reference}, ${group.state}, seats ${labels}`,
    });

    if (group.state === 'cancelled') {
      await bookings.cancelByCustomer(actor, booking.reference);
      return;
    }
    const created = await payments.create(
      actor,
      booking.reference,
      `seed-pay-${booking.reference}`,
    );
    const payment = created.result.payment;
    if (group.state === 'pending') {
      this.reportPayment(payment.reference, 'PENDING, abandoned: the hold will expire');
      return;
    }
    await this.settle(payment.reference, group.state === 'confirmed');
    this.reportPayment(
      payment.reference,
      group.state === 'confirmed' ? 'SUCCEEDED (SANDBOX)' : 'FAILED, declined (SANDBOX)',
    );
    if (group.state !== 'confirmed') return;

    for (let index = 0; index < group.seats; index += 1) {
      const traveller = travellerOf(key, index, group.seats);
      const nationalityCountryId = countries.get(traveller.nationalityIso2);
      if (!nationalityCountryId)
        throw new RealisticConflict(`no ${traveller.nationalityIso2} country`);
      await passengers.createPassenger(
        actor,
        booking.reference,
        passengerCreateSchema.parse({
          givenName: traveller.givenName,
          familyName: traveller.familyName,
          dateOfBirth: traveller.dateOfBirth,
          nationalityCountryId,
        }),
      );
    }
    this.reporter.report({
      layer: 'commerce',
      outcome: 'created',
      entity: 'passenger',
      key: booking.reference,
      count: group.seats,
    });
  }

  private reportPayment(reference: string, detail: string) {
    this.reporter.report({
      layer: 'commerce',
      outcome: 'created',
      entity: 'payment',
      key: reference,
      detail,
    });
  }

  /**
   * The SANDBOX provider's result, through the same webhook pipeline as a
   * provider event (signature checking is the controller's part). No money,
   * no card, no external call: ids are synthetic (`evt_seed_*`).
   */
  private async settle(paymentReference: string, succeeded: boolean): Promise<void> {
    const payment = await this.db.payment.findUniqueOrThrow({
      where: { reference: paymentReference },
      select: { providerPaymentId: true, amountMinor: true, currencyCode: true },
    });
    if (!payment.providerPaymentId) throw new RealisticConflict('SANDBOX attempt without an id');
    const providerEventId = `evt_seed_${paymentReference.replace(/[^A-Za-z0-9]/g, '_')}`;
    const payload = JSON.stringify({
      id: providerEventId,
      type: succeeded ? 'payment.succeeded' : 'payment.failed',
      providerPaymentId: payment.providerPaymentId,
    });
    await this.services.webhooks.process('SANDBOX', {
      providerEventId,
      type: succeeded ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
      providerPaymentId: payment.providerPaymentId,
      amountMinor: BigInt(payment.amountMinor),
      currencyCode: payment.currencyCode,
      failureCode: succeeded ? null : 'DECLINED',
      payloadHash: createHash('sha256').update(payload).digest('hex'),
    });
  }

  /** The synthetic customer of one booking, created once (no password, reserved address). */
  private ensureCustomer(key: string): Promise<string> {
    return ensureSyntheticIdentity(this.db, this.services.audit, this.reporter, {
      layer: 'commerce',
      entity: 'customer',
      key,
      realm: 'CUSTOMER',
      email: realisticCustomerEmail(key),
    });
  }
}
