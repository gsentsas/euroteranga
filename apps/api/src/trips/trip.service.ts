import {
  Prisma,
  type DatabaseTransaction,
  type TripStatus,
  type VehicleRole,
  type VehicleStatus,
} from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { Actor, AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { cancelTripHolds } from '../bookings/booking-inventory.js';
import { DatabaseService } from '../database/database.service.js';
import {
  fareTableLabel,
  fareTableVersionIdentity,
  fareTableVersionSummarySelect,
  fareTableVersionView,
  type FareTableVersionIdentity,
  lockAssignableFareTableVersion,
} from '../pricing/fare-assignment.js';
import {
  lockAssignableSeatMapVersion,
  seatMapLabel,
  seatMapVersionSummarySelect,
  seatMapVersionView,
} from '../seat-maps/seat-map-assignment.js';
import { checkTimetable, type TimetableEntry } from './trip-timetable.js';
import type {
  tripCancelSchema,
  tripCreateSchema,
  tripFareTableSchema,
  tripListQuerySchema,
  tripSeatMapSchema,
  tripSupportVehicleSchema,
  tripTimetableSchema,
  tripVehicleSchema,
} from './trip.dto.js';
import { TripErrors } from './trip.errors.js';

type ListQuery = z.infer<typeof tripListQuerySchema>;
type TripCreate = z.infer<typeof tripCreateSchema>;
type TripTimetable = z.infer<typeof tripTimetableSchema>;
type TripCancel = z.infer<typeof tripCancelSchema>;
type TripVehicle = z.infer<typeof tripVehicleSchema>;
type TripSupportVehicle = z.infer<typeof tripSupportVehicleSchema>;
type TripSeatMap = z.infer<typeof tripSeatMapSchema>;
type TripFareTable = z.infer<typeof tripFareTableSchema>;

const placeSummary = { select: { id: true, code: true, name: true, timezone: true } } as const;

const tripSummaryInclude = {
  routeVersion: {
    select: {
      id: true,
      version: true,
      status: true,
      publishedAt: true,
      retiredAt: true,
      route: { select: { id: true, code: true, name: true } },
    },
  },
  vehicle: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      manufacturer: true,
      model: true,
      seatMapVersion: { select: seatMapVersionSummarySelect },
    },
  },
  supportVehicle: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      manufacturer: true,
      model: true,
      role: true,
      payloadCapacityKg: true,
      cargoVolumeLiters: true,
    },
  },
  seatMapVersion: { select: seatMapVersionSummarySelect },
  fareTableVersion: { select: fareTableVersionSummarySelect },
} as const;

/** Public view: seat map summaries carry their computed capacity. */
function tripView<
  T extends {
    departureAuthorizationId: string | null;
    seatMapVersion: { _count: { cells: number } } | null;
    fareTableVersion: { _count: { entries: number } } | null;
    vehicle: { seatMapVersion: { _count: { cells: number } } | null } | null;
  },
>(trip: T) {
  const { departureAuthorizationId: _internalAuthorizationId, ...publicTrip } = trip;
  return {
    ...publicTrip,
    seatMapVersion: seatMapVersionView(trip.seatMapVersion),
    fareTableVersion: fareTableVersionView(trip.fareTableVersion),
    vehicle: trip.vehicle
      ? { ...trip.vehicle, seatMapVersion: seatMapVersionView(trip.vehicle.seatMapVersion) }
      : null,
  };
}

/**
 * Trip view for a caller without pricing.read: the fare-table version is
 * reduced to its identity (id, version, code, currency, number of pairs).
 */
export function withFareTableIdentityOnly<
  T extends { fareTableVersion: FareTableVersionIdentity | null },
>(trip: T): Omit<T, 'fareTableVersion'> & { fareTableVersion: FareTableVersionIdentity | null } {
  return { ...trip, fareTableVersion: fareTableVersionIdentity(trip.fareTableVersion) };
}

export interface TripHistoryEntry {
  occurredAt: Date;
  action: string;
  reason: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromVehicleCode: string | null;
  toVehicleCode: string | null;
  fromSupportVehicleCode: string | null;
  toSupportVehicleCode: string | null;
  fromSeatMap: string | null;
  toSeatMap: string | null;
  fromFareTable: string | null;
  toFareTable: string | null;
}

