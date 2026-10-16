import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ManifestListQuery } from './manifest.dto.js';
import { ManifestErrors } from './manifest.errors.js';
import { currentManifestSnapshot } from './manifest-source.js';
import {
  canonicalManifestJson,
  manifestContentHash,
  MANIFEST_SCHEMA_VERSION,
  normalizeManifestReference,
  renderManifestCsv,
  withFreshManifestReference,
  type PassengerManifestSnapshot,
} from './manifest-rules.js';
import {
  manifestDetailView,
  manifestSelect,
  manifestSummaryView,
  type ManifestRow,
} from './manifest-views.js';

type Db = DatabaseTransaction;

function referenceCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('reference')
  );
}

function manifestDomainError(error: unknown): never {
  const message = String(error);
  if (message.includes('requires a scheduled trip')) throw ManifestErrors.tripNotScheduled();
  throw error;
}

function storedSnapshot(row: ManifestRow): PassengerManifestSnapshot {
  return row.snapshot as unknown as PassengerManifestSnapshot;
}

interface LockedTrip {
  id: string;
  status: string;
}

/**
 * PR-15 immutable manifests. Generation locks the Trip, captures only
 * checked-in passengers, inserts one contiguous version and writes its audit
 * event in the same transaction. Reads and exports are audited too.
 */
@Injectable()
export class ManifestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthPrincipal, query: ManifestListQuery) {
    return this.database.client.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({
        where: { reference: query.tripReference },
        select: { id: true, reference: true },
      });
      if (!trip) throw ManifestErrors.tripNotFound();
      const rows = await tx.passengerManifest.findMany({
        where: {
          tripId: trip.id,
          ...(query.cursor ? { version: { lt: query.cursor } } : {}),
        },
        take: query.limit + 1,
        orderBy: { version: 'desc' },
        select: manifestSelect,
      });
      const page = rows.slice(0, query.limit);
      await this.audit.record(
        {
          actor,
          action: 'PASSENGER_MANIFEST_ACCESSED',
          resourceType: 'passenger_manifest',
          resourceId: trip.id,
          metadata: {
            access: 'HISTORY',
            tripReference: trip.reference,
            resultCount: page.length,
          },
        },
        tx,
      );
      return {
        items: page.map(manifestSummaryView),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.version ?? null) : null,
      };
    });
  }

  async detail(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeManifestReference(rawReference);
    if (!reference) throw ManifestErrors.notFound();
    return this.database.client.$transaction(async (tx) => {
      const row = await tx.passengerManifest.findUnique({
        where: { reference },
        select: manifestSelect,
      });
      if (!row) throw ManifestErrors.notFound();
      await this.recordAccess(tx, actor, row, 'DETAIL');
      return manifestDetailView(row);
    });
  }

  async exportCsv(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeManifestReference(rawReference);
    if (!reference) throw ManifestErrors.notFound();
    return this.database.client.$transaction(async (tx) => {
      const row = await tx.passengerManifest.findUnique({
        where: { reference },
        select: manifestSelect,
      });
      if (!row) throw ManifestErrors.notFound();
      await this.audit.record(
        {
          actor,
          action: 'PASSENGER_MANIFEST_EXPORTED',
          resourceType: 'passenger_manifest',
          resourceId: row.id,
          metadata: this.auditMetadata(row),
        },
        tx,
      );
      const safeTrip = row.trip.reference.replaceAll(/[^A-Z0-9_-]/gu, '-');
      return {
        csv: renderManifestCsv({
          reference: row.reference,
          version: row.version,
          snapshot: storedSnapshot(row),
        }),
        filename: `passenger-manifest-${safeTrip}-v${row.version}.csv`,
      };
    });
  }

  async generate(actor: AuthPrincipal, rawTripReference: string) {
    const tripReference = rawTripReference.trim().toUpperCase();
    if (!tripReference || tripReference.length > 32) throw ManifestErrors.tripNotFound();
    try {
      return await withFreshManifestReference(
        (reference) =>
          this.database.client.$transaction(async (tx) => {
            const [locked] = await tx.$queryRaw<LockedTrip[]>`
              SELECT "id", "status"::text AS "status"
              FROM "trip"
              WHERE "reference" = ${tripReference}
              FOR UPDATE
            `;
            if (!locked) throw ManifestErrors.tripNotFound();
            if (locked.status !== 'SCHEDULED') throw ManifestErrors.tripNotScheduled();

            const snapshot = await currentManifestSnapshot(tx, locked.id);
            if (!snapshot) throw ManifestErrors.sourceInvalid();
            const latest = await tx.passengerManifest.aggregate({
              where: { tripId: locked.id },
              _max: { version: true },
            });
            const version = (latest._max.version ?? 0) + 1;
            const row = await tx.passengerManifest.create({
              data: {
                reference,
                tripId: locked.id,
                version,
                schemaVersion: MANIFEST_SCHEMA_VERSION,
                contentHash: manifestContentHash(snapshot),
                passengerCount: snapshot.passengers.length,
                boardedCount: snapshot.passengers.filter((item) => item.boarding !== null).length,
                snapshot: JSON.parse(canonicalManifestJson(snapshot)) as Prisma.InputJsonValue,
                generatedByIdentityId: actor.identityId,
              },
              select: manifestSelect,
            });
            await this.audit.record(
              {
                actor,
                action: 'PASSENGER_MANIFEST_GENERATED',
                resourceType: 'passenger_manifest',
                resourceId: row.id,
                metadata: this.auditMetadata(row),
              },
              tx,
            );
            return manifestDetailView(row);
          }),
        referenceCollision,
      );
    } catch (error) {
      manifestDomainError(error);
    }
  }

  private auditMetadata(row: ManifestRow) {
    return {
      manifestReference: row.reference,
      tripReference: row.trip.reference,
      version: row.version,
      passengerCount: row.passengerCount,
      boardedCount: row.boardedCount,
    };
  }

  private async recordAccess(
    tx: Db,
    actor: AuthPrincipal,
    row: ManifestRow,
    access: 'DETAIL',
  ): Promise<void> {
    await this.audit.record(
      {
        actor,
        action: 'PASSENGER_MANIFEST_ACCESSED',
        resourceType: 'passenger_manifest',
        resourceId: row.id,
        metadata: { access, ...this.auditMetadata(row) },
      },
      tx,
    );
  }
}
