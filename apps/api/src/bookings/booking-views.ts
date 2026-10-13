import { type Prisma } from '@euroteranga/database';
import {
  adminPaymentInclude,
  adminPaymentView,
  customerPaymentSelect,
  customerPaymentView,
} from '../payments/payment-views.js';
import { bookingStatus, totalAmountMinor } from './booking-rules.js';

/** Passenger-useful stop data only (no coordinates, no internal flags). */
export const publicStopSelect = {
  id: true,
  code: true,
  name: true,
  locality: true,
  timezone: true,
  country: { select: { iso2: true, name: true } },
} as const satisfies Prisma.StopSelect;

const waypointSelect = {
  id: true,
  sequence: true,
  stop: { select: publicStopSelect },
} as const satisfies Prisma.RouteWaypointSelect;

export const bookingInclude = {
  trip: {
    select: {
      id: true,
      reference: true,
      status: true,
      routeVersion: { select: { route: { select: { code: true, name: true } } } },
      timings: {
        select: { routeWaypointId: true, plannedArrivalAt: true, plannedDepartureAt: true },
      },
    },
  },
  originRouteWaypoint: { select: waypointSelect },
  destinationRouteWaypoint: { select: waypointSelect },
  seats: {
    orderBy: [
      { seatMapCell: { deck: 'asc' } },
      { seatMapCell: { row: 'asc' } },
      { seatMapCell: { column: 'asc' } },
    ],
    select: {
      releasedAt: true,
      seatMapCell: {
        select: { id: true, deck: true, row: true, column: true, seatLabel: true },
      },
    },
  },
  // PR-10: the latest payment attempt (the succeeded one once CONFIRMED).
  payments: { orderBy: { id: 'desc' }, take: 1, select: customerPaymentSelect },
} as const satisfies Prisma.BookingInclude;

export type BookingRow = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

/** STAFF detail: every attempt, shown only with payment.read. */
export const adminBookingInclude = {
  ...bookingInclude,
  payments: { orderBy: { id: 'desc' }, include: adminPaymentInclude },
} as const satisfies Prisma.BookingInclude;

export type AdminBookingRow = Prisma.BookingGetPayload<{ include: typeof adminBookingInclude }>;

function journey(booking: BookingRow) {
  const timing = (waypointId: string) =>
    booking.trip.timings.find((candidate) => candidate.routeWaypointId === waypointId);
  return {
    trip: {
      id: booking.trip.id,
      reference: booking.trip.reference,
      route: booking.trip.routeVersion.route,
    },
    origin: {
      routeWaypointId: booking.originRouteWaypoint.id,
      stop: booking.originRouteWaypoint.stop,
      plannedDepartureAt: timing(booking.originRouteWaypointId)?.plannedDepartureAt ?? null,
    },
    destination: {
      routeWaypointId: booking.destinationRouteWaypoint.id,
      stop: booking.destinationRouteWaypoint.stop,
      plannedArrivalAt: timing(booking.destinationRouteWaypointId)?.plannedArrivalAt ?? null,
    },
  };
}

function money(booking: BookingRow) {
  return {
    unitAmountMinor: booking.unitAmountMinor,
    seatCount: booking.seats.length,
    totalAmountMinor: totalAmountMinor(booking.unitAmountMinor, booking.seats.length),
    currencyCode: booking.currencyCode,
    currencyMinorUnit: booking.currencyMinorUnit,
  };
}

/** What the owning CUSTOMER sees: no internal id, no identity, no reason. */
export function customerBookingView(booking: BookingRow, now: Date) {
  const latestPayment = booking.payments[0];
  return {
    reference: booking.reference,
    status: bookingStatus(booking, now),
    ...journey(booking),
    seats: booking.seats.map(({ releasedAt, seatMapCell }) => ({
      seatLabel: seatMapCell.seatLabel,
      deck: seatMapCell.deck,
      row: seatMapCell.row,
      column: seatMapCell.column,
      releasedAt,
    })),
    ...money(booking),
    holdExpiresAt: booking.holdExpiresAt,
    cancelledAt: booking.cancelledAt,
    confirmedAt: booking.confirmedAt,
    /** Latest attempt (its own reference, status and exact amount), or null. */
    payment: latestPayment ? customerPaymentView(latestPayment) : null,
    createdAt: booking.createdAt,
  };
}

/**
 * STAFF view (booking.read). Deliberately without the customer's email:
 * staff identify a booking by its reference; the customer stays an opaque
 * identity id (identity data stays behind identity.read).
 */
export function adminBookingView(
  booking: BookingRow | AdminBookingRow,
  now: Date,
  options: { withPayments?: boolean } = {},
) {
  return {
    id: booking.id,
    reference: booking.reference,
    status: bookingStatus(booking, now),
    customerIdentityId: booking.customerIdentityId,
    ...journey(booking),
    tripStatus: booking.trip.status,
    seats: booking.seats.map(({ releasedAt, seatMapCell }) => ({
      seatMapCellId: seatMapCell.id,
      seatLabel: seatMapCell.seatLabel,
      deck: seatMapCell.deck,
      row: seatMapCell.row,
      column: seatMapCell.column,
      releasedAt,
    })),
    ...money(booking),
    holdExpiresAt: booking.holdExpiresAt,
    cancelledAt: booking.cancelledAt,
    cancellationReason: booking.cancellationReason,
    confirmedAt: booking.confirmedAt,
    createdAt: booking.createdAt,
    // Financial details only for payment.read (the controller decides).
    ...(options.withPayments && isAdminRow(booking)
      ? { payments: booking.payments.map((payment) => adminPaymentView(payment, now)) }
      : {}),
  };
}

function isAdminRow(booking: BookingRow | AdminBookingRow): booking is AdminBookingRow {
  return booking.payments.every((payment) => 'booking' in payment);
}
