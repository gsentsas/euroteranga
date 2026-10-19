import { Prisma, type DatabaseTransaction, type VehicleStatus } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  lockAssignableSeatMapVersion,
  seatMapLabel,
  seatMapVersionSummarySelect,
  seatMapVersionView,
} from '../seat-maps/seat-map-assignment.js';
import type {
  vehicleCreateSchema,
  vehicleListQuerySchema,
  vehicleSeatMapSchema,
  vehicleStatusSchema,
  vehicleUpdateSchema,
} from './fleet.dto.js';
import { FleetErrors } from './fleet.errors.js';
import { isAllowedVehicleTransition } from './vehicle-lifecycle.js';

type ListQuery = z.infer<typeof vehicleListQuerySchema>;
type VehicleCreate = z.infer<typeof vehicleCreateSchema>;
type VehicleUpdate = z.infer<typeof vehicleUpdateSchema>;
type VehicleStatusChange = z.infer<typeof vehicleStatusSchema>;
type VehicleSeatMap = z.infer<typeof vehicleSeatMapSchema>;

const STATUS_CHANGED = 'VEHICLE_STATUS_CHANGED';

const vehicleInclude = {
  registrationCountry: { select: { id: true, iso2: true, iso3: true, name: true, active: true } },
  seatMapVersion: { select: seatMapVersionSummarySelect },
} as const;

/** Public view: the seat map summary carries its computed capacity. */
function vehicleView<T extends { seatMapVersion: { _count: { cells: number } } | null }>(
  vehicle: T,
) {
  return { ...vehicle, seatMapVersion: seatMapVersionView(vehicle.seatMapVersion) };
}

export interface VehicleStatusHistoryEntry {
  occurredAt: Date;
  from: string | null;
  to: string | null;
  reason: string | null;
}

