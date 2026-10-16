import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { AuditService } from '../authorization/audit.service.js';
import { BoardingService, type CrewBoardingContext } from '../check-in/boarding.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  crewAssignmentCreateSchema,
  crewAssignmentRevokeSchema,
  crewDeviceEnrollSchema,
  crewDeviceRevokeSchema,
  crewSyncSchema,
} from './crew.dto.js';
import { CrewErrors } from './crew.errors.js';

const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;
const SNAPSHOT_TTL_MS = 12 * 60 * 60_000;

type DeviceEnroll = z.infer<typeof crewDeviceEnrollSchema>;
type DeviceRevoke = z.infer<typeof crewDeviceRevokeSchema>;
type SyncInput = z.infer<typeof crewSyncSchema>;
type AssignmentCreate = z.infer<typeof crewAssignmentCreateSchema>;
type AssignmentRevoke = z.infer<typeof crewAssignmentRevokeSchema>;

const assignmentSelect = {
  id: true,
  assignedAt: true,
  expiresAt: true,
  revokedAt: true,
  revocationReason: true,
  crew: { select: { id: true, email: true, status: true } },
} as const;

function deviceView(row: {
  deviceId: string;
  label: string | null;
  enrolledAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}) {
  return row;
}

function assignmentView(row: {
  id: string;
  assignedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  crew: { id: string; email: string; status: string };
}) {
  return row;
}

