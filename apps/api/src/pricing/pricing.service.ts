import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { Actor } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { checkFares, type FareWaypoint } from './fare-entries.js';
import type {
  fareTableCreateSchema,
  fareTableFaresSchema,
  fareTableListQuerySchema,
  fareTableUpdateSchema,
} from './pricing.dto.js';
import { PricingErrors } from './pricing.errors.js';

type ListQuery = z.infer<typeof fareTableListQuerySchema>;
type FareTableCreate = z.infer<typeof fareTableCreateSchema>;
type FareTableUpdate = z.infer<typeof fareTableUpdateSchema>;
type FareTableFares = z.infer<typeof fareTableFaresSchema>;

const routeSummary = { select: { id: true, code: true, name: true } } as const;

const versionSummary = {
  id: true,
  fareTableId: true,
  routeVersionId: true,
  version: true,
  status: true,
  publishedAt: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
  routeVersion: { select: { id: true, version: true, status: true } },
  _count: { select: { entries: true } },
} as const;

const waypointSelect = {
  id: true,
  sequence: true,
  boardingAllowed: true,
  alightingAllowed: true,
  stop: { select: { id: true, code: true, name: true } },
  checkpoint: { select: { id: true, code: true, name: true } },
} as const;

function summaryView<T extends { _count: { entries: number } }>(version: T) {
  const { _count, ...rest } = version;
  return { ...rest, entryCount: _count.entries };
}

