import { createHash } from 'node:crypto';
import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { customerIdentityOf, type AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { comfortEventSchema } from './comfort.dto.js';
import { ComfortErrors } from './comfort.errors.js';

type ComfortEventInput = z.infer<typeof comfortEventSchema>;

const eventSelect = {
  id: true,
  tripId: true,
  routeWaypointId: true,
  type: true,
  actualFacilities: true,
  clientEventId: true,
  occurredAt: true,
  recordedAt: true,
  recordedByIdentityId: true,
  routeWaypoint: {
    select: {
      sequence: true,
      stop: { select: { code: true, name: true, locality: true } },
      checkpoint: {
        select: {
          code: true,
          name: true,
          locality: true,
          travellerVisible: true,
          terangaKind: true,
          facilities: true,
        },
      },
    },
  },
} satisfies Prisma.ComfortWaypointEventSelect;

type ComfortEventRow = Prisma.ComfortWaypointEventGetPayload<{
  select: typeof eventSelect;
}>;

const comfortTripSelect = {
  id: true,
  reference: true,
  status: true,
  plannedDepartureAt: true,
  plannedArrivalAt: true,
  routeVersion: {
    select: {
      route: { select: { code: true, name: true } },
      waypoints: {
        orderBy: { sequence: 'asc' as const },
        select: {
          id: true,
          sequence: true,
          stop: { select: { code: true, name: true, locality: true } },
          checkpoint: {
            select: {
              code: true,
              name: true,
              locality: true,
              terangaKind: true,
              travellerVisible: true,
              suggestedDwellMinutes: true,
              facilities: true,
            },
          },
        },
      },
    },
  },
  timings: {
    orderBy: { sequence: 'asc' as const },
    select: {
      routeWaypointId: true,
      sequence: true,
      plannedArrivalAt: true,
      plannedDepartureAt: true,
    },
  },
  trackingObservations: {
    where: {
      routeWaypointId: { not: null },
      source: { in: ['CHECKPOINT', 'CREW', 'OPS', 'SYSTEM'] as const },
    },
    orderBy: [{ observedAt: 'desc' as const }, { id: 'desc' as const }],
    select: {
      routeWaypointId: true,
      observedAt: true,
      routeWaypoint: { select: { sequence: true } },
    },
  },
  comfortEvents: {
    orderBy: [{ recordedAt: 'asc' as const }, { id: 'asc' as const }],
    select: eventSelect,
  },
} satisfies Prisma.TripSelect;

type ComfortTripRow = Prisma.TripGetPayload<{ select: typeof comfortTripSelect }>;

const PAUSE_KINDS = new Set(['BREAK', 'MEAL', 'SHOWER', 'REST', 'OVERNIGHT', 'FUEL']);

function stableFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function stateViolation(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes('comfort events require') ||
    message.includes('comfort waypoint terminal status is immutable') ||
    message.includes('comfort waypoint is already confirmed') ||
    message.includes('a waypoint cannot be completed before the trip starts')
  );
}

function waypointViolation(error: unknown): boolean {
  return String(error).includes('comfort waypoint must belong to the trip route version');
}

function maxDate(values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return dates.reduce((latest, current) =>
    current.getTime() > latest.getTime() ? current : latest,
  );
}

function eventView(row: ComfortEventRow) {
  const place = row.routeWaypoint.stop ?? row.routeWaypoint.checkpoint;
  return {
    id: row.id,
    tripId: row.tripId,
    routeWaypointId: row.routeWaypointId,
    type: row.type,
    actualFacilities: row.actualFacilities,
    clientEventId: row.clientEventId,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    recordedByIdentityId: row.recordedByIdentityId,
    waypoint: {
      sequence: row.routeWaypoint.sequence,
      code: place?.code ?? null,
      name: place?.name ?? null,
      locality: place?.locality ?? null,
    },
  };
}

function publicStep(step: {
  sequence: number;
  kind: string;
  code: string;
  name: string;
  locality: string;
  status: 'PLANNED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'SKIPPED';
  isPast: boolean;
  plannedArrivalAt: Date | null;
  plannedDepartureAt: Date | null;
  suggestedDwellMinutes: number | null;
  plannedFacilities: string[];
  actualFacilities: string[];
  statusUpdatedAt: Date | null;
}) {
  return step;
}

