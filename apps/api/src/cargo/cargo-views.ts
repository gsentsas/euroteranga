import type { Prisma } from '@euroteranga/database';

export const cargoSummaryInclude = {
  booking: { select: { reference: true } },
  trip: {
    select: {
      id: true,
      reference: true,
      status: true,
      plannedDepartureAt: true,
      plannedArrivalAt: true,
      routeVersion: { select: { route: { select: { code: true, name: true } } } },
    },
  },
  vehicle: {
    select: {
      id: true,
      code: true,
      name: true,
      role: true,
      payloadCapacityKg: true,
      cargoVolumeLiters: true,
    },
  },
} as const satisfies Prisma.RoadFreightShipmentInclude;

export const cargoEventSelect = {
  id: true,
  sequence: true,
  type: true,
  lifecycleStatus: true,
  exceptionStatus: true,
  occurredAt: true,
  recordedAt: true,
  tripId: true,
  vehicleId: true,
  routeWaypoint: {
    select: {
      sequence: true,
      stop: { select: { code: true, name: true } },
      checkpoint: { select: { code: true, name: true, type: true } },
    },
  },
} as const satisfies Prisma.RoadFreightShipmentEventSelect;

export const cargoDetailInclude = {
  ...cargoSummaryInclude,
  events: { orderBy: { sequence: 'asc' as const }, select: cargoEventSelect },
} as const satisfies Prisma.RoadFreightShipmentInclude;

type CargoSummaryRow = Prisma.RoadFreightShipmentGetPayload<{
  include: typeof cargoSummaryInclude;
}>;
type CargoDetailRow = Prisma.RoadFreightShipmentGetPayload<{ include: typeof cargoDetailInclude }>;
type CargoEventRow = Prisma.RoadFreightShipmentEventGetPayload<{ select: typeof cargoEventSelect }>;

const valueView = (row: CargoSummaryRow) =>
  row.declaredValueMinor === null ||
  row.declaredValueCurrencyCode === null ||
  row.declaredValueCurrencyMinorUnit === null
    ? null
    : {
        amountMinor: row.declaredValueMinor.toString(),
        currencyCode: row.declaredValueCurrencyCode,
        currencyMinorUnit: row.declaredValueCurrencyMinorUnit,
      };

export function cargoEventView(event: CargoEventRow) {
  const waypoint = event.routeWaypoint;
  return {
    sequence: event.sequence,
    type: event.type,
    lifecycleStatus: event.lifecycleStatus,
    exceptionStatus: event.exceptionStatus,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    assignment: {
      tripId: event.tripId,
      vehicleId: event.vehicleId,
    },
    location: waypoint
      ? {
          sequence: waypoint.sequence,
          kind: waypoint.stop ? ('STOP' as const) : ('CHECKPOINT' as const),
          code: waypoint.stop?.code ?? waypoint.checkpoint?.code ?? null,
          name: waypoint.stop?.name ?? waypoint.checkpoint?.name ?? null,
          checkpointType: waypoint.checkpoint?.type ?? null,
        }
      : null,
  };
}

export function cargoSummaryView(row: CargoSummaryRow) {
  return {
    reference: row.reference,
    direction: row.direction,
    lifecycleStatus: row.lifecycleStatus,
    exceptionStatus: row.exceptionStatus,
    senderName: row.senderName,
    recipientName: row.recipientName,
    weightKg: row.weightKg.toFixed(3),
    volumeLiters: row.volumeLiters,
    packageCount: row.packageCount,
    dimensionsCm:
      row.lengthCm === null || row.widthCm === null || row.heightCm === null
        ? null
        : { length: row.lengthCm, width: row.widthCm, height: row.heightCm },
    declaredContents: row.declaredContents,
    declaredValue: valueView(row),
    fragile: row.fragile,
    professional: row.professional,
    pickupRequired: row.pickupRequired,
    deliveryRequired: row.deliveryRequired,
    booking: row.booking ? { reference: row.booking.reference } : null,
    trip: row.trip
      ? {
          id: row.trip.id,
          reference: row.trip.reference,
          status: row.trip.status,
          route: row.trip.routeVersion.route,
          plannedDepartureAt: row.trip.plannedDepartureAt,
          plannedArrivalAt: row.trip.plannedArrivalAt,
        }
      : null,
    vehicle: row.vehicle
      ? {
          id: row.vehicle.id,
          code: row.vehicle.code,
          name: row.vehicle.name,
          role: row.vehicle.role,
          payloadCapacityKg: row.vehicle.payloadCapacityKg,
          cargoVolumeLiters: row.vehicle.cargoVolumeLiters,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function cargoDetailView(row: CargoDetailRow) {
  return {
    ...cargoSummaryView(row),
    senderContact: row.senderContact,
    recipientContact: row.recipientContact,
    events: row.events.map(cargoEventView),
  };
}