interface LockedTrip {
  id: string;
  status: TripStatus;
  routeVersionId: string;
  vehicleId: string | null;
  supportVehicleId: string | null;
  seatMapVersionId: string | null;
  fareTableVersionId: string | null;
}

/** Convert expected database failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw TripErrors.referenceConflict();
    if (error.code === 'P2025') throw TripErrors.tripNotFound();
  }
  if (String(error).includes('active road freight would be orphaned')) {
    throw TripErrors.cargoAssignmentConflict();
  }
  throw error;
}

async function mutation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return translateDatabaseError(error);
  }
}

/**
 * Lock order for every trip mutation: the trip row (FOR UPDATE), then the
 * vehicle row (FOR SHARE). Fleet status changes lock only the vehicle row, so
 * no cycle is possible.
 */
async function lockTrip(tx: DatabaseTransaction, id: string): Promise<LockedTrip> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: TripStatus;
      route_version_id: string;
      vehicle_id: string | null;
      support_vehicle_id: string | null;
      seat_map_version_id: string | null;
      fare_table_version_id: string | null;
    }>
  >`
    SELECT "id", "status", "route_version_id", "vehicle_id", "support_vehicle_id",
      "seat_map_version_id", "fare_table_version_id"
    FROM "trip" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw TripErrors.tripNotFound();
  return {
    id: row.id,
    status: row.status,
    routeVersionId: row.route_version_id,
    vehicleId: row.vehicle_id,
    supportVehicleId: row.support_vehicle_id,
    seatMapVersionId: row.seat_map_version_id,
    fareTableVersionId: row.fare_table_version_id,
  };
}

interface LockedVehicle {
  id: string;
  code: string;
  status: VehicleStatus;
  role: VehicleRole;
  seatMapVersionId: string | null;
  payloadCapacityKg: number | null;
  cargoVolumeLiters: number | null;
}

/** The vehicle must exist; FOR SHARE blocks a concurrent status change. */
async function lockVehicle(tx: DatabaseTransaction, id: string): Promise<LockedVehicle> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      code: string;
      status: VehicleStatus;
      role: VehicleRole;
      seat_map_version_id: string | null;
      payload_capacity_kg: number | null;
      cargo_volume_liters: number | null;
    }>
  >`
    SELECT "id", "code", "status", "role", "seat_map_version_id",
      "payload_capacity_kg", "cargo_volume_liters"
    FROM "vehicle" WHERE "id" = ${id}::uuid FOR SHARE
  `;
  const row = rows[0];
  if (!row) throw TripErrors.vehicleNotFound();
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    role: row.role,
    seatMapVersionId: row.seat_map_version_id,
    payloadCapacityKg: row.payload_capacity_kg,
    cargoVolumeLiters: row.cargo_volume_liters,
  };
}

async function lockActiveVehicle(tx: DatabaseTransaction, id: string): Promise<LockedVehicle> {
  const vehicle = await lockVehicle(tx, id);
  if (vehicle.status !== 'ACTIVE') throw TripErrors.vehicleUnavailable();
  return vehicle;
}

function assertPrimaryVehicleRole(vehicle: LockedVehicle): void {
  if (vehicle.role === 'CARGO_SUPPORT') throw TripErrors.primaryVehicleRoleInvalid();
}

function assertSupportVehicleShape(vehicle: LockedVehicle): void {
  if (vehicle.role !== 'CARGO_SUPPORT') throw TripErrors.supportVehicleRoleInvalid();
  if (vehicle.payloadCapacityKg === null || vehicle.cargoVolumeLiters === null) {
    throw TripErrors.supportVehicleCapacityMissing();
  }
}

async function lockActivePrimaryVehicle(
  tx: DatabaseTransaction,
  id: string,
): Promise<LockedVehicle> {
  const vehicle = await lockActiveVehicle(tx, id);
  assertPrimaryVehicleRole(vehicle);
  return vehicle;
}

async function lockActiveSupportVehicle(
  tx: DatabaseTransaction,
  id: string,
): Promise<LockedVehicle> {
  const vehicle = await lockActiveVehicle(tx, id);
  assertSupportVehicleShape(vehicle);
  return vehicle;
}

async function lockScheduledVehicles(
  tx: DatabaseTransaction,
  primaryId: string | null,
  supportId: string | null,
): Promise<{ primary: LockedVehicle | null; support: LockedVehicle | null }> {
  if (primaryId && supportId && primaryId === supportId) {
    throw TripErrors.supportVehicleSameAsPrimary();
  }
  const ids = [...new Set([primaryId, supportId].filter((id): id is string => Boolean(id)))].sort();
  const locked = new Map<string, LockedVehicle>();
  for (const id of ids) locked.set(id, await lockActiveVehicle(tx, id));
  const primary = primaryId ? (locked.get(primaryId) ?? null) : null;
  const support = supportId ? (locked.get(supportId) ?? null) : null;
  if (primary) assertPrimaryVehicleRole(primary);
  if (support) assertSupportVehicleShape(support);
  return { primary, support };
}

/**
 * FLEET-1 / CONVOY-1: one physical vehicle never serves overlapping active
 * trips, whether it is the primary or support vehicle. Advisory locks are
 * always acquired in canonical UUID order, matching the database trigger.
 */
async function assertVehiclesAvailable(
  tx: DatabaseTransaction,
  vehicleIds: readonly string[],
  tripId: string,
  window: { plannedDepartureAt: Date; plannedArrivalAt: Date },
): Promise<void> {
  const ids = [...new Set(vehicleIds)].sort();
  for (const vehicleId of ids) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${'trip-vehicle:' + vehicleId}, 0))
    `;
  }
  for (const vehicleId of ids) {
    const conflicts = await tx.$queryRaw<Array<{ reference: string }>>`
      SELECT "reference" FROM "trip"
      WHERE ("vehicle_id" = ${vehicleId}::uuid OR "support_vehicle_id" = ${vehicleId}::uuid)
        AND "id" <> ${tripId}::uuid
        AND "status" IN ('SCHEDULED', 'IN_PROGRESS')
        AND "planned_departure_at" < ${window.plannedArrivalAt}
        AND "planned_arrival_at" > ${window.plannedDepartureAt}
      ORDER BY "planned_departure_at", "id"
      LIMIT 1
    `;
    const conflict = conflicts[0];
    if (conflict) throw TripErrors.vehicleOverlap(conflict.reference);
  }
}

