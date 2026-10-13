import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  checkpointCreateSchema,
  checkpointUpdateSchema,
  countryCreateSchema,
  countryUpdateSchema,
  networkListQuerySchema,
  replaceWaypointsSchema,
  routeCreateSchema,
  routeUpdateSchema,
  stopCreateSchema,
  stopUpdateSchema,
} from './network.dto.js';
import { NetworkErrors } from './network.errors.js';

type ListQuery = z.infer<typeof networkListQuerySchema>;
type CountryCreate = z.infer<typeof countryCreateSchema>;
type CountryUpdate = z.infer<typeof countryUpdateSchema>;
type StopCreate = z.infer<typeof stopCreateSchema>;
type StopUpdate = z.infer<typeof stopUpdateSchema>;
type CheckpointCreate = z.infer<typeof checkpointCreateSchema>;
type CheckpointUpdate = z.infer<typeof checkpointUpdateSchema>;
type RouteCreate = z.infer<typeof routeCreateSchema>;
type RouteUpdate = z.infer<typeof routeUpdateSchema>;
type ReplaceWaypoints = z.infer<typeof replaceWaypointsSchema>;

interface LocatedRecord {
  latitude: unknown;
  longitude: unknown;
}

interface WaypointRecord {
  id: string;
  routeVersionId: string;
  sequence: number;
  stopId: string | null;
  checkpointId: string | null;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  stop: (LocatedRecord & { id: string; active: boolean; country: { active: boolean } }) | null;
  checkpoint:
    (LocatedRecord & { id: string; active: boolean; country: { active: boolean } }) | null;
}

const locationView = <T extends LocatedRecord>(record: T) => ({
  ...record,
  latitude: Number(record.latitude),
  longitude: Number(record.longitude),
});

const waypointView = (waypoint: WaypointRecord) => ({
  ...waypoint,
  kind: waypoint.stopId ? ('STOP' as const) : ('CHECKPOINT' as const),
  stop: waypoint.stop ? locationView(waypoint.stop) : null,
  checkpoint: waypoint.checkpoint ? locationView(waypoint.checkpoint) : null,
});

function pageOf<T extends { id: string }>(rows: T[], take: number) {
  const items = rows.slice(0, take);
  return {
    items,
    nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null,
  };
}

/** Convert expected database constraint failures to stable public errors. */
function translateDatabaseError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw NetworkErrors.duplicateIdentifier();
    if (error.code === 'P2003' || error.code === 'P2025') throw NetworkErrors.invalidReference();
    // PostgreSQL CHECK / exclusion constraints are surfaced by Prisma as P2004.
    if (error.code === 'P2004') throw NetworkErrors.invariantViolation();
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

async function lockRoute(tx: DatabaseTransaction, routeId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "route" WHERE "id" = ${routeId}::uuid FOR UPDATE
  `;
  if (rows.length !== 1) throw NetworkErrors.routeNotFound();
}

async function lockRouteVersion(
  tx: DatabaseTransaction,
  routeId: string,
  versionId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "route_version"
    WHERE "id" = ${versionId}::uuid AND "route_id" = ${routeId}::uuid
    FOR UPDATE
  `;
  if (rows.length !== 1) throw NetworkErrors.routeVersionNotFound();
}

const waypointInclude = {
  stop: { include: { country: true } },
  checkpoint: { include: { country: true } },
} as const;