@Injectable()
export class ComfortService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private assertTimestamp(occurredAt: Date): void {
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) {
      throw ComfortErrors.timestampInvalid();
    }
  }

  private readTrip(tripId: string) {
    return this.database.client.trip.findUnique({
      where: { id: tripId },
      select: comfortTripSelect,
    });
  }

  private build(row: ComfortTripRow) {
    const timingByWaypoint = new Map(row.timings.map((timing) => [timing.routeWaypointId, timing]));
    const latestByWaypoint = new Map<string, ComfortEventRow>();
    for (const event of row.comfortEvents) latestByWaypoint.set(event.routeWaypointId, event);

    const observedSequence = row.trackingObservations[0]?.routeWaypoint?.sequence ?? 0;
    const completedSequence = row.comfortEvents
      .filter((event) => event.type === 'COMPLETED')
      .reduce((maximum, event) => Math.max(maximum, event.routeWaypoint.sequence), 0);
    const routeEndSequence = row.routeVersion.waypoints.at(-1)?.sequence ?? 0;
    const progressSequence =
      row.status === 'COMPLETED' ? routeEndSequence : Math.max(observedSequence, completedSequence);

    const allSteps = row.routeVersion.waypoints.map((waypoint) => {
      const timing = timingByWaypoint.get(waypoint.id);
      const latest = latestByWaypoint.get(waypoint.id);
      const place = waypoint.stop ?? waypoint.checkpoint;
      if (!place) throw new Error('route waypoint has no place');
      const travellerVisible =
        waypoint.stop !== null || waypoint.checkpoint?.travellerVisible === true;
      const status = latest?.type ?? ('PLANNED' as const);
      return {
        routeWaypointId: waypoint.id,
        travellerVisible,
        sequence: waypoint.sequence,
        kind: waypoint.stop ? ('STOP' as const) : waypoint.checkpoint!.terangaKind,
        code: place.code,
        name: place.name,
        locality: place.locality,
        status,
        isPast: row.status === 'COMPLETED' || waypoint.sequence <= progressSequence,
        plannedArrivalAt: timing?.plannedArrivalAt ?? null,
        plannedDepartureAt: timing?.plannedDepartureAt ?? null,
        suggestedDwellMinutes: waypoint.checkpoint?.suggestedDwellMinutes ?? null,
        plannedFacilities: waypoint.checkpoint?.facilities ?? [],
        actualFacilities: latest?.type === 'COMPLETED' ? latest.actualFacilities : [],
        statusUpdatedAt: latest?.occurredAt ?? null,
      };
    });

    const travellerSteps = allSteps
      .filter((step) => step.travellerVisible)
      .map((step) =>
        publicStep({
          sequence: step.sequence,
          kind: step.kind,
          code: step.code,
          name: step.name,
          locality: step.locality,
          status: step.status,
          isPast: step.isPast,
          plannedArrivalAt: step.plannedArrivalAt,
          plannedDepartureAt: step.plannedDepartureAt,
          suggestedDwellMinutes: step.suggestedDwellMinutes,
          plannedFacilities: step.plannedFacilities,
          actualFacilities: step.actualFacilities,
          statusUpdatedAt: step.statusUpdatedAt,
        }),
      );

    const future = travellerSteps.filter(
      (step) =>
        !step.isPast &&
        step.status !== 'CANCELLED' &&
        step.status !== 'SKIPPED' &&
        row.status !== 'COMPLETED' &&
        row.status !== 'CANCELLED',
    );
    const currentStep =
      [...travellerSteps]
        .reverse()
        .find((step) => step.isPast && step.status !== 'CANCELLED' && step.status !== 'SKIPPED') ??
      null;
    const nextStep = future[0] ?? null;
    const nextPause =
      future.find((step) => step.kind !== 'STOP' && PAUSE_KINDS.has(step.kind)) ?? null;
    const visibleWaypointIds = new Set(
      allSteps.filter((step) => step.travellerVisible).map((step) => step.routeWaypointId),
    );
    const latestVisibleObservation = row.trackingObservations.find(
      (observation) =>
        observation.routeWaypointId !== null &&
        visibleWaypointIds.has(observation.routeWaypointId),
    );
    const publicLastUpdatedAt = maxDate([
      latestVisibleObservation?.observedAt,
      ...row.comfortEvents
        .filter((event) => visibleWaypointIds.has(event.routeWaypointId))
        .map((event) => event.occurredAt),
    ]);
    const adminLastUpdatedAt = maxDate([
      row.trackingObservations[0]?.observedAt,
      ...row.comfortEvents.map((event) => event.occurredAt),
    ]);

    const projection = {
      tripReference: row.reference,
      tripStatus: row.status,
      route: row.routeVersion.route,
      plannedDepartureAt: row.plannedDepartureAt,
      plannedArrivalAt: row.plannedArrivalAt,
      progressSequence,
      lastUpdatedAt: publicLastUpdatedAt,
      currentStep,
      nextStep,
      nextPause,
      steps: travellerSteps,
    };

    return {
      public: projection,
      admin: {
        tripId: row.id,
        ...projection,
        lastUpdatedAt: adminLastUpdatedAt,
        steps: allSteps,
        events: row.comfortEvents.map(eventView),
      },
    };
  }

  async publicProjection(tripId: string) {
    const row = await this.readTrip(tripId);
    if (!row) throw ComfortErrors.tripNotFound();
    return this.build(row).public;
  }

  async adminProjection(tripId: string) {
    const row = await this.readTrip(tripId);
    if (!row) throw ComfortErrors.tripNotFound();
    return this.build(row).admin;
  }

  async customerProjection(actor: AuthPrincipal, rawBookingReference: string) {
    const reference = rawBookingReference.trim().toUpperCase();
    const booking = await this.database.client.booking.findFirst({
      where: {
        reference,
        customerIdentityId: customerIdentityOf(actor),
        confirmedAt: { not: null },
        cancelledAt: null,
      },
      select: { reference: true, tripId: true },
    });
    if (!booking) throw ComfortErrors.bookingNotFound();
    const row = await this.readTrip(booking.tripId);
    if (!row) throw ComfortErrors.bookingNotFound();
    return { bookingReference: booking.reference, ...this.build(row).public };
  }

  private replay(tripId: string, clientEventId: string) {
    return this.database.client.comfortWaypointEvent.findUnique({
      where: { tripId_clientEventId: { tripId, clientEventId } },
      select: { payloadFingerprint: true, ...eventSelect },
    });
  }

  private async ensureWaypoint(
    tripId: string,
    routeWaypointId: string,
    type: ComfortEventInput['type'],
  ) {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: {
        status: true,
        routeVersion: {
          select: {
            waypoints: {
              where: { id: routeWaypointId },
              select: { id: true },
            },
          },
        },
      },
    });
    if (!trip) throw ComfortErrors.tripNotFound();
    if (!['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'].includes(trip.status)) {
      throw ComfortErrors.tripUnavailable();
    }
    if (!trip.routeVersion.waypoints[0]) throw ComfortErrors.waypointInvalid();
    if (type === 'COMPLETED' && !['IN_PROGRESS', 'COMPLETED'].includes(trip.status)) {
      throw ComfortErrors.transitionInvalid();
    }
  }

  async record(actor: AuthPrincipal, tripId: string, input: ComfortEventInput) {
    this.assertTimestamp(input.occurredAt);
    const actualFacilities = [...input.actualFacilities].sort();
    const payloadFingerprint = stableFingerprint([
      tripId,
      input.routeWaypointId,
      input.type,
      input.occurredAt.toISOString(),
      actualFacilities,
    ]);
    const existing = await this.replay(tripId, input.clientEventId);
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        throw ComfortErrors.idempotencyConflict();
      }
      const { payloadFingerprint: _payloadFingerprint, ...row } = existing;
      return { created: false, event: eventView(row) };
    }

    await this.ensureWaypoint(tripId, input.routeWaypointId, input.type);

    try {
      return await this.database.client.$transaction(async (tx) => {
        const row = await tx.comfortWaypointEvent.create({
          data: {
            tripId,
            routeWaypointId: input.routeWaypointId,
            type: input.type,
            actualFacilities,
            clientEventId: input.clientEventId,
            payloadFingerprint,
            occurredAt: input.occurredAt,
            recordedByIdentityId: actor.identityId,
          },
          select: eventSelect,
        });
        await this.audit.record(
          {
            actor,
            action: 'COMFORT_WAYPOINT_EVENT_RECORDED',
            resourceType: 'comfort_waypoint_event',
            resourceId: row.id,
            after: {
              tripId,
              routeWaypointId: input.routeWaypointId,
              type: input.type,
              actualFacilities,
              occurredAt: input.occurredAt,
            },
          },
          tx,
        );
        return { created: true, event: eventView(row) };
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        const replay = await this.replay(tripId, input.clientEventId);
        if (replay && replay.payloadFingerprint === payloadFingerprint) {
          const { payloadFingerprint: _payloadFingerprint, ...row } = replay;
          return { created: false, event: eventView(row) };
        }
        throw ComfortErrors.idempotencyConflict();
      }
      if (waypointViolation(error)) throw ComfortErrors.waypointInvalid();
      if (stateViolation(error)) throw ComfortErrors.transitionInvalid();
      throw error;
    }
  }
}