/**
 * CARGO-1: changing the convoy must never leave active freight pointing to a
 * vehicle that no longer belongs to the trip. The trip row is already locked
 * FOR UPDATE, which serializes this check against cargo assignment's FOR SHARE.
 */
async function assertCargoStaysInConvoy(
  tx: DatabaseTransaction,
  tripId: string,
  primaryVehicleId: string | null,
  supportVehicleId: string | null,
): Promise<void> {
  const convoyIds = [primaryVehicleId, supportVehicleId].filter((id): id is string => id !== null);
  const conflicting = await tx.roadFreightShipment.findFirst({
    where: {
      tripId,
      lifecycleStatus: {
        in: ['ASSIGNED', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'AVAILABLE'],
      },
      vehicleId: convoyIds.length > 0 ? { notIn: convoyIds } : { not: null },
    },
    select: { id: true },
  });
  if (conflicting) throw TripErrors.cargoAssignmentConflict();
}

/**
 * PR-07 compatibility: a trip that carries a seat map can only have a vehicle
 * configured with exactly that version (a vehicle without seat map does not
 * match). Checked when either side of the trip changes and when scheduling.
 */
function assertCompatible(
  tripSeatMapVersionId: string | null,
  vehicle: { seatMapVersionId: string | null } | null,
): void {
  if (tripSeatMapVersionId && vehicle && vehicle.seatMapVersionId !== tripSeatMapVersionId) {
    throw TripErrors.seatMapIncompatible();
  }
}

async function seatMapLabelOf(tx: DatabaseTransaction, id: string | null): Promise<string | null> {
  if (!id) return null;
  const version = await tx.seatMapVersion.findUnique({
    where: { id },
    select: { version: true, seatMap: { select: { code: true } } },
  });
  return version ? seatMapLabel(version.seatMap.code, version.version) : null;
}

async function vehicleCode(tx: DatabaseTransaction, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await tx.vehicle.findUnique({ where: { id }, select: { code: true } }))?.code ?? null;
}

