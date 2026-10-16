import { createHash } from 'node:crypto';
import {
  Prisma,
  type DatabaseTransaction,
  type TrackingProviderStatus,
  type TrackingVisibility,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  hashOpaqueToken,
  isWellFormedOpaqueToken,
  secureRandomToken,
} from '../auth/crypto/tokens.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  trackingConfigSchema,
  trackingCrewCheckpointSchema,
  trackingDeviceCreateSchema,
  trackingObservationSchema,
} from './tracking.dto.js';
import { TrackingErrors } from './tracking.errors.js';
import {
  GPS_PROVIDER,
  type GpsProvider,
  type GpsProviderPosition,
} from './providers/gps-provider.js';

type ConfigInput = z.infer<typeof trackingConfigSchema>;
type DeviceInput = z.infer<typeof trackingDeviceCreateSchema>;
type OpsObservationInput = z.infer<typeof trackingObservationSchema>;
type CrewCheckpointInput = z.infer<typeof trackingCrewCheckpointSchema>;

const PROVIDER_FRESH_MS = 15 * 60 * 1000;

function p2002(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function stableFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function approximate(value: number): number {
  return Math.round(value * 10) / 10;
}

const observationSelect = {
  id: true,
  source: true,
  observedAt: true,
  receivedAt: true,
  latitude: true,
  longitude: true,
  accuracyMeters: true,
  speedKph: true,
  headingDegrees: true,
  routeWaypointId: true,
  label: true,
  providerKey: true,
  providerObservationId: true,
  clientEventId: true,
  routeWaypoint: {
    select: {
      sequence: true,
      stop: { select: { code: true, name: true } },
      checkpoint: { select: { code: true, name: true, type: true } },
    },
  },
} satisfies Prisma.TrackingObservationSelect;

type ObservationRow = Prisma.TrackingObservationGetPayload<{
  select: typeof observationSelect;
}>;

function checkpointView(
  row: {
    observedAt: Date;
    label: string | null;
    routeWaypoint: ObservationRow['routeWaypoint'];
  } | null,
) {
  if (!row?.routeWaypoint) return null;
  const place = row.routeWaypoint.checkpoint ?? row.routeWaypoint.stop;
  if (!place) return null;
  return {
    sequence: row.routeWaypoint.sequence,
    kind: row.routeWaypoint.checkpoint ? ('CHECKPOINT' as const) : ('STOP' as const),
    code: place.code,
    name: row.label ?? place.name,
    ...(row.routeWaypoint.checkpoint ? { type: row.routeWaypoint.checkpoint.type } : {}),
    observedAt: row.observedAt,
  };
}

function observationView(row: ObservationRow) {
  return {
    id: row.id,
    source: row.source,
    observedAt: row.observedAt,
    receivedAt: row.receivedAt,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    accuracyMeters: numberOrNull(row.accuracyMeters),
    speedKph: numberOrNull(row.speedKph),
    headingDegrees: numberOrNull(row.headingDegrees),
    routeWaypointId: row.routeWaypointId,
    label: row.label,
    providerKey: row.providerKey,
    providerObservationId: row.providerObservationId,
    clientEventId: row.clientEventId,
    checkpoint: checkpointView({
      observedAt: row.observedAt,
      label: row.label,
      routeWaypoint: row.routeWaypoint,
    }),
  };
}

interface ObservationInput {
  tripId: string;
  source: 'GPS' | 'CHECKPOINT' | 'CREW' | 'OPS' | 'SYSTEM';
  observedAt: Date;
  payloadFingerprint: string;
  providerKey?: string;
  providerDeviceId?: string;
  providerObservationId?: string;
  clientEventId?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  speedKph?: number;
  headingDegrees?: number;
  routeWaypointId?: string;
  label?: string;
  createdByIdentityId?: string;
  crewAssignmentId?: string;
  crewDeviceId?: string;
}

@Injectable()
export class TrackingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(GPS_PROVIDER) private readonly gpsProvider: GpsProvider,
  ) {}

  private assertTimestamp(observedAt: Date): void {
    if (observedAt.getTime() > Date.now() + 5 * 60_000) {
      throw TrackingErrors.timestampInvalid();
    }
  }

  private async providerStatus(
    tripId: string,
    device: { providerKey: string; externalId: string } | null,
  ): Promise<TrackingProviderStatus> {
    if (!device) return 'UNAVAILABLE';

    const latest = await this.database.client.trackingObservation.findFirst({
      where: {
        tripId,
        source: 'GPS',
        providerKey: device.providerKey,
        providerDeviceId: device.externalId,
      },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: { observedAt: true },
    });
    if (latest) {
      return Date.now() - latest.observedAt.getTime() <= PROVIDER_FRESH_MS ? 'UP' : 'STALE';
    }
    if (this.gpsProvider.supports(device.providerKey)) {
      return this.gpsProvider.status(device.externalId);
    }
    return 'UNAVAILABLE';
  }

  async listTrips() {
    const rows = await this.database.client.trip.findMany({
      where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
      orderBy: [{ plannedDepartureAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        reference: true,
        status: true,
        plannedDepartureAt: true,
        plannedArrivalAt: true,
        vehicle: { select: { id: true, code: true } },
        routeVersion: { select: { route: { select: { code: true, name: true } } } },
        trackingConfig: {
          select: {
            enabled: true,
            visibility: true,
            trackingDevice: {
              select: { id: true, providerKey: true, externalId: true, active: true },
            },
          },
        },
        trackingObservations: {
          take: 1,
          orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
          select: { observedAt: true, source: true },
        },
      },
    });

    return {
      items: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          reference: row.reference,
          status: row.status,
          plannedDepartureAt: row.plannedDepartureAt,
          plannedArrivalAt: row.plannedArrivalAt,
          vehicle: row.vehicle,
          route: row.routeVersion.route,
          config: row.trackingConfig,
          lastObservation: row.trackingObservations[0] ?? null,
          providerStatus: await this.providerStatus(
            row.id,
            row.trackingConfig?.trackingDevice ?? null,
          ),
        })),
      ),
    };
  }

  async tripDetail(tripId: string) {
    const row = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        reference: true,
        status: true,
        plannedDepartureAt: true,
        plannedArrivalAt: true,
        vehicle: { select: { id: true, code: true } },
        routeVersion: { select: { route: { select: { code: true, name: true } } } },
        trackingConfig: {
          select: {
            enabled: true,
            visibility: true,
            createdAt: true,
            updatedAt: true,
            trackingDevice: {
              select: { id: true, providerKey: true, externalId: true, active: true },
            },
          },
        },
        trackingObservations: {
          take: 100,
          orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
          select: observationSelect,
        },
        trackingPublicTokens: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            revocationReason: true,
          },
        },
      },
    });
    if (!row) throw TrackingErrors.tripNotFound();

    return {
      id: row.id,
      reference: row.reference,
      status: row.status,
      plannedDepartureAt: row.plannedDepartureAt,
      plannedArrivalAt: row.plannedArrivalAt,
      vehicle: row.vehicle,
      route: row.routeVersion.route,
      config: row.trackingConfig,
      providerStatus: await this.providerStatus(row.id, row.trackingConfig?.trackingDevice ?? null),
      observations: row.trackingObservations.map(observationView),
      publicTokens: row.trackingPublicTokens,
    };
  }

  async devices() {
    return {
      items: await this.database.client.trackingDevice.findMany({
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          providerKey: true,
          externalId: true,
          active: true,
          createdAt: true,
          updatedAt: true,
          vehicle: { select: { id: true, code: true, status: true } },
        },
      }),
    };
  }

  async createDevice(actor: AuthPrincipal, input: DeviceInput) {
    const vehicle = await this.database.client.vehicle.findUnique({
      where: { id: input.vehicleId },
      select: { id: true, status: true },
    });
    if (!vehicle || vehicle.status === 'RETIRED') throw TrackingErrors.deviceNotFound();

    try {
      return await this.database.client.$transaction(async (tx) => {
        const row = await tx.trackingDevice.create({
          data: {
            vehicleId: input.vehicleId,
            providerKey: input.providerKey,
            externalId: input.externalId,
            createdByIdentityId: actor.identityId,
          },
          select: {
            id: true,
            providerKey: true,
            externalId: true,
            active: true,
            createdAt: true,
            vehicle: { select: { id: true, code: true } },
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'TRACKING_DEVICE_CREATED',
            resourceType: 'tracking_device',
            resourceId: row.id,
            after: {
              vehicleId: row.vehicle.id,
              providerKey: row.providerKey,
              externalId: row.externalId,
              active: row.active,
            },
          },
          tx,
        );
        return row;
      });
    } catch (error) {
      if (p2002(error)) throw TrackingErrors.deviceConflict();
      throw error;
    }
  }

  async configure(actor: AuthPrincipal, tripId: string, input: ConfigInput) {
    return this.database.client.$transaction(async (tx) => {
      await this.lockTrip(tx, tripId);
      const trip = await tx.trip.findUnique({
        where: { id: tripId },
        select: { id: true, vehicleId: true },
      });
      if (!trip) throw TrackingErrors.tripNotFound();

      if (input.trackingDeviceId) {
        const device = await tx.trackingDevice.findUnique({
          where: { id: input.trackingDeviceId },
          select: { vehicleId: true, active: true },
        });
        if (!device) throw TrackingErrors.deviceNotFound();
        if (!device.active || !trip.vehicleId || device.vehicleId !== trip.vehicleId) {
          throw TrackingErrors.deviceMismatch();
        }
      }

      const before = await tx.tripTrackingConfig.findUnique({
        where: { tripId },
        select: { enabled: true, visibility: true, trackingDeviceId: true },
      });

      const row = before
        ? await tx.tripTrackingConfig.update({
            where: { tripId },
            data: {
              enabled: input.enabled,
              visibility: input.visibility,
              trackingDeviceId: input.trackingDeviceId,
              updatedByIdentityId: actor.identityId,
            },
            select: {
              tripId: true,
              enabled: true,
              visibility: true,
              trackingDeviceId: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : await tx.tripTrackingConfig.create({
            data: {
              tripId,
              enabled: input.enabled,
              visibility: input.visibility,
              trackingDeviceId: input.trackingDeviceId,
              createdByIdentityId: actor.identityId,
              updatedByIdentityId: actor.identityId,
            },
            select: {
              tripId: true,
              enabled: true,
              visibility: true,
              trackingDeviceId: true,
              createdAt: true,
              updatedAt: true,
            },
          });

      await this.audit.record(
        {
          actor,
          action: before ? 'TRACKING_CONFIG_CHANGED' : 'TRACKING_CONFIG_CREATED',
          resourceType: 'trip_tracking_config',
          resourceId: tripId,
          before,
          after: {
            enabled: row.enabled,
            visibility: row.visibility,
            trackingDeviceId: row.trackingDeviceId,
          },
        },
        tx,
      );
      return row;
    });
  }

  private async lockTrip(tx: DatabaseTransaction, tripId: string): Promise<void> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "trip" WHERE "id" = $1::uuid FOR UPDATE',
      tripId,
    );
    if (!rows[0]) throw TrackingErrors.tripNotFound();
  }

  private async assertWaypoint(tripId: string, routeWaypointId: string) {
    const row = await this.database.client.trip.findFirst({
      where: {
        id: tripId,
        routeVersion: { waypoints: { some: { id: routeWaypointId } } },
      },
      select: { id: true },
    });
    if (!row) throw TrackingErrors.waypointInvalid();
  }

  private async replayByClientEvent(tripId: string, clientEventId: string) {
    return this.database.client.trackingObservation.findUnique({
      where: { tripId_clientEventId: { tripId, clientEventId } },
      select: { payloadFingerprint: true, ...observationSelect },
    });
  }

  private async replayByProvider(providerKey: string, providerObservationId: string) {
    return this.database.client.trackingObservation.findUnique({
      where: {
        providerKey_providerObservationId: { providerKey, providerObservationId },
      },
      select: { payloadFingerprint: true, ...observationSelect },
    });
  }

  private async persistObservation(
    input: ObservationInput,
    auditInput?: { actor: AuthPrincipal; action: string },
  ) {
    try {
      return await this.database.client.$transaction(async (tx) => {
        await this.lockTrip(tx, input.tripId);

        if (input.clientEventId) {
          const existing = await tx.trackingObservation.findUnique({
            where: {
              tripId_clientEventId: {
                tripId: input.tripId,
                clientEventId: input.clientEventId,
              },
            },
            select: { payloadFingerprint: true, ...observationSelect },
          });
          if (existing) {
            if (existing.payloadFingerprint !== input.payloadFingerprint) {
              throw TrackingErrors.idempotencyConflict();
            }
            return { created: false, observation: observationView(existing) };
          }
        }

        if (input.providerKey && input.providerObservationId) {
          const existing = await tx.trackingObservation.findUnique({
            where: {
              providerKey_providerObservationId: {
                providerKey: input.providerKey,
                providerObservationId: input.providerObservationId,
              },
            },
            select: { payloadFingerprint: true, ...observationSelect },
          });
          if (existing) {
            if (existing.payloadFingerprint !== input.payloadFingerprint) {
              throw TrackingErrors.providerEventConflict();
            }
            return { created: false, observation: observationView(existing) };
          }
        }

        const row = await tx.trackingObservation.create({
          data: input,
          select: observationSelect,
        });

        if (auditInput) {
          await this.audit.record(
            {
              actor: auditInput.actor,
              action: auditInput.action,
              resourceType: 'tracking_observation',
              resourceId: row.id,
              metadata: {
                tripId: input.tripId,
                source: input.source,
                routeWaypointId: input.routeWaypointId ?? null,
              },
            },
            tx,
          );
        }
        return { created: true, observation: observationView(row) };
      });
    } catch (error) {
      if (!p2002(error)) throw error;

      if (input.clientEventId) {
        const replay = await this.replayByClientEvent(input.tripId, input.clientEventId);
        if (replay) {
          if (replay.payloadFingerprint !== input.payloadFingerprint) {
            throw TrackingErrors.idempotencyConflict();
          }
          return { created: false, observation: observationView(replay) };
        }
      }

      if (input.providerKey && input.providerObservationId) {
        const replay = await this.replayByProvider(input.providerKey, input.providerObservationId);
        if (replay) {
          if (replay.payloadFingerprint !== input.payloadFingerprint) {
            throw TrackingErrors.providerEventConflict();
          }
          return { created: false, observation: observationView(replay) };
        }
      }
      throw error;
    }
  }

  async recordOperationalObservation(
    actor: AuthPrincipal,
    tripId: string,
    input: OpsObservationInput,
  ) {
    this.assertTimestamp(input.observedAt);
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: { id: true },
    });
    if (!trip) throw TrackingErrors.tripNotFound();
    if (input.routeWaypointId) await this.assertWaypoint(tripId, input.routeWaypointId);

    const payloadFingerprint = stableFingerprint([
      tripId,
      input.source,
      input.observedAt.toISOString(),
      input.routeWaypointId ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.accuracyMeters ?? null,
      input.speedKph ?? null,
      input.headingDegrees ?? null,
      input.label ?? null,
    ]);

    return this.persistObservation(
      {
        tripId,
        source: input.source,
        observedAt: input.observedAt,
        payloadFingerprint,
        ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        ...(input.routeWaypointId ? { routeWaypointId: input.routeWaypointId } : {}),
        ...(input.latitude !== undefined
          ? { latitude: input.latitude, longitude: input.longitude as number }
          : {}),
        ...(input.accuracyMeters !== undefined ? { accuracyMeters: input.accuracyMeters } : {}),
        ...(input.speedKph !== undefined ? { speedKph: input.speedKph } : {}),
        ...(input.headingDegrees !== undefined ? { headingDegrees: input.headingDegrees } : {}),
        ...(input.label ? { label: input.label } : {}),
        createdByIdentityId: actor.identityId,
      },
      { actor, action: 'TRACKING_OBSERVATION_RECORDED' },
    );
  }

  async recordCrewCheckpoint(
    actor: AuthPrincipal,
    rawTripReference: string,
    input: CrewCheckpointInput,
  ) {
    this.assertTimestamp(input.occurredAt);
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
    if (!trip || (trip.status !== 'SCHEDULED' && trip.status !== 'IN_PROGRESS')) {
      throw TrackingErrors.crewUnavailable();
    }

    const assignment = trip.crewAssignments[0];
    if (!assignment) throw TrackingErrors.crewUnavailable();

    const device = await this.database.client.crewDevice.findFirst({
      where: {
        deviceId: input.deviceId,
        identityId: actor.identityId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!device) throw TrackingErrors.crewDeviceUnavailable();

    await this.assertWaypoint(trip.id, input.routeWaypointId);

    const payloadFingerprint = stableFingerprint([
      trip.id,
      'CREW',
      input.occurredAt.toISOString(),
      input.routeWaypointId,
      input.deviceId,
      actor.identityId,
    ]);

    return this.persistObservation({
      tripId: trip.id,
      source: 'CREW',
      observedAt: input.occurredAt,
      payloadFingerprint,
      clientEventId: input.clientEventId,
      routeWaypointId: input.routeWaypointId,
      createdByIdentityId: actor.identityId,
      crewAssignmentId: assignment.id,
      crewDeviceId: device.id,
    });
  }

  async ingestGps(
    tripId: string,
    providerKey: string,
    externalDeviceId: string,
    position: GpsProviderPosition,
  ) {
    this.assertTimestamp(position.observedAt);
    const config = await this.database.client.tripTrackingConfig.findFirst({
      where: {
        tripId,
        enabled: true,
        trackingDevice: {
          providerKey,
          externalId: externalDeviceId,
          active: true,
        },
      },
      select: { tripId: true },
    });
    if (!config) throw TrackingErrors.deviceMismatch();

    const payloadFingerprint = stableFingerprint([
      tripId,
      providerKey,
      externalDeviceId,
      position.providerObservationId,
      position.observedAt.toISOString(),
      position.latitude,
      position.longitude,
      position.accuracyMeters ?? null,
      position.speedKph ?? null,
      position.headingDegrees ?? null,
    ]);

    return this.persistObservation({
      tripId,
      source: 'GPS',
      observedAt: position.observedAt,
      payloadFingerprint,
      providerKey,
      providerDeviceId: externalDeviceId,
      providerObservationId: position.providerObservationId,
      latitude: position.latitude,
      longitude: position.longitude,
      ...(position.accuracyMeters !== undefined ? { accuracyMeters: position.accuracyMeters } : {}),
      ...(position.speedKph !== undefined ? { speedKph: position.speedKph } : {}),
      ...(position.headingDegrees !== undefined ? { headingDegrees: position.headingDegrees } : {}),
    });
  }

  async issuePublicToken(actor: AuthPrincipal, tripId: string, expiresAt?: Date) {
    const now = new Date();
    if (expiresAt && expiresAt <= now) throw TrackingErrors.tokenExpiryInvalid();

    const token = secureRandomToken();
    return this.database.client.$transaction(async (tx) => {
      const config = await tx.tripTrackingConfig.findUnique({
        where: { tripId },
        select: { tripId: true },
      });
      if (!config) throw TrackingErrors.tripNotFound();

      const row = await tx.trackingPublicToken.create({
        data: {
          tripId,
          tokenHash: hashOpaqueToken(token),
          createdByIdentityId: actor.identityId,
          ...(expiresAt ? { expiresAt } : {}),
        },
        select: { id: true, createdAt: true, expiresAt: true },
      });

      await this.audit.record(
        {
          actor,
          action: 'TRACKING_PUBLIC_TOKEN_ISSUED',
          resourceType: 'tracking_public_token',
          resourceId: row.id,
          metadata: { tripId, expiresAt: row.expiresAt?.toISOString() ?? null },
        },
        tx,
      );
      return { ...row, token };
    });
  }

  async revokePublicToken(actor: AuthPrincipal, tripId: string, tokenId: string, reason: string) {
    return this.database.client.$transaction(async (tx) => {
      const current = await tx.trackingPublicToken.findFirst({
        where: { id: tokenId, tripId },
        select: { id: true, revokedAt: true, expiresAt: true, createdAt: true },
      });
      if (!current) throw TrackingErrors.tokenNotFound();
      if (current.revokedAt) return current;

      const row = await tx.trackingPublicToken.update({
        where: { id: tokenId },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          revocationReason: reason,
        },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          revocationReason: true,
        },
      });

      await this.audit.record(
        {
          actor,
          action: 'TRACKING_PUBLIC_TOKEN_REVOKED',
          resourceType: 'tracking_public_token',
          resourceId: row.id,
          metadata: { tripId, reason },
        },
        tx,
      );
      return row;
    });
  }

  private publicCheckpoint(tripId: string) {
    return this.database.client.trackingObservation.findFirst({
      where: {
        tripId,
        routeWaypointId: { not: null },
        source: { in: ['CHECKPOINT', 'CREW', 'OPS', 'SYSTEM'] },
      },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: {
        observedAt: true,
        label: true,
        routeWaypoint: {
          select: {
            sequence: true,
            stop: { select: { code: true, name: true } },
            checkpoint: { select: { code: true, name: true, type: true } },
          },
        },
      },
    });
  }

  async publicProjection(token: string) {
    if (!isWellFormedOpaqueToken(token)) throw TrackingErrors.tokenNotFound();

    const now = new Date();
    const capability = await this.database.client.trackingPublicToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        revokedAt: true,
        expiresAt: true,
        trip: {
          select: {
            id: true,
            reference: true,
            status: true,
            plannedDepartureAt: true,
            plannedArrivalAt: true,
            routeVersion: {
              select: { route: { select: { code: true, name: true } } },
            },
            trackingConfig: {
              select: {
                enabled: true,
                visibility: true,
                trackingDevice: {
                  select: { providerKey: true, externalId: true },
                },
              },
            },
          },
        },
      },
    });

    if (
      !capability ||
      capability.revokedAt ||
      (capability.expiresAt && capability.expiresAt <= now) ||
      !capability.trip.trackingConfig?.enabled ||
      capability.trip.trackingConfig.visibility === 'HIDDEN'
    ) {
      throw TrackingErrors.tokenNotFound();
    }

    const trip = capability.trip;
    const config = trip.trackingConfig;
    if (!config) throw TrackingErrors.tokenNotFound();
    const visibility: TrackingVisibility = config.visibility;

    const [checkpoint, position, providerStatus] = await Promise.all([
      this.publicCheckpoint(trip.id),
      visibility === 'APPROXIMATE' || visibility === 'PRECISE'
        ? this.database.client.trackingObservation.findFirst({
            where: {
              tripId: trip.id,
              latitude: { not: null },
              longitude: { not: null },
            },
            orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
            select: {
              observedAt: true,
              latitude: true,
              longitude: true,
              accuracyMeters: true,
            },
          })
        : Promise.resolve(null),
      this.providerStatus(trip.id, config.trackingDevice),
    ]);

    const exactLat = numberOrNull(position?.latitude);
    const exactLng = numberOrNull(position?.longitude);
    const publicPosition =
      position && exactLat !== null && exactLng !== null
        ? {
            observedAt: position.observedAt,
            latitude: visibility === 'APPROXIMATE' ? approximate(exactLat) : exactLat,
            longitude: visibility === 'APPROXIMATE' ? approximate(exactLng) : exactLng,
            precision:
              visibility === 'APPROXIMATE' ? ('APPROXIMATE' as const) : ('PRECISE' as const),
            ...(visibility === 'PRECISE'
              ? { accuracyMeters: numberOrNull(position.accuracyMeters) }
              : {}),
          }
        : null;

    const checkpointProjection = checkpointView(checkpoint);
    const lastUpdatedAt =
      [checkpointProjection?.observedAt, publicPosition?.observedAt]
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    return {
      tripReference: trip.reference,
      tripStatus: trip.status,
      route: trip.routeVersion.route,
      plannedDepartureAt: trip.plannedDepartureAt,
      plannedArrivalAt: trip.plannedArrivalAt,
      visibility,
      providerStatus,
      lastUpdatedAt,
      checkpoint: checkpointProjection,
      position: publicPosition,
    };
  }
}
