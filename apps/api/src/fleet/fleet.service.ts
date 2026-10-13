import { Prisma, type DatabaseTransaction, type VehicleStatus } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  vehicleCreateSchema,
  vehicleListQuerySchema,
  vehicleStatusSchema,
  vehicleUpdateSchema,
} from './fleet.dto.js';
import { FleetErrors } from './fleet.errors.js';
import { isAllowedVehicleTransition } from './vehicle-lifecycle.js';

type ListQuery = z.infer<typeof vehicleListQuerySchema>;
type VehicleCreate = z.infer<typeof vehicleCreateSchema>;
type VehicleUpdate = z.infer<typeof vehicleUpdateSchema>;
type VehicleStatusChange = z.infer<typeof vehicleStatusSchema>;

const STATUS_CHANGED = 'VEHICLE_STATUS_CHANGED';

const vehicleInclude = {
  registrationCountry: { select: { id: true, iso2: true, iso3: true, name: true, active: true } },
} as const;

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
    const items = rows.slice(0, query.limit);
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
    return { ...vehicle, statusHistory };
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
            vin: input.vin ?? null,
            registrationPlate: plate,
            registrationCountryId: countryId,
            manufacturer: input.manufacturer,
            model: input.model,
            modelYear: input.modelYear ?? null,
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
        return vehicle;
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
        return after;
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
        return after;
      }),
    );
  }
}