/** Convert expected database failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw PricingErrors.codeConflict();
    if (error.code === 'P2025') throw PricingErrors.fareTableNotFound();
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

/** Lock order for catalogue writes: fare_table FOR UPDATE, then the version. */
async function lockFareTable(
  tx: DatabaseTransaction,
  id: string,
): Promise<{ active: boolean; routeId: string }> {
  const rows = await tx.$queryRaw<Array<{ active: boolean; route_id: string }>>`
    SELECT "active", "route_id" FROM "fare_table" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw PricingErrors.fareTableNotFound();
  return { active: row.active, routeId: row.route_id };
}

async function lockVersion(
  tx: DatabaseTransaction,
  fareTableId: string,
  versionId: string,
): Promise<{ status: string; version: number; routeVersionId: string }> {
  const rows = await tx.$queryRaw<
    Array<{ status: string; version: number; route_version_id: string }>
  >`
    SELECT "status", "version", "route_version_id" FROM "fare_table_version"
    WHERE "id" = ${versionId}::uuid AND "fare_table_id" = ${fareTableId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw PricingErrors.versionNotFound();
  return { status: row.status, version: row.version, routeVersionId: row.route_version_id };
}

async function fareWaypoints(
  tx: DatabaseTransaction,
  routeVersionId: string,
): Promise<FareWaypoint[]> {
  const waypoints = await tx.routeWaypoint.findMany({
    where: { routeVersionId },
    orderBy: { sequence: 'asc' },
    select: waypointSelect,
  });
  return waypoints.map((waypoint) => ({
    id: waypoint.id,
    sequence: waypoint.sequence,
    isStop: waypoint.stop !== null,
    boardingAllowed: waypoint.boardingAllowed,
    alightingAllowed: waypoint.alightingAllowed,
    label: waypoint.stop?.code ?? waypoint.checkpoint?.code ?? `#${waypoint.sequence}`,
  }));
}

/** Business authority for versioned base fare tables. */
@Injectable()
export class PricingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listFareTables(query: ListQuery) {
    const rows = await this.database.client.fareTable.findMany({
      take: query.limit + 1,
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.active ? { active: query.active === 'true' } : {}),
        ...(query.routeId ? { routeId: query.routeId } : {}),
      },
      orderBy: { id: 'desc' },
      include: {
        route: routeSummary,
        versions: { orderBy: { version: 'desc' }, select: versionSummary },
      },
    });
    const items = rows.slice(0, query.limit).map((table) => ({
      ...table,
      versions: table.versions.map(summaryView),
    }));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** Fare table with its versions, route-version waypoints, fares and usage. */
  async fareTable(id: string) {
    const table = await this.database.client.fareTable.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            ...routeSummary.select,
            versions: {
              where: { publishedAt: { not: null } },
              orderBy: { version: 'desc' },
              select: { id: true, version: true, status: true, publishedAt: true },
            },
          },
        },
        versions: {
          orderBy: { version: 'desc' },
          select: {
            ...versionSummary,
            routeVersion: {
              select: {
                id: true,
                version: true,
                status: true,
                waypoints: { orderBy: { sequence: 'asc' }, select: waypointSelect },
              },
            },
            entries: {
              orderBy: [
                { originRouteWaypoint: { sequence: 'asc' } },
                { destinationRouteWaypoint: { sequence: 'asc' } },
              ],
              select: {
                id: true,
                originRouteWaypointId: true,
                destinationRouteWaypointId: true,
                amountMinor: true,
              },
            },
            _count: { select: { entries: true, trips: true } },
          },
        },
      },
    });
    if (!table) throw PricingErrors.fareTableNotFound();
    return {
      ...table,
      versions: table.versions.map(({ _count, ...version }) => ({
        ...version,
        entryCount: _count.entries,
        tripCount: _count.trips,
      })),
    };
  }

  async createFareTable(input: FareTableCreate, actor: Actor) {
    const id = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        if (!(await tx.route.findUnique({ where: { id: input.routeId }, select: { id: true } }))) {
          throw PricingErrors.routeNotFound();
        }
        const table = await tx.fareTable.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'FARE_TABLE_CREATED',
            resourceType: 'fare_table',
            resourceId: table.id,
            after: table,
          },
          tx,
        );
        return table.id;
      }),
    );
    return this.fareTable(id);
  }

  /** Name and active state only: route and currency are immutable. */
  async updateFareTable(id: string, input: FareTableUpdate, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockFareTable(tx, id);
        const before = await tx.fareTable.findUniqueOrThrow({ where: { id } });
        const after = await tx.fareTable.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'FARE_TABLE_UPDATED',
            resourceType: 'fare_table',
            resourceId: id,
            before,
            after,
          },
          tx,
        );
      }),
    );
    return this.fareTable(id);
  }

  async createVersion(fareTableId: string, routeVersionId: string, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const table = await lockFareTable(tx, fareTableId);
        if (await tx.fareTableVersion.findFirst({ where: { fareTableId, status: 'DRAFT' } })) {
          throw PricingErrors.draftAlreadyExists();
        }
        const routeVersion = await tx.routeVersion.findUnique({
          where: { id: routeVersionId },
          select: { routeId: true, publishedAt: true },
        });
        if (!routeVersion) throw PricingErrors.routeVersionNotFound();
        if (routeVersion.routeId !== table.routeId) throw PricingErrors.routeMismatch();
        if (routeVersion.publishedAt === null) throw PricingErrors.routeVersionNotPublished();
        const latest = await tx.fareTableVersion.findFirst({
          where: { fareTableId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = await tx.fareTableVersion.create({
          data: { fareTableId, routeVersionId, version: (latest?.version ?? 0) + 1 },
        });
        await this.audit.record(
          {
            actor,
            action: 'FARE_TABLE_VERSION_CREATED',
            resourceType: 'fare_table_version',
            resourceId: version.id,
            after: version,
          },
          tx,
        );
      }),
    );
    return this.fareTable(fareTableId);
  }

  /** Atomic replacement of the complete (possibly partial) DRAFT matrix. */
  async replaceFares(fareTableId: string, versionId: string, input: FareTableFares, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockFareTable(tx, fareTableId);
        const version = await lockVersion(tx, fareTableId, versionId);
        if (version.status !== 'DRAFT') throw PricingErrors.versionNotDraft();
        const check = checkFares(await fareWaypoints(tx, version.routeVersionId), input.fares);
        if (!check.ok) throw PricingErrors.entriesInvalid(check.message);

        const before = await tx.fareEntry.findMany({
          where: { fareTableVersionId: versionId },
          select: {
            originRouteWaypointId: true,
            destinationRouteWaypointId: true,
            amountMinor: true,
          },
        });
        await tx.fareEntry.deleteMany({ where: { fareTableVersionId: versionId } });
        if (check.fares.length > 0) {
          await tx.fareEntry.createMany({
            data: check.fares.map((fare) => ({ ...fare, fareTableVersionId: versionId })),
          });
        }
        await this.audit.record(
          {
            actor,
            action: 'FARE_ENTRIES_REPLACED',
            resourceType: 'fare_table_version',
            resourceId: versionId,
            before: { count: before.length, fares: before },
            after: { count: check.fares.length, fares: check.fares },
          },
          tx,
        );
      }),
    );
    return this.fareTable(fareTableId);
  }

  /**
   * DRAFT -> PUBLISHED, retiring the current PUBLISHED version in the same
   * transaction. Never locks trips: a concurrent trip assignment either
   * commits first (the retired version stays historical on the trip) or is
   * refused because the version is retired.
   */
  async publish(fareTableId: string, versionId: string, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const table = await lockFareTable(tx, fareTableId);
        const version = await lockVersion(tx, fareTableId, versionId);
        if (version.status !== 'DRAFT') throw PricingErrors.versionNotDraft();
        if (!table.active)
          throw PricingErrors.notPublishable('Cette grille tarifaire est désactivée.');
        const routeVersion = await tx.routeVersion.findUniqueOrThrow({
          where: { id: version.routeVersionId },
          select: { routeId: true, publishedAt: true },
        });
        if (routeVersion.routeId !== table.routeId) throw PricingErrors.routeMismatch();
        if (routeVersion.publishedAt === null) throw PricingErrors.routeVersionNotPublished();
        const fares = await tx.fareEntry.findMany({
          where: { fareTableVersionId: versionId },
          select: {
            originRouteWaypointId: true,
            destinationRouteWaypointId: true,
            amountMinor: true,
          },
        });
        if (fares.length < 1) {
          throw PricingErrors.notPublishable(
            'Une version publiée doit contenir au moins un tarif.',
          );
        }
        const check = checkFares(await fareWaypoints(tx, version.routeVersionId), fares);
        if (!check.ok) throw PricingErrors.notPublishable(check.message);

        const now = new Date();
        const previous = await tx.fareTableVersion.findFirst({
          where: { fareTableId, status: 'PUBLISHED' },
        });
        if (previous) {
          const retired = await tx.fareTableVersion.updateMany({
            where: { id: previous.id, status: 'PUBLISHED' },
            data: { status: 'RETIRED', retiredAt: now },
          });
          if (retired.count !== 1) throw PricingErrors.versionNotDraft();
          await this.audit.record(
            {
              actor,
              action: 'FARE_TABLE_VERSION_RETIRED',
              resourceType: 'fare_table_version',
              resourceId: previous.id,
              before: { status: 'PUBLISHED', version: previous.version },
              after: { status: 'RETIRED', version: previous.version, retiredAt: now },
            },
            tx,
          );
        }
        const published = await tx.fareTableVersion.updateMany({
          where: { id: versionId, fareTableId, status: 'DRAFT' },
          data: { status: 'PUBLISHED', publishedAt: now },
        });
        if (published.count !== 1) throw PricingErrors.versionNotDraft();
        await this.audit.record(
          {
            actor,
            action: 'FARE_TABLE_VERSION_PUBLISHED',
            resourceType: 'fare_table_version',
            resourceId: versionId,
            before: { status: 'DRAFT', version: version.version },
            after: {
              status: 'PUBLISHED',
              version: version.version,
              publishedAt: now,
              fareCount: fares.length,
            },
          },
          tx,
        );
      }),
    );
    return this.fareTable(fareTableId);
  }
}
