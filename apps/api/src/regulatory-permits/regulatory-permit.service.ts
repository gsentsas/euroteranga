import {
  Prisma,
  RegulatoryPermitScopeType,
  type DatabaseTransaction,
  type RegulatoryPermitStatus,
} from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  PermitCreateInput,
  PermitListQuery,
  PermitScopeInput,
  PermitUpdateInput,
} from './regulatory-permit.dto.js';
import { RegulatoryPermitErrors } from './regulatory-permit.errors.js';
import {
  dateFromIsoDay,
  normalizePermitReference,
  withFreshPermitReference,
} from './regulatory-permit-rules.js';
import {
  permitAuditSnapshot,
  permitDetailView,
  permitSelect,
  permitSummaryView,
  type PermitHistoryEntry,
} from './regulatory-permit-views.js';

type Db = DatabaseTransaction;

const MUTATION_ACTIONS = [
  'REGULATORY_PERMIT_CREATED',
  'REGULATORY_PERMIT_UPDATED',
  'REGULATORY_PERMIT_ACTIVATED',
  'REGULATORY_PERMIT_REVOKED',
] as const;

interface LockedPermit {
  id: string;
  status: RegulatoryPermitStatus;
  revision: number;
}

interface ResolvedScope {
  scopeType: RegulatoryPermitScopeType;
  scopeCountryId: string | null;
  vehicleId: string | null;
  routeVersionId: string | null;
  tripId: string | null;
}

function referenceCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const metadata = JSON.stringify(error.meta ?? {});
  return metadata.includes('regulatory_permit_reference_key') || metadata.includes('["reference"]');
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw RegulatoryPermitErrors.duplicate();
    if (error.code === 'P2003') throw RegulatoryPermitErrors.scopeNotFound();
    if (error.code === 'P2025') throw RegulatoryPermitErrors.notFound();
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

async function databaseDay(tx: Db): Promise<string> {
  const [clock] = await tx.$queryRaw<Array<{ today: string }>>`
    SELECT CURRENT_DATE::text AS "today"
  `;
  if (!clock) throw new Error('database clock unavailable');
  return clock.today;
}

async function lockPermit(tx: Db, reference: string): Promise<LockedPermit> {
  const [row] = await tx.$queryRaw<LockedPermit[]>`
    SELECT "id", "status"::text AS "status", "revision"
    FROM "regulatory_permit"
    WHERE "reference" = ${reference}
    FOR UPDATE
  `;
  if (!row) throw RegulatoryPermitErrors.notFound();
  return row;
}

function assertRevision(locked: LockedPermit, expected: number): void {
  if (locked.revision !== expected) throw RegulatoryPermitErrors.revisionConflict();
}

async function countryId(tx: Db, iso2: string, scope: boolean): Promise<string> {
  const country = await tx.country.findUnique({ where: { iso2 }, select: { id: true } });
  if (!country) {
    if (scope) throw RegulatoryPermitErrors.scopeNotFound();
    throw RegulatoryPermitErrors.countryNotFound();
  }
  return country.id;
}

async function resolveScope(tx: Db, scope: PermitScopeInput): Promise<ResolvedScope> {
  const empty = { scopeCountryId: null, vehicleId: null, routeVersionId: null, tripId: null };
  switch (scope.type) {
    case 'OPERATOR':
      return { scopeType: RegulatoryPermitScopeType.OPERATOR, ...empty };
    case 'COUNTRY':
      return {
        scopeType: RegulatoryPermitScopeType.COUNTRY,
        ...empty,
        scopeCountryId: await countryId(tx, scope.countryIso2, true),
      };
    case 'VEHICLE': {
      const vehicle = await tx.vehicle.findUnique({
        where: { code: scope.vehicleCode },
        select: { id: true },
      });
      if (!vehicle) throw RegulatoryPermitErrors.scopeNotFound();
      return { scopeType: RegulatoryPermitScopeType.VEHICLE, ...empty, vehicleId: vehicle.id };
    }
    case 'ROUTE_VERSION': {
      const version = await tx.routeVersion.findFirst({
        where: { version: scope.routeVersion, route: { code: scope.routeCode } },
        select: { id: true },
      });
      if (!version) throw RegulatoryPermitErrors.scopeNotFound();
      return {
        scopeType: RegulatoryPermitScopeType.ROUTE_VERSION,
        ...empty,
        routeVersionId: version.id,
      };
    }
    case 'TRIP': {
      const trip = await tx.trip.findUnique({
        where: { reference: scope.tripReference },
        select: { id: true },
      });
      if (!trip) throw RegulatoryPermitErrors.scopeNotFound();
      return { scopeType: RegulatoryPermitScopeType.TRIP, ...empty, tripId: trip.id };
    }
  }
}

