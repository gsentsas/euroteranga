import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import {
  hashOpaqueToken,
  isWellFormedOpaqueToken,
  secureRandomToken,
} from '../auth/crypto/tokens.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  CargoTrackingTokenCreateInput,
  CargoTrackingTokenRevokeInput,
} from './cargo-tracking.dto.js';
import { CargoTrackingErrors } from './cargo-tracking.errors.js';
import { publicCargoTrackingStatus } from './cargo-tracking-rules.js';
import { CargoErrors } from './cargo.errors.js';
import { normalizeCargoReference } from './cargo-rules.js';

function tokenConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CargoTrackingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async shipmentId(rawReference: string): Promise<{ id: string; reference: string }> {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    const shipment = await this.database.client.roadFreightShipment.findUnique({
      where: { reference },
      select: { id: true, reference: true },
    });
    if (!shipment) throw CargoErrors.notFound();
    return shipment;
  }

  async listTokens(actor: AuthPrincipal, rawReference: string) {
    const shipment = await this.shipmentId(rawReference);
    const rows = await this.database.client.roadFreightPublicToken.findMany({
      where: { shipmentId: shipment.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        revocationReason: true,
      },
    });

    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_TRACKING_TOKENS_ACCESSED',
          resourceType: 'road_freight_shipment',
          resourceId: shipment.id,
          metadata: {
            shipmentReference: shipment.reference,
            tokenIds: rows.map((row) => row.id),
          },
        },
        tx,
      ),
    );

    return { items: rows };
  }

  async issueToken(
    actor: AuthPrincipal,
    rawReference: string,
    input: CargoTrackingTokenCreateInput,
  ) {
    const shipment = await this.shipmentId(rawReference);
    const now = new Date();
    if (input.expiresAt && input.expiresAt <= now) throw CargoTrackingErrors.expiryInvalid();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = secureRandomToken();
      try {
        return await this.database.client.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "road_freight_shipment"
            WHERE "id" = ${shipment.id}::uuid
            FOR SHARE
          `;
          if (!locked[0]) throw CargoErrors.notFound();

          const row = await tx.roadFreightPublicToken.create({
            data: {
              shipmentId: shipment.id,
              tokenHash: hashOpaqueToken(token),
              createdByIdentityId: actor.identityId,
              ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            },
            select: { id: true, createdAt: true, expiresAt: true },
          });

          await this.audit.record(
            {
              actor,
              action: 'ROAD_FREIGHT_TRACKING_TOKEN_ISSUED',
              resourceType: 'road_freight_public_token',
              resourceId: row.id,
              metadata: {
                shipmentReference: shipment.reference,
                expiresAt: row.expiresAt?.toISOString() ?? null,
              },
            },
            tx,
          );

          return { ...row, token };
        });
      } catch (error) {
        if (attempt < 2 && tokenConflict(error)) continue;
        throw error;
      }
    }
    throw new Error('unreachable');
  }

  async revokeToken(
    actor: AuthPrincipal,
    rawReference: string,
    tokenId: string,
    input: CargoTrackingTokenRevokeInput,
  ) {
    const shipment = await this.shipmentId(rawReference);
    return this.database.client.$transaction(async (tx) => {
      const current = await tx.roadFreightPublicToken.findFirst({
        where: { id: tokenId, shipmentId: shipment.id },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          revocationReason: true,
        },
      });
      if (!current) throw CargoTrackingErrors.notFound();
      if (current.revokedAt) return current;

      const row = await tx.roadFreightPublicToken.update({
        where: { id: current.id },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          revocationReason: input.reason,
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
          action: 'ROAD_FREIGHT_TRACKING_TOKEN_REVOKED',
          resourceType: 'road_freight_public_token',
          resourceId: row.id,
          metadata: {
            shipmentReference: shipment.reference,
            reason: input.reason,
          },
        },
        tx,
      );

      return row;
    });
  }

  async publicProjection(token: string) {
    if (!isWellFormedOpaqueToken(token)) throw CargoTrackingErrors.notFound();
    const now = new Date();

    const capability = await this.database.client.roadFreightPublicToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        revokedAt: true,
        expiresAt: true,
        shipment: {
          select: {
            reference: true,
            direction: true,
            lifecycleStatus: true,
            exceptionStatus: true,
            packageCount: true,
            updatedAt: true,
            trip: {
              select: {
                status: true,
                plannedDepartureAt: true,
                plannedArrivalAt: true,
                routeVersion: {
                  select: {
                    route: { select: { code: true, name: true } },
                  },
                },
              },
            },
            events: {
              take: 1,
              orderBy: { sequence: 'desc' },
              select: {
                occurredAt: true,
                recordedAt: true,
              },
            },
          },
        },
      },
    });

    if (
      !capability ||
      capability.revokedAt ||
      (capability.expiresAt && capability.expiresAt <= now)
    ) {
      throw CargoTrackingErrors.notFound();
    }

    const shipment = capability.shipment;
    const lastLocation = await this.database.client.roadFreightShipmentEvent.findFirst({
      where: {
        shipment: { reference: shipment.reference },
        routeWaypointId: { not: null },
      },
      orderBy: { sequence: 'desc' },
      select: {
        occurredAt: true,
        routeWaypoint: {
          select: {
            sequence: true,
            stop: { select: { code: true, name: true } },
            checkpoint: { select: { code: true, name: true, type: true } },
          },
        },
      },
    });

    const place =
      lastLocation?.routeWaypoint?.stop ?? lastLocation?.routeWaypoint?.checkpoint ?? null;
    const latestEvent = shipment.events[0] ?? null;

    return {
      reference: shipment.reference,
      direction: shipment.direction,
      status: publicCargoTrackingStatus(shipment.lifecycleStatus, shipment.exceptionStatus),
      packageCount: shipment.packageCount,
      trip: shipment.trip
        ? {
            status: shipment.trip.status,
            route: shipment.trip.routeVersion.route,
            plannedDepartureAt: shipment.trip.plannedDepartureAt,
            plannedArrivalAt: shipment.trip.plannedArrivalAt,
          }
        : null,
      lastUpdatedAt: latestEvent?.occurredAt ?? shipment.updatedAt,
      location:
        place && lastLocation
          ? {
              sequence: lastLocation.routeWaypoint?.sequence ?? null,
              kind: lastLocation.routeWaypoint?.stop
                ? ('STOP' as const)
                : ('CHECKPOINT' as const),
              code: place.code,
              name: place.name,
              observedAt: lastLocation.occurredAt,
            }
          : null,
    };
  }
}
