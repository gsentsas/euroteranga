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
import type { PaymentQuoteService } from '../../payments/payment-quote.service.js';
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
  quotes: PaymentQuoteService;
  webhooks: PaymentWebhookService;
}

/**
 * How synthetic customers pay (PAY-HUB-1): a card, from France. The pilot
 * fares are in euros, so the quote is the identity (no conversion) and the
 * SANDBOX event carries the booking amount.
 */
const SEED_PAYMENT = { payerCountry: 'FR', paymentMethod: 'CARD_CB' } as const;

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

/** `etr-v1-out0-03@example.test`: the plan's direction and position (`out`, `0`) and the group (`03`). */
const SEED_CUSTOMER = /^etr-v1-(out|in)(\d+)-(\d{2})@example\.test$/;

const groupKey = (tripKey: string, index: number) =>
  `${tripKey}-${String(index + 1).padStart(2, '0')}`;

type SeedPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** Where a booking of the plan stands (the domain derives EXPIRED from the hold). */
interface SeedBookingState {
  reference: string;
  customerIdentityId: string;
  state: 'HELD' | 'EXPIRED' | 'CONFIRMED' | 'CANCELLED';
  /** The seed's own SANDBOX attempt (`seed-pay-<booking>`), once started. */
  payment: { reference: string; status: SeedPaymentStatus } | null;
  passengers: number;
}

interface SeedBooking extends SeedBookingState {
  /** Payments the seed did not start: the booking is then never touched. */
  foreignPayments: number;
}

function seedBooking(
  row: {
    reference: string;
    customerIdentityId: string;
    cancelledAt: Date | null;
    confirmedAt: Date | null;
    holdExpiresAt: Date;
    payments: ReadonlyArray<{
      reference: string;
      status: SeedPaymentStatus;
      provider: string;
      idempotencyKey: string | null;
    }>;
    _count: { passengers: number };
  },
  now: Date,
): SeedBooking {
  const own = row.payments.filter(
    (payment) =>
      payment.provider === 'SANDBOX' && payment.idempotencyKey === `seed-pay-${row.reference}`,
  );
  const payment = own.length === 1 ? own[0]! : null;
  return {
    reference: row.reference,
    customerIdentityId: row.customerIdentityId,
    state: row.cancelledAt
      ? 'CANCELLED'
      : row.confirmedAt
        ? 'CONFIRMED'
        : row.holdExpiresAt <= now
          ? 'EXPIRED'
          : 'HELD',
    payment: payment ? { reference: payment.reference, status: payment.status } : null,
    passengers: row._count.passengers,
    foreignPayments: row.payments.length - (payment ? 1 : 0),
  };
}

/** The seed's last step for this group has happened: nothing left to do. */
function isComplete(group: RealisticBookingGroup, booking: SeedBooking): boolean {
  if (booking.foreignPayments > 0) return false;
  switch (group.state) {
    case 'cancelled':
      return booking.state === 'CANCELLED' && booking.payment === null;
    case 'pending':
      return booking.payment !== null;
    case 'failed':
      return booking.payment?.status === 'FAILED';
    case 'confirmed':
      return booking.state === 'CONFIRMED' && booking.passengers >= group.seats;
  }
}

/**
 * The steps still to run for a group, which can only follow from where the
 * booking stopped: an active hold (with no payment or the seed's pending
 * one), or a confirmed booking missing passengers. Anything else is a
 * conflict.
 */
function missingSteps(group: RealisticBookingGroup, booking: SeedBookingState): string[] {
  const where = `${booking.reference} is ${booking.state.toLowerCase()}${
    booking.payment ? ` with a ${booking.payment.status.toLowerCase()} payment` : ''
  }`;
  const conflict = () =>
    new RealisticConflict(`${where}: the ${group.state} booking cannot be completed`);
  if (booking.state === 'CONFIRMED') {
    if (group.state !== 'confirmed') throw conflict();
    return [`name ${group.seats - booking.passengers} passengers`];
  }
  if (booking.state !== 'HELD') throw conflict();
  if (group.state === 'cancelled') {
    if (booking.payment) throw conflict();
    return ['cancel the hold'];
  }
  if (booking.payment && booking.payment.status !== 'PENDING') throw conflict();
  const steps = booking.payment ? [] : ['start the SANDBOX payment'];
  if (group.state === 'failed') steps.push('decline the payment');
  if (group.state === 'confirmed')
    steps.push('settle the payment', `name ${group.seats} passengers`);
  return steps;
}