function fieldOf(value: unknown, key: string): string | null {
  if (value && typeof value === 'object' && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : null;
  }
  return null;
}

async function routeWaypoints(tx: DatabaseTransaction, routeVersionId: string) {
  return tx.routeWaypoint.findMany({
    where: { routeVersionId },
    orderBy: { sequence: 'asc' },
    select: { id: true, sequence: true },
  });
}

/** Business authority for trips, their timetable and vehicle assignment. */
@Injectable()
export class TripService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listTrips(query: ListQuery) {
    const departure =
      query.departureFrom || query.departureTo
        ? {
            plannedDepartureAt: {
              ...(query.departureFrom ? { gte: query.departureFrom } : {}),
              ...(query.departureTo ? { lt: query.departureTo } : {}),
            },
          }
        : {};
    const rows = await this.database.client.trip.findMany({
      take: query.limit + 1,
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.routeVersionId ? { routeVersionId: query.routeVersionId } : {}),
        ...(query.routeId ? { routeVersion: { routeId: query.routeId } } : {}),
        ...departure,
      },
      orderBy: { id: 'desc' },
      include: tripSummaryInclude,
    });
    const items = rows.slice(0, query.limit).map(tripView);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Trip with its route version geometry, timetable, vehicle summary and a
   * business history read from the audit trail (no actor identity).
   */
  async trip(id: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { id },
      include: {
        ...tripSummaryInclude,
        routeVersion: {
          select: {
            ...tripSummaryInclude.routeVersion.select,
            waypoints: {
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                sequence: true,
                boardingAllowed: true,
                alightingAllowed: true,
                stop: placeSummary,
                checkpoint: { select: { ...placeSummary.select, type: true } },
              },
            },
          },
        },
        timings: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            routeWaypointId: true,
            sequence: true,
            plannedArrivalAt: true,
            plannedDepartureAt: true,
          },
        },
      },
    });
    if (!trip) throw TripErrors.tripNotFound();
    const events = await this.database.client.auditEvent.findMany({
      where: { resourceType: 'trip', resourceId: id },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: { occurredAt: true, action: true, before: true, after: true, metadata: true },
    });
    const history: TripHistoryEntry[] = events.map((event) => ({
      occurredAt: event.occurredAt,
      action: event.action,
      reason: fieldOf(event.metadata, 'reason'),
      fromStatus: fieldOf(event.before, 'status'),
      toStatus: fieldOf(event.after, 'status'),
      fromVehicleCode: fieldOf(event.before, 'vehicleCode'),
      toVehicleCode: fieldOf(event.after, 'vehicleCode'),
      fromSupportVehicleCode: fieldOf(event.before, 'supportVehicleCode'),
      toSupportVehicleCode: fieldOf(event.after, 'supportVehicleCode'),
      fromSeatMap: fieldOf(event.before, 'seatMap'),
      toSeatMap: fieldOf(event.after, 'seatMap'),
      fromFareTable: fieldOf(event.before, 'fareTable'),
      toFareTable: fieldOf(event.after, 'fareTable'),
    }));
    return { ...tripView(trip), history };
  }

  /** DRAFT only, on a currently PUBLISHED route version; no implicit timetable. */
  async createTrip(input: TripCreate, actor: Actor) {
    const id = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const version = await tx.routeVersion.findUnique({
          where: { id: input.routeVersionId },
          select: { status: true, publishedAt: true },
        });
        if (!version) throw TripErrors.routeVersionNotFound();
        if (version.publishedAt === null) throw TripErrors.routeVersionNotPublished();
        if (version.status === 'RETIRED') throw TripErrors.routeVersionRetired();
        const vehicle = input.vehicleId
          ? await lockActivePrimaryVehicle(tx, input.vehicleId)
          : null;
        const trip = await tx.trip.create({
          data: {
            reference: input.reference,
            routeVersionId: input.routeVersionId,
            vehicleId: vehicle?.id ?? null,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_CREATED',
            resourceType: 'trip',
            resourceId: trip.id,
            after: { ...trip, vehicleCode: vehicle?.code ?? null },
          },
          tx,
        );
        return trip.id;
      }),
    );
    return this.trip(id);
  }

  /** Atomic replacement of the complete DRAFT timetable. */
  async replaceTimetable(id: string, input: TripTimetable, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status !== 'DRAFT') throw TripErrors.notDraft();
        const check = checkTimetable(await routeWaypoints(tx, trip.routeVersionId), input.timings);
        if (!check.ok) throw TripErrors.timetableInvalid(check.message);

        const before = await tx.tripWaypointTiming.findMany({
          where: { tripId: id },
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            routeWaypointId: true,
            plannedArrivalAt: true,
            plannedDepartureAt: true,
          },
        });
        await tx.tripWaypointTiming.deleteMany({ where: { tripId: id } });
        await tx.tripWaypointTiming.createMany({
          data: check.timings.map((timing) => ({
            tripId: id,
            routeWaypointId: timing.routeWaypointId,
            sequence: timing.sequence,
            plannedArrivalAt: timing.plannedArrivalAt,
            plannedDepartureAt: timing.plannedDepartureAt,
          })),
        });
        await tx.trip.update({
          where: { id },
          data: {
            plannedDepartureAt: check.plannedDepartureAt,
            plannedArrivalAt: check.plannedArrivalAt,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_TIMETABLE_REPLACED',
            resourceType: 'trip',
            resourceId: id,
            before,
            after: check.timings.map(
              ({ sequence, routeWaypointId, plannedArrivalAt, plannedDepartureAt }) => ({
                sequence,
                routeWaypointId,
                plannedArrivalAt,
                plannedDepartureAt,
              }),
            ),
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /** DRAFT -> SCHEDULED after a full re-validation; the timetable is then frozen. */
  async schedule(id: string, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status !== 'DRAFT') throw TripErrors.notDraft();
        const version = await tx.routeVersion.findUniqueOrThrow({
          where: { id: trip.routeVersionId },
          select: { publishedAt: true },
        });
        if (version.publishedAt === null) throw TripErrors.routeVersionNotPublished();
        const stored: TimetableEntry[] = await tx.tripWaypointTiming.findMany({
          where: { tripId: id },
          select: { routeWaypointId: true, plannedArrivalAt: true, plannedDepartureAt: true },
        });
        const check = checkTimetable(await routeWaypoints(tx, trip.routeVersionId), stored);
        if (!check.ok) throw TripErrors.timetableInvalid(check.message);
        const { primary: vehicle, support } = await lockScheduledVehicles(
          tx,
          trip.vehicleId,
          trip.supportVehicleId,
        );
        assertCompatible(trip.seatMapVersionId, vehicle);
        await assertVehiclesAvailable(
          tx,
          [vehicle?.id, support?.id].filter((candidate): candidate is string => Boolean(candidate)),
          id,
          check,
        );

        const scheduledAt = new Date();
        await tx.trip.update({
          where: { id },
          data: {
            status: 'SCHEDULED',
            scheduledAt,
            plannedDepartureAt: check.plannedDepartureAt,
            plannedArrivalAt: check.plannedArrivalAt,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_SCHEDULED',
            resourceType: 'trip',
            resourceId: id,
            before: { status: 'DRAFT' },
            after: {
              status: 'SCHEDULED',
              scheduledAt,
              plannedDepartureAt: check.plannedDepartureAt,
              plannedArrivalAt: check.plannedArrivalAt,
            },
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /** DRAFT | SCHEDULED -> CANCELLED, with a reason; CANCELLED is terminal. */
  async cancel(id: string, input: TripCancel, actor: AuthPrincipal) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (input.expectedStatus && input.expectedStatus !== trip.status) {
          throw TripErrors.statusConflict();
        }
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status === 'IN_PROGRESS' || trip.status === 'COMPLETED') {
          throw TripErrors.dispatchStarted();
        }
        // PR-09: release every active hold first (trip already FOR UPDATE).
        // PR-22: only confirmed bookings not yet fully refunded block cancellation;
        // PENDING payment attempts are cancelled with their holds.
        const reference = await tx.trip.findUniqueOrThrow({
          where: { id },
          select: { reference: true },
        });
        const cascade = await cancelTripHolds(tx, this.audit, {
          tripId: id,
          tripReference: reference.reference,
          actor,
          reason: input.reason,
        });
        if (cascade.confirmedBookingCount > 0) throw TripErrors.hasConfirmedBookings();
        const { cancelledBookingCount, cancelledPaymentCount } = cascade;
        const cancelledAt = new Date();
        await tx.trip.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt } });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_CANCELLED',
            resourceType: 'trip',
            resourceId: id,
            before: { status: trip.status },
            after: { status: 'CANCELLED', cancelledAt },
            metadata: { reason: input.reason, cancelledBookingCount, cancelledPaymentCount },
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /**
   * Assign, change or remove the vehicle of a DRAFT or SCHEDULED trip. The
   * new vehicle must be ACTIVE. A reason is required once SCHEDULED.
   */
  async assignVehicle(id: string, input: TripVehicle, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status === 'IN_PROGRESS' || trip.status === 'COMPLETED') {
          throw TripErrors.dispatchStarted();
        }
        if (input.expectedVehicleId !== undefined && input.expectedVehicleId !== trip.vehicleId) {
          throw TripErrors.vehicleConflict();
        }
        if (trip.status === 'SCHEDULED' && !input.reason) throw TripErrors.reasonRequired();
        if (input.vehicleId === trip.vehicleId) return;
        if (input.vehicleId && input.vehicleId === trip.supportVehicleId) {
          throw TripErrors.supportVehicleSameAsPrimary();
        }

        const next = input.vehicleId ? await lockActivePrimaryVehicle(tx, input.vehicleId) : null;
        assertCompatible(trip.seatMapVersionId, next);
        if (next && trip.status === 'SCHEDULED') {
          const window = await tx.trip.findUniqueOrThrow({
            where: { id },
            select: { plannedDepartureAt: true, plannedArrivalAt: true },
          });
          if (window.plannedDepartureAt && window.plannedArrivalAt) {
            await assertVehiclesAvailable(
              tx,
              [next.id, trip.supportVehicleId].filter((candidate): candidate is string =>
                Boolean(candidate),
              ),
              id,
              {
                plannedDepartureAt: window.plannedDepartureAt,
                plannedArrivalAt: window.plannedArrivalAt,
              },
            );
          }
        }
        await assertCargoStaysInConvoy(tx, id, next?.id ?? null, trip.supportVehicleId);
        const previousCode = await vehicleCode(tx, trip.vehicleId);
        await tx.trip.update({ where: { id }, data: { vehicleId: next?.id ?? null } });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_VEHICLE_CHANGED',
            resourceType: 'trip',
            resourceId: id,
            before: { vehicleId: trip.vehicleId, vehicleCode: previousCode },
            after: { vehicleId: next?.id ?? null, vehicleCode: next?.code ?? null },
            ...(input.reason ? { metadata: { reason: input.reason } } : {}),
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /**
   * Assign, change or remove the optional CARGO_SUPPORT vehicle. The primary
   * vehicle remains Trip.vehicleId; no dispatch decision is automated here.
   */
  async assignSupportVehicle(id: string, input: TripSupportVehicle, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status === 'IN_PROGRESS' || trip.status === 'COMPLETED') {
          throw TripErrors.dispatchStarted();
        }
        if (
          input.expectedSupportVehicleId !== undefined &&
          input.expectedSupportVehicleId !== trip.supportVehicleId
        ) {
          throw TripErrors.supportVehicleConflict();
        }
        if (trip.status === 'SCHEDULED' && !input.reason) throw TripErrors.reasonRequired();
        if (input.supportVehicleId === trip.supportVehicleId) return;
        if (input.supportVehicleId && input.supportVehicleId === trip.vehicleId) {
          throw TripErrors.supportVehicleSameAsPrimary();
        }

        const next = input.supportVehicleId
          ? await lockActiveSupportVehicle(tx, input.supportVehicleId)
          : null;
        if (next && trip.status === 'SCHEDULED') {
          const window = await tx.trip.findUniqueOrThrow({
            where: { id },
            select: { plannedDepartureAt: true, plannedArrivalAt: true },
          });
          if (window.plannedDepartureAt && window.plannedArrivalAt) {
            await assertVehiclesAvailable(
              tx,
              [trip.vehicleId, next.id].filter((candidate): candidate is string =>
                Boolean(candidate),
              ),
              id,
              {
                plannedDepartureAt: window.plannedDepartureAt,
                plannedArrivalAt: window.plannedArrivalAt,
              },
            );
          }
        }

        await assertCargoStaysInConvoy(tx, id, trip.vehicleId, next?.id ?? null);
        const previousCode = await vehicleCode(tx, trip.supportVehicleId);
        await tx.trip.update({
          where: { id },
          data: { supportVehicleId: next?.id ?? null },
        });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_SUPPORT_VEHICLE_CHANGED',
            resourceType: 'trip',
            resourceId: id,
            before: {
              supportVehicleId: trip.supportVehicleId,
              supportVehicleCode: previousCode,
            },
            after: {
              supportVehicleId: next?.id ?? null,
              supportVehicleCode: next?.code ?? null,
            },
            ...(input.reason ? { metadata: { reason: input.reason } } : {}),
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /**
   * Assign, replace or remove the historical seat map of a DRAFT trip. A new
   * assignment needs a currently PUBLISHED version of an active seat map; if
   * a vehicle is assigned, it must be configured with exactly that version.
   * Nothing is ever assigned implicitly.
   * Lock order: trip FOR UPDATE, vehicle FOR SHARE, seat_map then
   * seat_map_version FOR SHARE.
   */
  async assignSeatMap(id: string, input: TripSeatMap, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status !== 'DRAFT') throw TripErrors.notDraft();
        if (
          input.expectedSeatMapVersionId !== undefined &&
          input.expectedSeatMapVersionId !== trip.seatMapVersionId
        ) {
          throw TripErrors.seatMapConflict();
        }
        if (input.seatMapVersionId === trip.seatMapVersionId) return;

        const vehicle = trip.vehicleId ? await lockVehicle(tx, trip.vehicleId) : null;
        const next = input.seatMapVersionId
          ? await lockAssignableSeatMapVersion(tx, input.seatMapVersionId)
          : null;
        assertCompatible(next?.id ?? null, vehicle);
        const previous = await seatMapLabelOf(tx, trip.seatMapVersionId);
        await tx.trip.update({ where: { id }, data: { seatMapVersionId: next?.id ?? null } });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_SEAT_MAP_CHANGED',
            resourceType: 'trip',
            resourceId: id,
            before: { seatMapVersionId: trip.seatMapVersionId, seatMap: previous },
            after: {
              seatMapVersionId: next?.id ?? null,
              seatMap: next ? seatMapLabel(next.seatMapCode, next.version) : null,
            },
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }

  /**
   * Assign, replace or remove the historical pricing of a DRAFT trip. A new
   * assignment needs a currently PUBLISHED version of an active fare table
   * pricing exactly the trip's route version. Nothing is assigned implicitly.
   * Lock order: trip FOR UPDATE, fare_table then fare_table_version FOR SHARE.
   */
  async assignFareTable(id: string, input: TripFareTable, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (trip.status !== 'DRAFT') throw TripErrors.notDraft();
        if (
          input.expectedFareTableVersionId !== undefined &&
          input.expectedFareTableVersionId !== trip.fareTableVersionId
        ) {
          throw TripErrors.fareTableConflict();
        }
        if (input.fareTableVersionId === trip.fareTableVersionId) return;

        const next = input.fareTableVersionId
          ? await lockAssignableFareTableVersion(tx, input.fareTableVersionId)
          : null;
        if (next && next.routeVersionId !== trip.routeVersionId) {
          throw TripErrors.fareTableIncompatible();
        }
        const previous = trip.fareTableVersionId
          ? await tx.fareTableVersion.findUnique({
              where: { id: trip.fareTableVersionId },
              select: { version: true, fareTable: { select: { code: true, currencyCode: true } } },
            })
          : null;
        await tx.trip.update({ where: { id }, data: { fareTableVersionId: next?.id ?? null } });
        await this.audit.record(
          {
            actor,
            action: 'TRIP_FARE_TABLE_CHANGED',
            resourceType: 'trip',
            resourceId: id,
            before: {
              fareTableVersionId: trip.fareTableVersionId,
              fareTable: previous
                ? fareTableLabel(
                    previous.fareTable.code,
                    previous.version,
                    previous.fareTable.currencyCode,
                  )
                : null,
            },
            after: {
              fareTableVersionId: next?.id ?? null,
              fareTable: next ? fareTableLabel(next.code, next.version, next.currencyCode) : null,
            },
          },
          tx,
        );
      }),
    );
    return this.trip(id);
  }
}
