import {
  Prisma,
  type DatabaseTransaction,
  type TripStatus,
  type VehicleStatus,
} from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { checkTimetable, type TimetableEntry } from './trip-timetable.js';
import type {
  tripCancelSchema,
  tripCreateSchema,
  tripListQuerySchema,
  tripTimetableSchema,
  tripVehicleSchema,
} from './trip.dto.js';
import { TripErrors } from './trip.errors.js';

type ListQuery = z.infer<typeof tripListQuerySchema>;
type TripCreate = z.infer<typeof tripCreateSchema>;
type TripTimetable = z.infer<typeof tripTimetableSchema>;
type TripCancel = z.infer<typeof tripCancelSchema>;
type TripVehicle = z.infer<typeof tripVehicleSchema>;

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
    select: { id: true, code: true, status: true, manufacturer: true, model: true },
  },
} as const;

export interface TripHistoryEntry {
  occurredAt: Date;
  action: string;
  reason: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromVehicleCode: string | null;
  toVehicleCode: string | null;
}

interface LockedTrip {
  id: string;
  status: TripStatus;
  routeVersionId: string;
  vehicleId: string | null;
}

/** Convert expected database failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw TripErrors.referenceConflict();
    if (error.code === 'P2025') throw TripErrors.tripNotFound();
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
    Array<{ id: string; status: TripStatus; route_version_id: string; vehicle_id: string | null }>
  >`
    SELECT "id", "status", "route_version_id", "vehicle_id"
    FROM "trip" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw TripErrors.tripNotFound();
  return {
    id: row.id,
    status: row.status,
    routeVersionId: row.route_version_id,
    vehicleId: row.vehicle_id,
  };
}

/** The vehicle must exist and be ACTIVE; FOR SHARE blocks a concurrent status change. */
async function lockActiveVehicle(
  tx: DatabaseTransaction,
  id: string,
): Promise<{ id: string; code: string }> {
  const rows = await tx.$queryRaw<Array<{ id: string; code: string; status: VehicleStatus }>>`
    SELECT "id", "code", "status" FROM "vehicle" WHERE "id" = ${id}::uuid FOR SHARE
  `;
  const row = rows[0];
  if (!row) throw TripErrors.vehicleNotFound();
  if (row.status !== 'ACTIVE') throw TripErrors.vehicleUnavailable();
  return { id: row.id, code: row.code };
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
    const items = rows.slice(0, query.limit);
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
    }));
    return { ...trip, history };
  }

  /** DRAFT only, on a currently PUBLISHED route version; no implicit timetable. */
  async createTrip(input: TripCreate, actor: AuthPrincipal) {
    const id = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const version = await tx.routeVersion.findUnique({
          where: { id: input.routeVersionId },
          select: { status: true, publishedAt: true },
        });
        if (!version) throw TripErrors.routeVersionNotFound();
        if (version.publishedAt === null) throw TripErrors.routeVersionNotPublished();
        if (version.status === 'RETIRED') throw TripErrors.routeVersionRetired();
        const vehicle = input.vehicleId ? await lockActiveVehicle(tx, input.vehicleId) : null;
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
  async replaceTimetable(id: string, input: TripTimetable, actor: AuthPrincipal) {
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
  async schedule(id: string, actor: AuthPrincipal) {
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
        if (trip.vehicleId) await lockActiveVehicle(tx, trip.vehicleId);

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
            metadata: { reason: input.reason },
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
  async assignVehicle(id: string, input: TripVehicle, actor: AuthPrincipal) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const trip = await lockTrip(tx, id);
        if (trip.status === 'CANCELLED') throw TripErrors.cancelled();
        if (input.expectedVehicleId !== undefined && input.expectedVehicleId !== trip.vehicleId) {
          throw TripErrors.vehicleConflict();
        }
        if (trip.status === 'SCHEDULED' && !input.reason) throw TripErrors.reasonRequired();
        if (input.vehicleId === trip.vehicleId) return;

        const next = input.vehicleId ? await lockActiveVehicle(tx, input.vehicleId) : null;
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
}