function assertDates(validFrom: string, validUntil: string): void {
  if (validUntil < validFrom) throw RegulatoryPermitErrors.invalidDates();
}

function assertSourceDate(sourceCheckedOn: string | null | undefined, today: string): void {
  if (sourceCheckedOn && sourceCheckedOn > today) {
    throw RegulatoryPermitErrors.sourceCheckFuture();
  }
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function historyEntry(event: {
  action: string;
  occurredAt: Date;
  after: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
}): PermitHistoryEntry {
  const after = jsonRecord(event.after);
  const metadata = jsonRecord(event.metadata);
  return {
    action: event.action,
    occurredAt: event.occurredAt,
    status: typeof after.status === 'string' ? after.status : null,
    revision: typeof after.revision === 'number' ? after.revision : null,
    reason: typeof metadata.reason === 'string' ? metadata.reason : null,
  };
}

async function permitHistory(tx: Db, permitId: string): Promise<PermitHistoryEntry[]> {
  const events = await tx.auditEvent.findMany({
    where: {
      resourceType: 'regulatory_permit',
      resourceId: permitId,
      action: { in: [...MUTATION_ACTIONS] },
    },
    orderBy: { occurredAt: 'desc' },
    take: 50,
    select: { action: true, occurredAt: true, after: true, metadata: true },
  });
  return events.map(historyEntry);
}

/** Business authority for generic operational permits, never trip readiness. */
@Injectable()
export class RegulatoryPermitService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthPrincipal, query: PermitListQuery) {
    return this.database.client.$transaction(async (tx) => {
      const today = await databaseDay(tx);
      let cursorId: string | undefined;
      if (query.cursor) {
        const cursor = await tx.regulatoryPermit.findUnique({
          where: { reference: query.cursor },
          select: { id: true },
        });
        if (!cursor) throw RegulatoryPermitErrors.notFound();
        cursorId = cursor.id;
      }
      const day = dateFromIsoDay(today);
      const validityWhere: Prisma.RegulatoryPermitWhereInput | undefined = query.validityState
        ? query.validityState === 'DRAFT'
          ? { status: 'DRAFT' }
          : query.validityState === 'REVOKED'
            ? { status: 'REVOKED' }
            : query.validityState === 'NOT_YET_VALID'
              ? { status: 'ACTIVE', validFrom: { gt: day } }
              : query.validityState === 'EXPIRED'
                ? { status: 'ACTIVE', validUntil: { lt: day } }
                : { status: 'ACTIVE', validFrom: { lte: day }, validUntil: { gte: day } }
        : undefined;
      const where: Prisma.RegulatoryPermitWhereInput = {
        ...(cursorId ? { id: { lt: cursorId } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.scopeType ? { scopeType: query.scopeType } : {}),
        ...(query.permitType ? { permitType: query.permitType } : {}),
        ...(query.reference ? { reference: query.reference } : {}),
        ...(query.vehicleCode ? { vehicle: { code: query.vehicleCode } } : {}),
        ...(query.tripReference ? { trip: { reference: query.tripReference } } : {}),
        ...(query.routeCode
          ? {
              routeVersion: {
                route: { code: query.routeCode },
                ...(query.routeVersion ? { version: query.routeVersion } : {}),
              },
            }
          : {}),
        ...(query.country
          ? {
              OR: [
                { jurisdictionCountry: { iso2: query.country } },
                { scopeCountry: { iso2: query.country } },
              ],
            }
          : {}),
        ...(validityWhere ? { AND: [validityWhere] } : {}),
      };
      const rows = await tx.regulatoryPermit.findMany({
        where,
        take: query.limit + 1,
        orderBy: { id: 'desc' },
        select: permitSelect,
      });
      const page = rows.slice(0, query.limit);
      await this.audit.record(
        {
          actor,
          action: 'REGULATORY_PERMIT_ACCESSED',
          resourceType: 'regulatory_permit',
          metadata: {
            access: 'LIST',
            filters: {
              status: query.status ?? null,
              validityState: query.validityState ?? null,
              scopeType: query.scopeType ?? null,
              permitType: query.permitType ?? null,
              country: query.country ?? null,
              vehicleCode: query.vehicleCode ?? null,
              routeCode: query.routeCode ?? null,
              routeVersion: query.routeVersion ?? null,
              tripReference: query.tripReference ?? null,
              reference: query.reference ?? null,
            },
            references: page.map((row) => row.reference),
          },
        },
        tx,
      );
      return {
        items: page.map((row) => permitSummaryView(row, today)),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.reference ?? null) : null,
      };
    });
  }

  async detail(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizePermitReference(rawReference);
    if (!reference) throw RegulatoryPermitErrors.notFound();
    return this.database.client.$transaction(async (tx) => {
      const today = await databaseDay(tx);
      const row = await tx.regulatoryPermit.findUnique({
        where: { reference },
        select: permitSelect,
      });
      if (!row) throw RegulatoryPermitErrors.notFound();
      const history = await permitHistory(tx, row.id);
      await this.audit.record(
        {
          actor,
          action: 'REGULATORY_PERMIT_ACCESSED',
          resourceType: 'regulatory_permit',
          resourceId: row.id,
          metadata: { access: 'DETAIL', permitReference: row.reference },
        },
        tx,
      );
      return permitDetailView(row, today, history);
    });
  }

  create(input: PermitCreateInput, actor: AuthPrincipal) {
    assertDates(input.validFrom, input.validUntil);
    return mutation(() =>
      withFreshPermitReference(
        (reference) =>
          this.database.client.$transaction(async (tx) => {
            const today = await databaseDay(tx);
            assertSourceDate(input.sourceCheckedOn, today);
            const scope = await resolveScope(tx, input.scope);
            const jurisdictionCountryId = input.jurisdictionCountryIso2
              ? await countryId(tx, input.jurisdictionCountryIso2, false)
              : null;
            const row = await tx.regulatoryPermit.create({
              data: {
                reference,
                permitType: input.permitType,
                title: input.title,
                issuingAuthority: input.issuingAuthority,
                authorityReference: input.authorityReference ?? null,
                jurisdictionCountryId,
                validFrom: dateFromIsoDay(input.validFrom),
                validUntil: dateFromIsoDay(input.validUntil),
                sourceUrl: input.sourceUrl ?? null,
                sourceCheckedOn: input.sourceCheckedOn
                  ? dateFromIsoDay(input.sourceCheckedOn)
                  : null,
                notes: input.notes ?? null,
                createdByIdentityId: actor.identityId,
                updatedByIdentityId: actor.identityId,
                ...scope,
              },
              select: permitSelect,
            });
            const snapshot = permitAuditSnapshot(row, today);
            await this.audit.record(
              {
                actor,
                action: 'REGULATORY_PERMIT_CREATED',
                resourceType: 'regulatory_permit',
                resourceId: row.id,
                after: snapshot,
              },
              tx,
            );
            return permitDetailView(row, today, await permitHistory(tx, row.id));
          }),
        referenceCollision,
      ),
    );
  }

  update(rawReference: string, input: PermitUpdateInput, actor: AuthPrincipal) {
    const reference = normalizePermitReference(rawReference);
    if (!reference) throw RegulatoryPermitErrors.notFound();
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const locked = await lockPermit(tx, reference);
        assertRevision(locked, input.expectedRevision);
        if (locked.status !== 'DRAFT') throw RegulatoryPermitErrors.notDraft();
        const before = await tx.regulatoryPermit.findUniqueOrThrow({
          where: { id: locked.id },
          select: permitSelect,
        });
        const validFrom = input.validFrom ?? before.validFrom.toISOString().slice(0, 10);
        const validUntil = input.validUntil ?? before.validUntil.toISOString().slice(0, 10);
        assertDates(validFrom, validUntil);
        const today = await databaseDay(tx);
        assertSourceDate(input.sourceCheckedOn, today);
        const scope = input.scope ? await resolveScope(tx, input.scope) : undefined;
        const jurisdictionCountryId =
          input.jurisdictionCountryIso2 === undefined
            ? undefined
            : input.jurisdictionCountryIso2 === null
              ? null
              : await countryId(tx, input.jurisdictionCountryIso2, false);
        const after = await tx.regulatoryPermit.update({
          where: { id: locked.id },
          data: {
            ...(input.permitType !== undefined ? { permitType: input.permitType } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.issuingAuthority !== undefined
              ? { issuingAuthority: input.issuingAuthority }
              : {}),
            ...(input.authorityReference !== undefined
              ? { authorityReference: input.authorityReference }
              : {}),
            ...(jurisdictionCountryId !== undefined ? { jurisdictionCountryId } : {}),
            ...(input.validFrom !== undefined
              ? { validFrom: dateFromIsoDay(input.validFrom) }
              : {}),
            ...(input.validUntil !== undefined
              ? { validUntil: dateFromIsoDay(input.validUntil) }
              : {}),
            ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
            ...(input.sourceCheckedOn !== undefined
              ? {
                  sourceCheckedOn: input.sourceCheckedOn
                    ? dateFromIsoDay(input.sourceCheckedOn)
                    : null,
                }
              : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(scope ?? {}),
            revision: { increment: 1 },
            updatedByIdentityId: actor.identityId,
          },
          select: permitSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'REGULATORY_PERMIT_UPDATED',
            resourceType: 'regulatory_permit',
            resourceId: after.id,
            before: permitAuditSnapshot(before, today),
            after: permitAuditSnapshot(after, today),
          },
          tx,
        );
        return permitDetailView(after, today, await permitHistory(tx, after.id));
      }),
    );
  }

  activate(rawReference: string, expectedRevision: number, actor: AuthPrincipal) {
    return this.transition(rawReference, expectedRevision, 'ACTIVE', actor);
  }

  revoke(rawReference: string, expectedRevision: number, reason: string, actor: AuthPrincipal) {
    return this.transition(rawReference, expectedRevision, 'REVOKED', actor, reason);
  }

  private transition(
    rawReference: string,
    expectedRevision: number,
    target: 'ACTIVE' | 'REVOKED',
    actor: AuthPrincipal,
    reason?: string,
  ) {
    const reference = normalizePermitReference(rawReference);
    if (!reference) throw RegulatoryPermitErrors.notFound();
    return mutation(() =>
      this.database.client.$transaction(async (tx) => {
        const locked = await lockPermit(tx, reference);
        assertRevision(locked, expectedRevision);
        if (target === 'ACTIVE' && locked.status !== 'DRAFT') {
          throw RegulatoryPermitErrors.notDraft();
        }
        if (target === 'REVOKED' && locked.status !== 'ACTIVE') {
          throw RegulatoryPermitErrors.notActive();
        }
        const today = await databaseDay(tx);
        const before = await tx.regulatoryPermit.findUniqueOrThrow({
          where: { id: locked.id },
          select: permitSelect,
        });
        const after = await tx.regulatoryPermit.update({
          where: { id: locked.id },
          data: {
            status: target,
            revision: { increment: 1 },
            updatedByIdentityId: actor.identityId,
            ...(target === 'ACTIVE'
              ? { activatedByIdentityId: actor.identityId }
              : {
                  revokedByIdentityId: actor.identityId,
                  revocationReason: reason!,
                }),
          },
          select: permitSelect,
        });
        const action =
          target === 'ACTIVE' ? 'REGULATORY_PERMIT_ACTIVATED' : 'REGULATORY_PERMIT_REVOKED';
        await this.audit.record(
          {
            actor,
            action,
            resourceType: 'regulatory_permit',
            resourceId: after.id,
            before: permitAuditSnapshot(before, today),
            after: permitAuditSnapshot(after, today),
            ...(reason ? { metadata: { reason } } : {}),
          },
          tx,
        );
        return permitDetailView(after, today, await permitHistory(tx, after.id));
      }),
    );
  }
}
