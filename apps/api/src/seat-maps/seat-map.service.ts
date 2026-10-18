import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { Actor } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { checkCells, seatCountOf } from './seat-map-cells.js';
import type {
  seatMapCellsSchema,
  seatMapCreateSchema,
  seatMapListQuerySchema,
  seatMapUpdateSchema,
} from './seat-map.dto.js';
import { SeatMapErrors } from './seat-map.errors.js';

type ListQuery = z.infer<typeof seatMapListQuerySchema>;
type SeatMapCreate = z.infer<typeof seatMapCreateSchema>;
type SeatMapUpdate = z.infer<typeof seatMapUpdateSchema>;
type SeatMapCells = z.infer<typeof seatMapCellsSchema>;

const versionSummary = {
  id: true,
  seatMapId: true,
  version: true,
  status: true,
  publishedAt: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { cells: { where: { kind: 'SEAT' } } } },
} as const;

const cellSelect = {
  id: true,
  deck: true,
  row: true,
  column: true,
  kind: true,
  seatLabel: true,
} as const;

function summaryView<T extends { _count: { cells: number } }>(version: T) {
  const { _count, ...rest } = version;
  return { ...rest, seatCount: _count.cells };
}

/** Convert expected database failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw SeatMapErrors.codeConflict();
    if (error.code === 'P2025') throw SeatMapErrors.seatMapNotFound();
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

/** Lock order for catalogue writes: seat_map FOR UPDATE, then the version. */
async function lockSeatMap(tx: DatabaseTransaction, id: string): Promise<{ active: boolean }> {
  const rows = await tx.$queryRaw<Array<{ active: boolean }>>`
    SELECT "active" FROM "seat_map" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw SeatMapErrors.seatMapNotFound();
  return row;
}

async function lockVersion(
  tx: DatabaseTransaction,
  seatMapId: string,
  versionId: string,
): Promise<{ status: string; version: number }> {
  const rows = await tx.$queryRaw<Array<{ status: string; version: number }>>`
    SELECT "status", "version" FROM "seat_map_version"
    WHERE "id" = ${versionId}::uuid AND "seat_map_id" = ${seatMapId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw SeatMapErrors.versionNotFound();
  return row;
}

/** Business authority for seat maps and their versioned layouts. */
@Injectable()
export class SeatMapService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listSeatMaps(query: ListQuery) {
    const rows = await this.database.client.seatMap.findMany({
      take: query.limit + 1,
      where: {
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(query.active ? { active: query.active === 'true' } : {}),
      },
      orderBy: { id: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, select: versionSummary } },
    });
    const items = rows.slice(0, query.limit).map((map) => ({
      ...map,
      versions: map.versions.map(summaryView),
    }));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** Seat map with every version, its cells, capacity and current usage. */
  async seatMap(id: string) {
    const map = await this.database.client.seatMap.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          select: {
            ...versionSummary,
            cells: {
              orderBy: [{ deck: 'asc' }, { row: 'asc' }, { column: 'asc' }],
              select: cellSelect,
            },
            _count: {
              select: { cells: { where: { kind: 'SEAT' } }, vehicles: true, trips: true },
            },
          },
        },
      },
    });
    if (!map) throw SeatMapErrors.seatMapNotFound();
    return {
      ...map,
      versions: map.versions.map(({ _count, ...version }) => ({
        ...version,
        seatCount: _count.cells,
        vehicleCount: _count.vehicles,
        tripCount: _count.trips,
      })),
    };
  }

  async createSeatMap(input: SeatMapCreate, actor: Actor) {
    const id = await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const map = await tx.seatMap.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'SEAT_MAP_CREATED',
            resourceType: 'seat_map',
            resourceId: map.id,
            after: map,
          },
          tx,
        );
        return map.id;
      }),
    );
    return this.seatMap(id);
  }

  async updateSeatMap(id: string, input: SeatMapUpdate, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockSeatMap(tx, id);
        const before = await tx.seatMap.findUniqueOrThrow({ where: { id } });
        const after = await tx.seatMap.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'SEAT_MAP_UPDATED',
            resourceType: 'seat_map',
            resourceId: id,
            before,
            after,
          },
          tx,
        );
      }),
    );
    return this.seatMap(id);
  }

  async createVersion(seatMapId: string, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockSeatMap(tx, seatMapId);
        if (await tx.seatMapVersion.findFirst({ where: { seatMapId, status: 'DRAFT' } })) {
          throw SeatMapErrors.draftAlreadyExists();
        }
        const latest = await tx.seatMapVersion.findFirst({
          where: { seatMapId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = await tx.seatMapVersion.create({
          data: { seatMapId, version: (latest?.version ?? 0) + 1 },
        });
        await this.audit.record(
          {
            actor,
            action: 'SEAT_MAP_VERSION_CREATED',
            resourceType: 'seat_map_version',
            resourceId: version.id,
            after: version,
          },
          tx,
        );
      }),
    );
    return this.seatMap(seatMapId);
  }

  /** Atomic replacement of the complete DRAFT layout. */
  async replaceCells(seatMapId: string, versionId: string, input: SeatMapCells, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockSeatMap(tx, seatMapId);
        const version = await lockVersion(tx, seatMapId, versionId);
        if (version.status !== 'DRAFT') throw SeatMapErrors.versionNotDraft();
        const check = checkCells(input.cells);
        if (!check.ok) throw SeatMapErrors.cellsInvalid(check.message);

        const before = await tx.seatMapCell.findMany({
          where: { seatMapVersionId: versionId },
          orderBy: [{ deck: 'asc' }, { row: 'asc' }, { column: 'asc' }],
          select: { deck: true, row: true, column: true, kind: true, seatLabel: true },
        });
        await tx.seatMapCell.deleteMany({ where: { seatMapVersionId: versionId } });
        if (check.cells.length > 0) {
          await tx.seatMapCell.createMany({
            data: check.cells.map((cell) => ({ ...cell, seatMapVersionId: versionId })),
          });
        }
        await this.audit.record(
          {
            actor,
            action: 'SEAT_MAP_CELLS_REPLACED',
            resourceType: 'seat_map_version',
            resourceId: versionId,
            before: { seatCount: seatCountOf(before), cells: before },
            after: { seatCount: seatCountOf(check.cells), cells: check.cells },
          },
          tx,
        );
      }),
    );
    return this.seatMap(seatMapId);
  }

  /**
   * DRAFT -> PUBLISHED, retiring the current PUBLISHED version in the same
   * transaction. Requires an active seat map and at least one SEAT.
   */
  async publish(seatMapId: string, versionId: string, actor: Actor) {
    await mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const map = await lockSeatMap(tx, seatMapId);
        const version = await lockVersion(tx, seatMapId, versionId);
        if (version.status !== 'DRAFT') throw SeatMapErrors.versionNotDraft();
        if (!map.active) throw SeatMapErrors.notPublishable('Ce plan de sièges est désactivé.');
        const cells = await tx.seatMapCell.findMany({
          where: { seatMapVersionId: versionId },
          select: { deck: true, row: true, column: true, kind: true, seatLabel: true },
        });
        const check = checkCells(cells);
        if (!check.ok) throw SeatMapErrors.notPublishable(check.message);
        const seatCount = seatCountOf(cells);
        if (seatCount < 1) {
          throw SeatMapErrors.notPublishable('Une version publiée doit compter au moins un siège.');
        }

        const now = new Date();
        const previous = await tx.seatMapVersion.findFirst({
          where: { seatMapId, status: 'PUBLISHED' },
        });
        if (previous) {
          const retired = await tx.seatMapVersion.updateMany({
            where: { id: previous.id, status: 'PUBLISHED' },
            data: { status: 'RETIRED', retiredAt: now },
          });
          if (retired.count !== 1) throw SeatMapErrors.versionNotDraft();
          await this.audit.record(
            {
              actor,
              action: 'SEAT_MAP_VERSION_RETIRED',
              resourceType: 'seat_map_version',
              resourceId: previous.id,
              before: { status: 'PUBLISHED', version: previous.version },
              after: { status: 'RETIRED', version: previous.version, retiredAt: now },
            },
            tx,
          );
        }
        const published = await tx.seatMapVersion.updateMany({
          where: { id: versionId, seatMapId, status: 'DRAFT' },
          data: { status: 'PUBLISHED', publishedAt: now },
        });
        if (published.count !== 1) throw SeatMapErrors.versionNotDraft();
        await this.audit.record(
          {
            actor,
            action: 'SEAT_MAP_VERSION_PUBLISHED',
            resourceType: 'seat_map_version',
            resourceId: versionId,
            before: { status: 'DRAFT', version: version.version },
            after: { status: 'PUBLISHED', version: version.version, publishedAt: now, seatCount },
          },
          tx,
        );
      }),
    );
    return this.seatMap(seatMapId);
  }
}
