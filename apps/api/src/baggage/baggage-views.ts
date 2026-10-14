import type { Prisma } from '@euroteranga/database';
import { baggageQrPayload } from './baggage-rules.js';

const subjectSelect = {
  passenger: {
    select: { reference: true, givenName: true, familyName: true },
  },
  booking: {
    select: {
      reference: true,
      trip: {
        select: {
          reference: true,
          plannedDepartureAt: true,
          plannedArrivalAt: true,
          routeVersion: { select: { route: { select: { code: true, name: true } } } },
        },
      },
    },
  },
} as const;

export const baggageSummaryInclude = {
  bookingPassenger: { select: subjectSelect },
} as const satisfies Prisma.BaggageInclude;

export const baggageEventSelect = {
  id: true,
  sequence: true,
  type: true,
  lifecycleStatus: true,
  exceptionStatus: true,
  measuredWeightKg: true,
  occurredAt: true,
  recordedAt: true,
  routeWaypoint: {
    select: {
      sequence: true,
      stop: { select: { code: true, name: true } },
      checkpoint: { select: { code: true, name: true, type: true } },
    },
  },
} as const satisfies Prisma.BaggageEventSelect;

export const baggageDetailInclude = {
  ...baggageSummaryInclude,
  events: { orderBy: { sequence: 'asc' }, select: baggageEventSelect },
} as const satisfies Prisma.BaggageInclude;

export type BaggageSummaryRow = Prisma.BaggageGetPayload<{
  include: typeof baggageSummaryInclude;
}>;
export type BaggageDetailRow = Prisma.BaggageGetPayload<{
  include: typeof baggageDetailInclude;
}>;
export type BaggageEventRow = Prisma.BaggageEventGetPayload<{
  select: typeof baggageEventSelect;
}>;

function decimal(value: { toFixed(digits: number): string } | null): string | null {
  return value?.toFixed(3) ?? null;
}

/** No UUID, actor, clientEventId, audit metadata or hidden pricing authority. */
export function baggageSummaryView(row: BaggageSummaryRow) {
  return {
    reference: row.reference,
    qrPayload: baggageQrPayload(row.reference),
    type: row.type,
    lifecycleStatus: row.lifecycleStatus,
    exceptionStatus: row.exceptionStatus,
    measuredWeightKg: decimal(row.measuredWeightKg),
    allowance: {
      includedWeightKg: decimal(row.includedWeightKg),
      excessWeightKg: decimal(row.excessWeightKg),
      excessCharge:
        row.excessChargeMinor === null || row.excessChargeCurrencyCode === null
          ? null
          : {
              amountMinor: row.excessChargeMinor.toString(),
              currencyCode: row.excessChargeCurrencyCode,
            },
    },
    passenger: row.bookingPassenger.passenger,
    booking: {
      reference: row.bookingPassenger.booking.reference,
      trip: {
        reference: row.bookingPassenger.booking.trip.reference,
        route: row.bookingPassenger.booking.trip.routeVersion.route,
        plannedDepartureAt: row.bookingPassenger.booking.trip.plannedDepartureAt,
        plannedArrivalAt: row.bookingPassenger.booking.trip.plannedArrivalAt,
      },
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function baggageEventView(row: BaggageEventRow) {
  const waypoint = row.routeWaypoint;
  return {
    sequence: row.sequence,
    type: row.type,
    lifecycleStatus: row.lifecycleStatus,
    exceptionStatus: row.exceptionStatus,
    measuredWeightKg: decimal(row.measuredWeightKg),
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    location: waypoint
      ? {
          sequence: waypoint.sequence,
          kind: waypoint.stop ? ('STOP' as const) : ('CHECKPOINT' as const),
          code: waypoint.stop?.code ?? waypoint.checkpoint!.code,
          name: waypoint.stop?.name ?? waypoint.checkpoint!.name,
          checkpointType: waypoint.checkpoint?.type ?? null,
        }
      : null,
  };
}

export function baggageDetailView(row: BaggageDetailRow) {
  return {
    ...baggageSummaryView(row),
    events: row.events.map(baggageEventView),
  };
}