/**
 * SEED-REALISTIC-1 commerce layer (local and CI only): synthetic customers
 * book the upcoming pilot departures through the booking service, pay
 * through the SANDBOX provider and its signed-event pipeline, and name their
 * passengers. A departure that already has seed bookings keeps its plan:
 * an interrupted run is completed, and a second run, or a run weeks later,
 * never books a group twice.
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
        if (!trip) {
          this.reporter.report({
            layer: 'commerce',
            outcome: options.dryRun ? 'planned' : 'skipped',
            entity: 'booking',
            key: `${direction.short}${position}`,
            detail: options.dryRun
              ? `${groups.length} bookings once the departure exists`
              : 'no upcoming departure at this position',
            count: groups.length,
          });
          continue;
        }
        await this.reporter.guarded('commerce', 'booking', trip.reference, [], () =>
          this.ensureTripBookings(trip, direction, position, countries, options),
        );
      }
    }
  }

  /**
   * A departure without seed bookings gets the plan of its position. A
   * departure that has some keeps the plan it was first seeded with (its
   * customers' addresses name it), even once earlier departures have left:
   * complete bookings are kept as they are, missing bookings and the missing
   * steps of an interrupted one are completed, and nothing is booked twice.
   */
  private async ensureTripBookings(
    trip: UpcomingTrip,
    direction: (typeof DIRECTIONS)[number],
    position: number,
    countries: Map<string, string>,
    options: { dryRun: boolean; now: Date },
  ): Promise<string | null> {
    const rows = await this.db.booking.findMany({
      where: {
        tripId: trip.id,
        customerIdentity: {
          normalizedEmail: { startsWith: SEED_EMAIL_PREFIX, endsWith: SEED_EMAIL_SUFFIX },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        reference: true,
        customerIdentityId: true,
        cancelledAt: true,
        confirmedAt: true,
        holdExpiresAt: true,
        customerIdentity: { select: { normalizedEmail: true } },
        payments: {
          select: { reference: true, status: true, provider: true, idempotencyKey: true },
        },
        _count: { select: { passengers: true } },
      },
    });
    const plan = REALISTIC_BOOKING_PLAN[direction.name];
    if (rows.length === 0) {
      const groups = plan[position]!;
      const tripKey = `${direction.short}${position}`;
      if (options.dryRun) {
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
        const key = groupKey(tripKey, index);
        await this.reporter.guarded('commerce', 'booking', key, [], () =>
          this.book(trip, key, group, countries),
        );
      }
      return trip.id;
    }

    const byKey = new Map<string, SeedBooking[]>();
    const tripKeys = new Set<string>();
    for (const row of rows) {
      const match = SEED_CUSTOMER.exec(row.customerIdentity.normalizedEmail);
      if (!match || match[1] !== direction.short) {
        throw new RealisticConflict(`a seed booking of another plan: ${row.reference}`);
      }
      tripKeys.add(`${match[1]}${match[2]}`);
      const key = `${match[1]}${match[2]}-${match[3]}`;
      byKey.set(key, [...(byKey.get(key) ?? []), seedBooking(row, options.now)]);
    }
    if (tripKeys.size > 1) {
      throw new RealisticConflict(`seed bookings of several plans: ${[...tripKeys].join(', ')}`);
    }
    const tripKey = [...tripKeys][0]!;
    const groups = plan[Number(tripKey.slice(direction.short.length))];
    if (!groups) throw new RealisticConflict(`seed bookings of an unknown plan: ${tripKey}`);
    const keys = groups.map((_, index) => groupKey(tripKey, index));
    const strangers = [...byKey.keys()].filter((key) => !keys.includes(key));
    if (strangers.length > 0) {
      throw new RealisticConflict(`seed bookings outside the plan: ${strangers.join(', ')}`);
    }

    let complete = 0;
    for (const [index, group] of groups.entries()) {
      const key = keys[index]!;
      const found = byKey.get(key) ?? [];
      if (found.length === 1 && isComplete(group, found[0]!)) {
        complete += 1;
        continue;
      }
      await this.reporter.guarded('commerce', 'booking', key, [], async () => {
        if (found.length > 1) {
          throw new RealisticConflict(`${found.length} seed bookings for one customer`);
        }
        const booking = found[0];
        if (booking) {
          await this.resume(trip, key, group, countries, booking, options.dryRun);
        } else if (options.dryRun) {
          this.reporter.report({
            layer: 'commerce',
            outcome: 'planned',
            entity: 'booking',
            key,
            detail: `${trip.reference}, ${group.state}, ${group.seats} seats`,
          });
        } else {
          await this.book(trip, key, group, countries);
        }
        return key;
      });
    }
    if (complete > 0) {
      this.reporter.report({
        layer: 'commerce',
        outcome: 'existing',
        entity: 'booking',
        key: trip.reference,
        detail: `${complete} seed bookings complete (plan ${tripKey})`,
        count: complete,
      });
    }
    return trip.id;
  }

  private async book(
    trip: UpcomingTrip,
    key: string,
    group: RealisticBookingGroup,
    countries: Map<string, string>,
  ): Promise<string> {
    const actor = this.actorFor(await this.ensureCustomer(key));
    const availability = await this.services.publicBooking.availability(
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
    const booking = await this.services.bookings.create(
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
    await this.advance(actor, key, group, countries, {
      reference: booking.reference,
      customerIdentityId: actor.customerIdentityId,
      state: 'HELD',
      payment: null,
      passengers: 0,
    });
    return booking.reference;
  }

  /**
   * An interrupted booking of the plan: its customer must still be the
   * seed's own, and its missing steps can only follow from where it stopped.
   * A hold that expired before it was paid, cancelled or confirmed cannot be
   * completed: it is a conflict, left as it is (seats released, nothing
   * rebooked over it).
   */
  private async resume(
    trip: UpcomingTrip,
    key: string,
    group: RealisticBookingGroup,
    countries: Map<string, string>,
    booking: SeedBooking,
    dry: boolean,
  ): Promise<void> {
    if (booking.foreignPayments > 0) {
      throw new RealisticConflict(`${booking.reference} has a payment the seed did not start`);
    }
    const steps = missingSteps(group, booking);
    if (dry) {
      this.reporter.report({
        layer: 'commerce',
        outcome: 'planned',
        entity: 'booking',
        key: booking.reference,
        detail: `${trip.reference}, ${group.state}, resume: ${steps.join(', ')}`,
      });
      return;
    }
    const customerIdentityId = await this.ensureCustomer(key);
    if (customerIdentityId !== booking.customerIdentityId) {
      throw new RealisticConflict(`${booking.reference} belongs to another customer`);
    }
    this.reporter.report({
      layer: 'commerce',
      outcome: 'updated',
      entity: 'booking',
      key: booking.reference,
      detail: `${trip.reference}, ${group.state}, resumed: ${steps.join(', ')}`,
    });
    await this.advance(this.actorFor(customerIdentityId), key, group, countries, booking);
  }

  /** The steps of a booking of the plan, from where it is (validated by missingSteps). */
  private async advance(
    actor: SystemCustomerActor,
    key: string,
    group: RealisticBookingGroup,
    countries: Map<string, string>,
    booking: SeedBookingState,
  ): Promise<void> {
    missingSteps(group, booking);
    if (group.state === 'cancelled') {
      await this.services.bookings.cancelByCustomer(actor, booking.reference);
      return;
    }
    if (booking.state === 'HELD') {
      let payment = booking.payment;
      if (!payment) {
        const quote = await this.services.quotes.create(actor, booking.reference, SEED_PAYMENT);
        const created = await this.services.payments.create(
          actor,
          booking.reference,
          `seed-pay-${booking.reference}`,
          { quoteId: quote.id, paymentMethod: SEED_PAYMENT.paymentMethod },
        );
        payment = { reference: created.result.payment.reference, status: 'PENDING' };
        if (group.state === 'pending') {
          this.reportPayment(payment.reference, 'PENDING, abandoned: the hold will expire');
          return;
        }
      }
      await this.settle(payment.reference, group.state === 'confirmed');
      this.reportPayment(
        payment.reference,
        group.state === 'confirmed' ? 'SUCCEEDED (SANDBOX)' : 'FAILED, declined (SANDBOX)',
        booking.payment ? 'updated' : 'created',
      );
      if (group.state !== 'confirmed') return;
    }
    await this.addPassengers(actor, key, group, countries, booking.reference, booking.passengers);
  }

  /** The travellers of a confirmed booking, in plan order, after those already named. */
  private async addPassengers(
    actor: SystemCustomerActor,
    key: string,
    group: RealisticBookingGroup,
    countries: Map<string, string>,
    bookingReference: string,
    named: number,
  ): Promise<void> {
    for (let index = named; index < group.seats; index += 1) {
      const traveller = travellerOf(key, index, group.seats);
      const nationalityCountryId = countries.get(traveller.nationalityIso2);
      if (!nationalityCountryId)
        throw new RealisticConflict(`no ${traveller.nationalityIso2} country`);
      await this.services.passengers.createPassenger(
        actor,
        bookingReference,
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
      key: bookingReference,
      count: group.seats - named,
    });
  }

  private actorFor(customerIdentityId: string): SystemCustomerActor {
    return { kind: 'system', source: REALISTIC_SOURCE, customerIdentityId };
  }

  private reportPayment(
    reference: string,
    detail: string,
    outcome: 'created' | 'updated' = 'created',
  ) {
    this.reporter.report({
      layer: 'commerce',
      outcome,
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
      select: {
        providerPaymentId: true,
        amountMinor: true,
        currencyCode: true,
        quote: { select: { presentmentAmountMinor: true, presentmentCurrencyCode: true } },
      },
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
      // What the provider collected: the quote's presentment amount.
      amountMinor: payment.quote?.presentmentAmountMinor ?? payment.amountMinor,
      currencyCode: payment.quote?.presentmentCurrencyCode ?? payment.currencyCode,
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