/** Convert expected database failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw FleetErrors.identifierConflict();
    if (error.code === 'P2003') throw FleetErrors.countryNotFound();
    if (error.code === 'P2025') throw FleetErrors.vehicleNotFound();
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

/** Serializes every write to one vehicle (status changes and updates). */
async function lockVehicle(
  tx: DatabaseTransaction,
  id: string,
): Promise<{ id: string; status: VehicleStatus }> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: VehicleStatus }>>`
    SELECT "id", "status" FROM "vehicle" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw FleetErrors.vehicleNotFound();
  return row;
}

async function assertCountryExists(tx: DatabaseTransaction, countryId: string): Promise<void> {
  const country = await tx.country.findUnique({ where: { id: countryId }, select: { id: true } });
  if (!country) throw FleetErrors.countryNotFound();
}

function textOf(value: unknown, key: string): string | null {
  if (value && typeof value === 'object' && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : null;
  }
  return null;
}

/** Business authority for the vehicle registry and lifecycle. */
@Injectable()
export class FleetService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listVehicles(query: ListQuery) {
    const rows = await this.database.client.vehicle.findMany({
      take: query.limit + 1,
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { id: 'desc' },
      include: vehicleInclude,
    });
    const items = rows.slice(0, query.limit).map(vehicleView);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** Vehicle with its status history, read from the audit trail (no actor). */
  async vehicle(id: string) {
    const vehicle = await this.database.client.vehicle.findUnique({
      where: { id },
      include: vehicleInclude,
    });
    if (!vehicle) throw FleetErrors.vehicleNotFound();
    const events = await this.database.client.auditEvent.findMany({
      where: { resourceType: 'vehicle', resourceId: id, action: STATUS_CHANGED },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: { occurredAt: true, before: true, after: true, metadata: true },
    });
    const statusHistory: VehicleStatusHistoryEntry[] = events.map((event) => ({
      occurredAt: event.occurredAt,
      from: textOf(event.before, 'status'),
      to: textOf(event.after, 'status'),
      reason: textOf(event.metadata, 'reason'),
    }));
    return { ...vehicleView(vehicle), statusHistory };
  }

  /**
   * UI-PUBLIC-2: the active vehicles as the public website shows them —
   * name, code, make, year, seats of the configured seat map and on-board
   * equipment. Never the VIN, the registration or the history.
   */
  async publicFleet() {
    const vehicles = await this.database.client.vehicle.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
      take: 50,
      select: {
        code: true,
        name: true,
        manufacturer: true,
        model: true,
        modelYear: true,
        amenities: true,
        seatMapVersion: { select: { _count: { select: { cells: { where: { kind: 'SEAT' } } } } } },
      },
    });
    return {
      items: vehicles.map(({ seatMapVersion, ...vehicle }) => ({
        ...vehicle,
        seatCount: seatMapVersion?._count.cells ?? null,
      })),
    };
  }

  createVehicle(input: VehicleCreate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const plate = input.registrationPlate ?? null;
        const countryId = input.registrationCountryId ?? null;
        if ((plate === null) !== (countryId === null)) throw FleetErrors.registrationIncomplete();
        if (countryId) await assertCountryExists(tx, countryId);
        const vehicle = await tx.vehicle.create({
          data: {
            code: input.code,
            name: input.name ?? null,
            vin: input.vin ?? null,
            registrationPlate: plate,
            registrationCountryId: countryId,
            manufacturer: input.manufacturer,
            model: input.model,
            modelYear: input.modelYear ?? null,
            amenities: input.amenities ?? [],
          },
          include: vehicleInclude,
        });
        await this.audit.record(
          {
            actor,
            action: 'VEHICLE_CREATED',
            resourceType: 'vehicle',
            resourceId: vehicle.id,
            after: vehicle,
          },
          tx,
        );
        return vehicleView(vehicle);
      }),
    );
  }

  /** Administrative data only: status and retiredAt are not accepted here. */
  updateVehicle(id: string, input: VehicleUpdate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const locked = await lockVehicle(tx, id);
        if (locked.status === 'RETIRED') throw FleetErrors.vehicleRetired();
        const before = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          include: vehicleInclude,
        });
        const plate =
          input.registrationPlate === undefined
            ? before.registrationPlate
            : input.registrationPlate;
        const countryId =
          input.registrationCountryId === undefined
            ? before.registrationCountryId
            : input.registrationCountryId;
        if ((plate === null) !== (countryId === null)) throw FleetErrors.registrationIncomplete();
        if (input.registrationCountryId) await assertCountryExists(tx, input.registrationCountryId);

        const after = await tx.vehicle.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.vin !== undefined ? { vin: input.vin } : {}),
            ...(input.registrationPlate !== undefined
              ? { registrationPlate: input.registrationPlate }
              : {}),
            ...(input.registrationCountryId !== undefined
              ? { registrationCountryId: input.registrationCountryId }
              : {}),
            ...(input.manufacturer !== undefined ? { manufacturer: input.manufacturer } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.modelYear !== undefined ? { modelYear: input.modelYear } : {}),
            ...(input.amenities !== undefined ? { amenities: input.amenities } : {}),
          },
          include: vehicleInclude,
        });
        await this.audit.record(
          {
            actor,
            action: 'VEHICLE_UPDATED',
            resourceType: 'vehicle',
            resourceId: id,
            before,
            after,
          },
          tx,
        );
        return vehicleView(after);
      }),
    );
  }

  /**
   * Lifecycle transition: lock the row, re-read the status, validate the
   * transition, update, audit — one transaction. A failed audit insert rolls
   * the status change back.
   */
  changeStatus(id: string, input: VehicleStatusChange, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const locked = await lockVehicle(tx, id);
        if (input.expectedStatus && input.expectedStatus !== locked.status) {
          throw FleetErrors.statusConflict();
        }
        if (!isAllowedVehicleTransition(locked.status, input.status)) {
          throw FleetErrors.invalidTransition();
        }
        const now = new Date();
        const after = await tx.vehicle.update({
          where: { id },
          data: {
            status: input.status,
            statusChangedAt: now,
            retiredAt: input.status === 'RETIRED' ? now : null,
          },
          include: vehicleInclude,
        });
        await this.audit.record(
          {
            actor,
            action: STATUS_CHANGED,
            resourceType: 'vehicle',
            resourceId: id,
            before: { status: locked.status },
            after: { status: after.status, retiredAt: after.retiredAt },
            metadata: { reason: input.reason },
          },
          tx,
        );
        return vehicleView(after);
      }),
    );
  }

  /**
   * Assign, replace or remove the seat map currently configured on a vehicle.
   * A new assignment needs a currently PUBLISHED version of an active seat
   * map. Existing trips keep their own historical seat map.
   * Lock order: vehicle FOR UPDATE, then seat_map / seat_map_version FOR SHARE.
   */
  assignSeatMap(id: string, input: VehicleSeatMap, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const locked = await lockVehicle(tx, id);
        if (locked.status === 'RETIRED') throw FleetErrors.vehicleRetired();
        const current = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: {
            seatMapVersionId: true,
            seatMapVersion: { select: { version: true, seatMap: { select: { code: true } } } },
          },
        });
        if (
          input.expectedSeatMapVersionId !== undefined &&
          input.expectedSeatMapVersionId !== current.seatMapVersionId
        ) {
          throw FleetErrors.seatMapConflict();
        }
        if (input.seatMapVersionId !== current.seatMapVersionId) {
          const next = input.seatMapVersionId
            ? await lockAssignableSeatMapVersion(tx, input.seatMapVersionId)
            : null;
          await tx.vehicle.update({
            where: { id },
            data: { seatMapVersionId: next?.id ?? null },
          });
          await this.audit.record(
            {
              actor,
              action: 'VEHICLE_SEAT_MAP_CHANGED',
              resourceType: 'vehicle',
              resourceId: id,
              before: {
                seatMapVersionId: current.seatMapVersionId,
                seatMap: seatMapLabel(
                  current.seatMapVersion?.seatMap.code ?? null,
                  current.seatMapVersion?.version ?? null,
                ),
              },
              after: {
                seatMapVersionId: next?.id ?? null,
                seatMap: next ? seatMapLabel(next.seatMapCode, next.version) : null,
              },
            },
            tx,
          );
        }
        return vehicleView(
          await tx.vehicle.findUniqueOrThrow({ where: { id }, include: vehicleInclude }),
        );
      }),
    );
  }
}