function p2002(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function retryAfterSeconds(error: PublicApiError): number {
  const parsed = Number.parseInt(error.headers['Retry-After'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

@Injectable()
export class CrewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly boarding: BoardingService,
  ) {}

  async trips(actor: AuthPrincipal) {
    const now = new Date();
    const rows = await this.database.client.crewTripAssignment.findMany({
      where: {
        crewIdentityId: actor.identityId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        trip: { status: 'SCHEDULED' },
      },
      orderBy: [{ trip: { plannedDepartureAt: 'asc' } }, { assignedAt: 'asc' }],
      select: {
        id: true,
        expiresAt: true,
        trip: {
          select: {
            reference: true,
            status: true,
            plannedDepartureAt: true,
            plannedArrivalAt: true,
            vehicle: { select: { code: true } },
            routeVersion: { select: { route: { select: { code: true, name: true } } } },
          },
        },
      },
    });
    const ttl = Date.now() + SNAPSHOT_TTL_MS;
    return {
      serverTime: now,
      items: rows.map((row) => ({
        assignmentId: row.id,
        snapshotExpiresAt: new Date(
          Math.min(ttl, row.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY),
        ),
        trip: {
          reference: row.trip.reference,
          status: row.trip.status,
          plannedDepartureAt: row.trip.plannedDepartureAt,
          plannedArrivalAt: row.trip.plannedArrivalAt,
          vehicleCode: row.trip.vehicle?.code ?? null,
          route: row.trip.routeVersion.route,
        },
      })),
    };
  }

  async trip(actor: AuthPrincipal, rawTripReference: string) {
    const tripReference = rawTripReference.trim().toUpperCase();
    const list = await this.trips(actor);
    const item = list.items.find((candidate) => candidate.trip.reference === tripReference);
    if (!item) throw CrewErrors.notAssigned();
    return { serverTime: list.serverTime, ...item };
  }

  async device(actor: AuthPrincipal, deviceId: string) {
    const row = await this.database.client.crewDevice.findFirst({
      where: { deviceId, identityId: actor.identityId },
    });
    if (!row) throw CrewErrors.deviceNotFound();
    return deviceView(row);
  }

  async enrollDevice(actor: AuthPrincipal, input: DeviceEnroll) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEVICE_TTL_MS);
    try {
      return await this.database.client.$transaction(async (tx) => {
        const existing = await tx.crewDevice.findUnique({ where: { deviceId: input.deviceId } });
        if (existing && existing.identityId !== actor.identityId) throw CrewErrors.deviceConflict();
        if (existing?.revokedAt) throw CrewErrors.deviceUnavailable();
        const row = existing
          ? await tx.crewDevice.update({
              where: { id: existing.id },
              data: { label: input.label ?? existing.label, lastSeenAt: now, expiresAt },
            })
          : await tx.crewDevice.create({
              data: {
                deviceId: input.deviceId,
                identityId: actor.identityId,
                label: input.label ?? null,
                expiresAt,
              },
            });
        await this.audit.record(
          {
            actor,
            action: existing ? 'CREW_DEVICE_REFRESHED' : 'CREW_DEVICE_ENROLLED',
            resourceType: 'crew_device',
            resourceId: row.id,
            metadata: { deviceId: row.deviceId, expiresAt: row.expiresAt.toISOString() },
          },
          tx,
        );
        return deviceView(row);
      });
    } catch (error) {
      if (!p2002(error)) throw error;
      const concurrent = await this.database.client.crewDevice.findUnique({
        where: { deviceId: input.deviceId },
      });
      if (!concurrent || concurrent.identityId !== actor.identityId) {
        throw CrewErrors.deviceConflict();
      }
      if (concurrent.revokedAt) throw CrewErrors.deviceUnavailable();
      return deviceView(concurrent);
    }
  }

  async revokeDevice(actor: AuthPrincipal, rawDeviceId: string, input: DeviceRevoke) {
    const deviceId = rawDeviceId.trim();
    return this.database.client.$transaction(async (tx) => {
      const row = await tx.crewDevice.findFirst({
        where: { deviceId, identityId: actor.identityId },
      });
      if (!row) throw CrewErrors.deviceNotFound();
      if (row.revokedAt) return deviceView(row);
      const revoked = await tx.crewDevice.update({
        where: { id: row.id },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          revocationReason: input.reason,
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'CREW_DEVICE_REVOKED',
          resourceType: 'crew_device',
          resourceId: revoked.id,
          metadata: { deviceId: revoked.deviceId, reason: input.reason },
        },
        tx,
      );
      return deviceView(revoked);
    });
  }

  private async context(
    actor: AuthPrincipal,
    tripReference: string,
    deviceId: string,
  ): Promise<CrewBoardingContext> {
    const now = new Date();
    const [device] = await this.database.client.$queryRaw<Array<{ id: string }>>`
      UPDATE "crew_device" SET "last_seen_at" = ${now}
      WHERE "device_id" = ${deviceId}
        AND "identity_id" = ${actor.identityId}::uuid
        AND "revoked_at" IS NULL AND "expires_at" > ${now}
      RETURNING "id"
    `;
    if (!device) throw CrewErrors.deviceUnavailable();
    const assignment = await this.database.client.crewTripAssignment.findFirst({
      where: {
        crewIdentityId: actor.identityId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        trip: { reference: tripReference },
      },
      select: { id: true, trip: { select: { status: true } } },
    });
    if (!assignment) throw CrewErrors.notAssigned();
    if (assignment.trip.status !== 'SCHEDULED') throw CrewErrors.tripUnavailable();
    return { crewDeviceId: device.id, crewAssignmentId: assignment.id };
  }

  async sync(actor: AuthPrincipal, rawTripReference: string, input: SyncInput) {
    const tripReference = rawTripReference.trim().toUpperCase();
    const context = await this.context(actor, tripReference, input.deviceId);
    const results = [];
    for (const event of input.events) {
      try {
        const result = await this.boarding.scan(
          actor,
          {
            qrPayload: event.payload.qrPayload,
            deviceId: input.deviceId,
            clientEventId: event.clientEventId,
            occurredAt: event.occurredAt,
          },
          context,
        );
        results.push({
          clientEventId: event.clientEventId,
          status: 'ACKNOWLEDGED' as const,
          created: result.created,
          boardingReference: result.boarding.reference,
        });
      } catch (error) {
        if (error instanceof PublicApiError) {
          if (error.getStatus() === 429) {
            results.push({
              clientEventId: event.clientEventId,
              status: 'RETRY' as const,
              errorCode: error.code,
              retryAfterSeconds: retryAfterSeconds(error),
            });
            continue;
          }
          results.push({
            clientEventId: event.clientEventId,
            status:
              error.code === 'BOARDING_CLIENT_EVENT_ID_REUSED'
                ? ('CONFLICT' as const)
                : ('REJECTED' as const),
            errorCode: error.code,
          });
          continue;
        }
        throw error;
      }
    }
    return { tripReference, results };
  }

  async assignments(tripId: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: { id: true },
    });
    if (!trip) throw CrewErrors.assignmentNotFound();
    return {
      items: (
        await this.database.client.crewTripAssignment.findMany({
          where: { tripId },
          orderBy: { assignedAt: 'desc' },
          select: assignmentSelect,
        })
      ).map(assignmentView),
    };
  }

  async assign(
    actor: AuthPrincipal,
    tripId: string,
    input: AssignmentCreate,
  ): Promise<{ created: boolean; assignment: ReturnType<typeof assignmentView> }> {
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw CrewErrors.assignmentExpiryInvalid();
    }
    try {
      return await this.database.client.$transaction(async (tx) => {
        const trips = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT "id", "status"::text AS status FROM "trip"
          WHERE "id" = ${tripId}::uuid FOR UPDATE
        `;
        const trip = trips[0];
        if (!trip) throw CrewErrors.assignmentNotFound();
        if (trip.status !== 'SCHEDULED') throw CrewErrors.tripUnavailable();

        const identities = await tx.$queryRaw<Array<{ id: string; realm: string; status: string }>>`
          SELECT "id", "realm"::text AS realm, "status"::text AS status
          FROM "auth_identity" WHERE "id" = ${input.crewIdentityId}::uuid FOR UPDATE
        `;
        const identity = identities[0];
        if (!identity || identity.realm !== 'CREW' || identity.status !== 'ACTIVE') {
          throw CrewErrors.identityUnavailable();
        }

        const existing = await tx.crewTripAssignment.findFirst({
          where: { tripId, crewIdentityId: input.crewIdentityId, revokedAt: null },
          select: assignmentSelect,
        });
        if (existing) return { created: false, assignment: assignmentView(existing) };

        const row = await tx.crewTripAssignment.create({
          data: {
            tripId,
            crewIdentityId: input.crewIdentityId,
            assignedByIdentityId: actor.identityId,
            expiresAt: input.expiresAt ?? null,
          },
          select: assignmentSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'CREW_TRIP_ASSIGNED',
            resourceType: 'crew_trip_assignment',
            resourceId: row.id,
            metadata: { tripId, crewIdentityId: input.crewIdentityId },
          },
          tx,
        );
        return { created: true, assignment: assignmentView(row) };
      });
    } catch (error) {
      if (p2002(error)) {
        const concurrent = await this.database.client.crewTripAssignment.findFirst({
          where: { tripId, crewIdentityId: input.crewIdentityId, revokedAt: null },
          select: assignmentSelect,
        });
        if (concurrent) return { created: false, assignment: assignmentView(concurrent) };
        throw CrewErrors.assignmentConflict();
      }
      throw error;
    }
  }

  async revokeAssignment(
    actor: AuthPrincipal,
    tripId: string,
    assignmentId: string,
    input: AssignmentRevoke,
  ) {
    return this.database.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; revoked_at: Date | null }>>`
        SELECT "id", "revoked_at" FROM "crew_trip_assignment"
        WHERE "id" = ${assignmentId}::uuid AND "trip_id" = ${tripId}::uuid
        FOR UPDATE
      `;
      const locked = rows[0];
      if (!locked) throw CrewErrors.assignmentNotFound();
      if (locked.revoked_at) {
        const current = await tx.crewTripAssignment.findUniqueOrThrow({
          where: { id: assignmentId },
          select: assignmentSelect,
        });
        return assignmentView(current);
      }
      const row = await tx.crewTripAssignment.update({
        where: { id: assignmentId },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          revocationReason: input.reason,
        },
        select: assignmentSelect,
      });
      await this.audit.record(
        {
          actor,
          action: 'CREW_TRIP_ASSIGNMENT_REVOKED',
          resourceType: 'crew_trip_assignment',
          resourceId: row.id,
          metadata: { tripId, reason: input.reason },
        },
        tx,
      );
      return assignmentView(row);
    });
  }
}
