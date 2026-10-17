import { createHash } from 'node:crypto';
import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { borderCrewEventSchema, borderStaffEventSchema } from './border.dto.js';
import { BorderErrors } from './border.errors.js';

type StaffEventInput = z.infer<typeof borderStaffEventSchema>;
type CrewEventInput = z.infer<typeof borderCrewEventSchema>;

const eventSelect = {
  id: true,
  tripId: true,
  routeWaypointId: true,
  type: true,
  source: true,
  clientEventId: true,
  occurredAt: true,
  recordedAt: true,
  routeWaypoint: {
    select: {
      sequence: true,
      checkpoint: { select: { code: true, name: true, type: true } },
    },
  },
} satisfies Prisma.BorderEventSelect;

type EventRow = Prisma.BorderEventGetPayload<{ select: typeof eventSelect }>;

function stableFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function eventView(row: EventRow) {
  return {
    id: row.id,
    tripId: row.tripId,
    routeWaypointId: row.routeWaypointId,
    type: row.type,
    source: row.source,
    clientEventId: row.clientEventId,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    waypoint: {
      sequence: row.routeWaypoint.sequence,
      code: row.routeWaypoint.checkpoint?.code ?? null,
      name: row.routeWaypoint.checkpoint?.name ?? null,
    },
  };
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function stateViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const message = String(error.message);
  return (
    message.includes('invalid border event transition') ||
    message.includes('first border event must be ARRIVED') ||
    message.includes('border events require an in-progress trip')
  );
}

@Injectable()
export class BorderService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private assertTimestamp(occurredAt: Date): void {
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw BorderErrors.timestampInvalid();
  }

  private fingerprint(input: {
    tripId: string;
    routeWaypointId: string;
    type: StaffEventInput['type'];
    occurredAt: Date;
    source: 'STAFF' | 'CREW';
  }): string {
    return stableFingerprint([
      input.tripId,
      input.routeWaypointId,
      input.type,
      input.occurredAt.toISOString(),
      input.source,
    ]);
  }

  private async ensureWaypoint(tripId: string, routeWaypointId: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        status: true,
        routeVersion: {
          select: {
            waypoints: {
              where: { id: routeWaypointId },
              select: { id: true, checkpoint: { select: { type: true } } },
            },
          },
        },
      },
    });
    if (!trip) throw BorderErrors.tripNotFound();
    if (trip.status !== 'IN_PROGRESS') throw BorderErrors.tripUnavailable();
    if (trip.routeVersion.waypoints[0]?.checkpoint?.type !== 'BORDER')
      throw BorderErrors.waypointInvalid();
  }

  private replay(tripId: string, clientEventId: string) {
    return this.database.client.borderEvent.findUnique({
      where: { tripId_clientEventId: { tripId, clientEventId } },
      select: { payloadFingerprint: true, ...eventSelect },
    });
  }

  private async persist(
    actor: AuthPrincipal,
    input: {
      tripId: string;
      routeWaypointId: string;
      type: StaffEventInput['type'];
      occurredAt: Date;
      clientEventId: string;
      source: 'STAFF' | 'CREW';
      crewAssignmentId?: string;
      crewDeviceId?: string;
    },
  ) {
    this.assertTimestamp(input.occurredAt);
    const payloadFingerprint = this.fingerprint(input);
    const existing = await this.replay(input.tripId, input.clientEventId);

    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint)
        throw BorderErrors.idempotencyConflict();
      const { payloadFingerprint: _payloadFingerprint, ...row } = existing;
      return { created: false, event: eventView(row) };
    }

    await this.ensureWaypoint(input.tripId, input.routeWaypointId);

    try {
      return await this.database.client.$transaction(async (tx) => {
        const row = await tx.borderEvent.create({
          data: {
            tripId: input.tripId,
            routeWaypointId: input.routeWaypointId,
            type: input.type,
            source: input.source,
            clientEventId: input.clientEventId,
            payloadFingerprint,
            occurredAt: input.occurredAt,
            recordedByIdentityId: actor.identityId,
            ...(input.crewAssignmentId ? { crewAssignmentId: input.crewAssignmentId } : {}),
            ...(input.crewDeviceId ? { crewDeviceId: input.crewDeviceId } : {}),
          },
          select: eventSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'BORDER_EVENT_RECORDED',
            resourceType: 'border_event',
            resourceId: row.id,
            after: {
              tripId: row.tripId,
              routeWaypointId: row.routeWaypointId,
              type: row.type,
              source: row.source,
              occurredAt: row.occurredAt,
            },
          },
          tx,
        );
        return { created: true, event: eventView(row) };
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        const replay = await this.replay(input.tripId, input.clientEventId);
        if (replay && replay.payloadFingerprint === payloadFingerprint) {
          const { payloadFingerprint: _payloadFingerprint, ...row } = replay;
          return { created: false, event: eventView(row) };
        }
        throw BorderErrors.idempotencyConflict();
      }
      if (stateViolation(error)) throw BorderErrors.transitionInvalid();
      throw error;
    }
  }

  async listTrip(tripId: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        reference: true,
        status: true,
        routeVersion: {
          select: {
            waypoints: {
              where: { checkpoint: { type: 'BORDER' } },
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                sequence: true,
                checkpoint: { select: { code: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!trip) throw BorderErrors.tripNotFound();

    const events = await this.database.client.borderEvent.findMany({
      where: { tripId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: eventSelect,
    });
    const latestByWaypoint = new Map<string, EventRow>();
    for (const event of events) latestByWaypoint.set(event.routeWaypointId, event);

    return {
      trip: { id: trip.id, reference: trip.reference, status: trip.status },
      borders: trip.routeVersion.waypoints.map((waypoint) => {
        const latest = latestByWaypoint.get(waypoint.id);
        return {
          routeWaypointId: waypoint.id,
          sequence: waypoint.sequence,
          code: waypoint.checkpoint?.code ?? null,
          name: waypoint.checkpoint?.name ?? null,
          currentState: latest?.type ?? 'PENDING',
          latestOccurredAt: latest?.occurredAt ?? null,
        };
      }),
      events: events.map(eventView),
    };
  }

  recordStaff(actor: AuthPrincipal, tripId: string, input: StaffEventInput) {
    return this.persist(actor, { tripId, source: 'STAFF', ...input });
  }

  async recordCrew(actor: AuthPrincipal, rawTripReference: string, input: CrewEventInput) {
    const tripReference = rawTripReference.trim().toUpperCase();
    const now = new Date();
    const trip = await this.database.client.trip.findUnique({
      where: { reference: tripReference },
      select: {
        id: true,
        status: true,
        crewAssignments: {
          where: {
            crewIdentityId: actor.identityId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!trip) throw BorderErrors.tripNotFound();
    if (trip.status !== 'IN_PROGRESS') throw BorderErrors.tripUnavailable();
    const assignment = trip.crewAssignments[0];
    if (!assignment) throw BorderErrors.crewUnavailable();

    const device = await this.database.client.crewDevice.findFirst({
      where: {
        deviceId: input.deviceId,
        identityId: actor.identityId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!device) throw BorderErrors.crewDeviceUnavailable();
    await this.database.client.crewDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: now },
      select: { id: true },
    });

    return this.persist(actor, {
      tripId: trip.id,
      source: 'CREW',
      routeWaypointId: input.routeWaypointId,
      type: input.type,
      clientEventId: input.clientEventId,
      occurredAt: input.occurredAt,
      crewAssignmentId: assignment.id,
      crewDeviceId: device.id,
    });
  }
}