/** Business authority for the versioned transport network. */
@Injectable()
export class NetworkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listCountries(query: ListQuery) {
    const rows = await this.database.client.country.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { where: { id: { lt: query.cursor } } } : {}),
      orderBy: { id: 'desc' },
    });
    return pageOf(rows, query.limit);
  }

  createCountry(input: CountryCreate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const country = await tx.country.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'COUNTRY_CREATED',
            resourceType: 'country',
            resourceId: country.id,
            after: country,
          },
          tx,
        );
        return country;
      }),
    );
  }

  updateCountry(id: string, input: CountryUpdate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const before = await tx.country.findUnique({ where: { id } });
        if (!before) throw NetworkErrors.countryNotFound();
        const after = await tx.country.update({
          where: { id },
          data: {
            ...(input.iso2 !== undefined ? { iso2: input.iso2 } : {}),
            ...(input.iso3 !== undefined ? { iso3: input.iso3 } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'COUNTRY_UPDATED',
            resourceType: 'country',
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

  async listStops(query: ListQuery) {
    const rows = await this.database.client.stop.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { where: { id: { lt: query.cursor } } } : {}),
      orderBy: { id: 'desc' },
      include: { country: true },
    });
    const page = pageOf(rows, query.limit);
    return { ...page, items: page.items.map(locationView) };
  }

  createStop(input: StopCreate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        if (
          !(await tx.country.findUnique({ where: { id: input.countryId }, select: { id: true } }))
        ) {
          throw NetworkErrors.countryNotFound();
        }
        const stop = await tx.stop.create({ data: input, include: { country: true } });
        const after = locationView(stop);
        await this.audit.record(
          { actor, action: 'STOP_CREATED', resourceType: 'stop', resourceId: stop.id, after },
          tx,
        );
        return after;
      }),
    );
  }

  updateStop(id: string, input: StopUpdate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const existing = await tx.stop.findUnique({ where: { id }, include: { country: true } });
        if (!existing) throw NetworkErrors.stopNotFound();
        if (
          input.countryId !== undefined &&
          !(await tx.country.findUnique({ where: { id: input.countryId }, select: { id: true } }))
        ) {
          throw NetworkErrors.countryNotFound();
        }
        const stop = await tx.stop.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.countryId !== undefined ? { countryId: input.countryId } : {}),
            ...(input.locality !== undefined ? { locality: input.locality } : {}),
            ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
            ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
          include: { country: true },
        });
        const before = locationView(existing);
        const after = locationView(stop);
        await this.audit.record(
          { actor, action: 'STOP_UPDATED', resourceType: 'stop', resourceId: id, before, after },
          tx,
        );
        return after;
      }),
    );
  }

  async listCheckpoints(query: ListQuery) {
    const rows = await this.database.client.checkpoint.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { where: { id: { lt: query.cursor } } } : {}),
      orderBy: { id: 'desc' },
      include: { country: true },
    });
    const page = pageOf(rows, query.limit);
    return { ...page, items: page.items.map(locationView) };
  }

  createCheckpoint(input: CheckpointCreate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        if (
          !(await tx.country.findUnique({ where: { id: input.countryId }, select: { id: true } }))
        ) {
          throw NetworkErrors.countryNotFound();
        }
        const checkpoint = await tx.checkpoint.create({ data: input, include: { country: true } });
        const after = locationView(checkpoint);
        await this.audit.record(
          {
            actor,
            action: 'CHECKPOINT_CREATED',
            resourceType: 'checkpoint',
            resourceId: checkpoint.id,
            after,
          },
          tx,
        );
        return after;
      }),
    );
  }

  updateCheckpoint(id: string, input: CheckpointUpdate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const existing = await tx.checkpoint.findUnique({
          where: { id },
          include: { country: true },
        });
        if (!existing) throw NetworkErrors.checkpointNotFound();
        if (
          input.countryId !== undefined &&
          !(await tx.country.findUnique({ where: { id: input.countryId }, select: { id: true } }))
        ) {
          throw NetworkErrors.countryNotFound();
        }
        const checkpoint = await tx.checkpoint.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.countryId !== undefined ? { countryId: input.countryId } : {}),
            ...(input.locality !== undefined ? { locality: input.locality } : {}),
            ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
            ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
          },
          include: { country: true },
        });
        const before = locationView(existing);
        const after = locationView(checkpoint);
        await this.audit.record(
          {
            actor,
            action: 'CHECKPOINT_UPDATED',
            resourceType: 'checkpoint',
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

  async listRoutes(query: ListQuery) {
    const rows = await this.database.client.route.findMany({
      take: query.limit + 1,
      ...(query.cursor ? { where: { id: { lt: query.cursor } } } : {}),
      orderBy: { id: 'desc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    return pageOf(rows, query.limit);
  }

  async route(id: string) {
    const route = await this.database.client.route.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          include: { waypoints: { orderBy: { sequence: 'asc' }, include: waypointInclude } },
        },
      },
    });
    if (!route) throw NetworkErrors.routeNotFound();
    return {
      ...route,
      versions: route.versions.map((version) => ({
        ...version,
        waypoints: version.waypoints.map(waypointView),
      })),
    };
  }

  createRoute(input: RouteCreate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const route = await tx.route.create({ data: input });
        await this.audit.record(
          {
            actor,
            action: 'ROUTE_CREATED',
            resourceType: 'route',
            resourceId: route.id,
            after: route,
          },
          tx,
        );
        return { ...route, versions: [] };
      }),
    );
  }

  updateRoute(id: string, input: RouteUpdate, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const before = await tx.route.findUnique({ where: { id } });
        if (!before) throw NetworkErrors.routeNotFound();
        const after = await tx.route.update({
          where: { id },
          data: {
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
          include: { versions: { orderBy: { version: 'desc' } } },
        });
        await this.audit.record(
          { actor, action: 'ROUTE_UPDATED', resourceType: 'route', resourceId: id, before, after },
          tx,
        );
        return after;
      }),
    );
  }

  createRouteVersion(routeId: string, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockRoute(tx, routeId);
        if (await tx.routeVersion.findFirst({ where: { routeId, status: 'DRAFT' } })) {
          throw NetworkErrors.draftAlreadyExists();
        }
        const latest = await tx.routeVersion.findFirst({
          where: { routeId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = await tx.routeVersion.create({
          data: { routeId, version: (latest?.version ?? 0) + 1, status: 'DRAFT' },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROUTE_VERSION_CREATED',
            resourceType: 'route_version',
            resourceId: version.id,
            after: version,
          },
          tx,
        );
        return { ...version, waypoints: [] };
      }),
    );
  }

  replaceWaypoints(
    routeId: string,
    versionId: string,
    input: ReplaceWaypoints,
    actor: AuthPrincipal,
  ) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        await lockRoute(tx, routeId);
        await lockRouteVersion(tx, routeId, versionId);
        const version = await tx.routeVersion.findUnique({
          where: { id: versionId },
          select: { status: true },
        });
        if (!version) throw NetworkErrors.routeVersionNotFound();
        if (version.status !== 'DRAFT') throw NetworkErrors.versionNotDraft();

        const stopIds = [
          ...new Set(
            input.waypoints.flatMap((waypoint) =>
              waypoint.kind === 'STOP' ? [waypoint.stopId] : [],
            ),
          ),
        ];
        const checkpointIds = [
          ...new Set(
            input.waypoints.flatMap((waypoint) =>
              waypoint.kind === 'CHECKPOINT' ? [waypoint.checkpointId] : [],
            ),
          ),
        ];
        const [stopCount, checkpointCount] = await Promise.all([
          tx.stop.count({ where: { id: { in: stopIds } } }),
          tx.checkpoint.count({ where: { id: { in: checkpointIds } } }),
        ]);
        if (stopCount !== stopIds.length || checkpointCount !== checkpointIds.length) {
          throw NetworkErrors.invalidReference();
        }

        const before = await tx.routeWaypoint.findMany({
          where: { routeVersionId: versionId },
          orderBy: { sequence: 'asc' },
          include: waypointInclude,
        });
        await tx.routeWaypoint.deleteMany({ where: { routeVersionId: versionId } });
        const data = input.waypoints.map((waypoint, index) =>
          waypoint.kind === 'STOP'
            ? {
                routeVersionId: versionId,
                sequence: index + 1,
                stopId: waypoint.stopId,
                boardingAllowed: waypoint.boardingAllowed,
                alightingAllowed: waypoint.alightingAllowed,
              }
            : {
                routeVersionId: versionId,
                sequence: index + 1,
                checkpointId: waypoint.checkpointId,
                boardingAllowed: false,
                alightingAllowed: false,
              },
        );
        if (data.length > 0) await tx.routeWaypoint.createMany({ data });
        const after = await tx.routeWaypoint.findMany({
          where: { routeVersionId: versionId },
          orderBy: { sequence: 'asc' },
          include: waypointInclude,
        });
        const result = after.map(waypointView);
        await this.audit.record(
          {
            actor,
            action: 'ROUTE_WAYPOINTS_REPLACED',
            resourceType: 'route_version',
            resourceId: versionId,
            before: before.map(waypointView),
            after: result,
          },
          tx,
        );
        return { routeVersionId: versionId, waypoints: result };
      }),
    );
  }

  publishRouteVersion(routeId: string, versionId: string, actor: AuthPrincipal) {
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        // All publication and waypoint replacement operations take locks in
        // this order, eliminating validation/write races and deadlocks.
        await lockRoute(tx, routeId);
        await lockRouteVersion(tx, routeId, versionId);
        const version = await tx.routeVersion.findUnique({
          where: { id: versionId },
          include: {
            waypoints: { orderBy: { sequence: 'asc' }, include: waypointInclude },
          },
        });
        if (!version) throw NetworkErrors.routeVersionNotFound();
        if (version.status !== 'DRAFT') throw NetworkErrors.versionNotDraft();

        const waypoints = version.waypoints;
        const contiguous = waypoints.every((waypoint, index) => waypoint.sequence === index + 1);
        const referencesValid = waypoints.every(
          (waypoint) => (waypoint.stop === null) !== (waypoint.checkpoint === null),
        );
        const referencesActive = waypoints.every((waypoint) => {
          if (waypoint.stop) return waypoint.stop.active && waypoint.stop.country.active;
          if (waypoint.checkpoint) {
            return waypoint.checkpoint.active && waypoint.checkpoint.country.active;
          }
          return false;
        });
        const endpointStops = Boolean(waypoints[0]?.stop && waypoints.at(-1)?.stop);
        const stopCount = waypoints.filter((waypoint) => waypoint.stop !== null).length;
        if (
          waypoints.length < 2 ||
          !contiguous ||
          !referencesValid ||
          !referencesActive ||
          !endpointStops ||
          stopCount < 2
        ) {
          throw NetworkErrors.versionNotPublishable();
        }

        const now = new Date();
        const previous = await tx.routeVersion.findFirst({
          where: { routeId, status: 'PUBLISHED' },
        });
        if (previous) {
          const retired = await tx.routeVersion.updateMany({
            where: { id: previous.id, status: 'PUBLISHED' },
            data: { status: 'RETIRED', retiredAt: now },
          });
          if (retired.count !== 1) throw NetworkErrors.publicationConflict();
          await this.audit.record(
            {
              actor,
              action: 'ROUTE_VERSION_RETIRED',
              resourceType: 'route_version',
              resourceId: previous.id,
              before: previous,
              after: { ...previous, status: 'RETIRED', retiredAt: now },
            },
            tx,
          );
        }

        const published = await tx.routeVersion.updateMany({
          where: { id: versionId, routeId, status: 'DRAFT' },
          data: { status: 'PUBLISHED', publishedAt: now, retiredAt: null },
        });
        if (published.count !== 1) throw NetworkErrors.publicationConflict();
        const after = await tx.routeVersion.findUniqueOrThrow({
          where: { id: versionId },
          include: {
            waypoints: { orderBy: { sequence: 'asc' }, include: waypointInclude },
          },
        });
        const result = { ...after, waypoints: after.waypoints.map(waypointView) };
        await this.audit.record(
          {
            actor,
            action: 'ROUTE_VERSION_PUBLISHED',
            resourceType: 'route_version',
            resourceId: versionId,
            before: { status: version.status, publishedAt: version.publishedAt },
            after: result,
          },
          tx,
        );
        return result;
      }),
    );
  }
}
