import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  CargoAssignmentInput,
  CargoCreateInput,
  CargoEventInput,
  CargoListQuery,
  CargoUpdateInput,
} from './cargo.dto.js';
import { CargoErrors } from './cargo.errors.js';
import {
  cargoEventFingerprint,
  CargoTransitionError,
  normalizeCargoReference,
  projectCargoEvent,
  withFreshCargoReference,
} from './cargo-rules.js';
import {
  cargoDetailInclude,
  cargoDetailView,
  cargoEventSelect,
  cargoEventView,
  cargoSummaryInclude,
  cargoSummaryView,
} from './cargo-views.js';

const THIRTY_DAYS = 30 * 24 * 3_600_000;
const FIVE_MINUTES = 5 * 60_000;

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function databaseDomainError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') throw CargoErrors.notFound();
    if (error.code === 'P2002') throw CargoErrors.referenceConflict();
  }
  const message = String(error);
  if (message.includes('road freight capacity exceeded')) throw CargoErrors.capacityExceeded();
  if (message.includes('road freight customer identity must be CUSTOMER')) {
    throw CargoErrors.customerNotFound();
  }
  if (message.includes('road freight booking customer mismatch')) {
    throw CargoErrors.customerMismatch();
  }
  if (
    message.includes('road freight assignment') ||
    message.includes('road freight direction') ||
    message.includes('assigned cargo vehicle') ||
    message.includes('booking trip must match')
  ) {
    throw CargoErrors.assignmentInvalid();
  }
  if (message.includes('road freight details are frozen')) throw CargoErrors.frozen();
  if (
    message.includes('road freight lifecycle') ||
    message.includes('road freight exception') ||
    message.includes('road freight event projection') ||
    message.includes('road freight projection mismatch')
  ) {
    throw CargoErrors.invalidTransition();
  }
  if (message.includes('road freight event waypoint')) throw CargoErrors.invalidLocation();
  if (message.includes('road freight event occurred_at')) throw CargoErrors.invalidTimestamp();
  throw error;
}

async function lockedShipmentId(tx: DatabaseTransaction, reference: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "road_freight_shipment"
    WHERE "reference" = ${reference}
    FOR UPDATE
  `;
  if (!rows[0]) throw CargoErrors.notFound();
  return rows[0].id;
}

function checkEventTime(occurredAt: Date): void {
  const now = Date.now();
  if (occurredAt.getTime() < now - THIRTY_DAYS || occurredAt.getTime() > now + FIVE_MINUTES) {
    throw CargoErrors.invalidTimestamp();
  }
}

function safeSnapshot(row: {
  weightKg: Prisma.Decimal;
  volumeLiters: number;
  packageCount: number;
  fragile: boolean;
  professional: boolean;
  pickupRequired: boolean;
  deliveryRequired: boolean;
}) {
  return {
    weightKg: row.weightKg.toFixed(3),
    volumeLiters: row.volumeLiters,
    packageCount: row.packageCount,
    fragile: row.fragile,
    professional: row.professional,
    pickupRequired: row.pickupRequired,
    deliveryRequired: row.deliveryRequired,
  };
}

@Injectable()
export class CargoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  async create(actor: AuthPrincipal, input: CargoCreateInput) {
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);
    let reference: string;
    try {
      reference = await withFreshCargoReference(
        (candidate) =>
          this.database.client.$transaction(async (tx) => {
            const [booking, customer] = await Promise.all([
              input.bookingReference
                ? tx.booking.findUnique({
                    where: { reference: input.bookingReference },
                    select: { id: true, customerIdentityId: true },
                  })
                : null,
              input.customerIdentityId
                ? tx.authIdentity.findUnique({
                    where: { id: input.customerIdentityId },
                    select: { id: true, realm: true },
                  })
                : null,
            ]);
            if (input.bookingReference && !booking) throw CargoErrors.bookingNotFound();
            if (input.customerIdentityId && (!customer || customer.realm !== 'CUSTOMER')) {
              throw CargoErrors.customerNotFound();
            }
            if (booking && customer && booking.customerIdentityId !== customer.id) {
              throw CargoErrors.customerMismatch();
            }
            const customerIdentityId = booking?.customerIdentityId ?? customer?.id ?? null;

            const shipment = await tx.roadFreightShipment.create({
              data: {
                reference: candidate,
                direction: input.direction,
                bookingId: booking?.id ?? null,
                customerIdentityId,
                senderName: input.senderName,
                senderContact: input.senderContact,
                recipientName: input.recipientName,
                recipientContact: input.recipientContact,
                weightKg: input.weightKg,
                volumeLiters: input.volumeLiters,
                packageCount: input.packageCount,
                lengthCm: input.dimensionsCm?.length ?? null,
                widthCm: input.dimensionsCm?.width ?? null,
                heightCm: input.dimensionsCm?.height ?? null,
                declaredContents: input.declaredContents,
                declaredValueMinor: input.declaredValue
                  ? BigInt(input.declaredValue.amountMinor)
                  : null,
                declaredValueCurrencyCode: input.declaredValue?.currencyCode ?? null,
                declaredValueCurrencyMinorUnit: input.declaredValue?.currencyMinorUnit ?? null,
                fragile: input.fragile,
                professional: input.professional,
                pickupRequired: input.pickupRequired,
                deliveryRequired: input.deliveryRequired,
              },
              select: { id: true },
            });
            const occurredAt = new Date();
            await tx.roadFreightShipmentEvent.create({
              data: {
                shipmentId: shipment.id,
                sequence: 1,
                type: 'QUOTE',
                lifecycleStatus: 'QUOTE',
                occurredAt,
                actorIdentityId: actor.identityId,
                payloadFingerprint: cargoEventFingerprint({
                  type: 'QUOTE',
                  occurredAt,
                  routeWaypointId: null,
                  tripId: null,
                  vehicleId: null,
                }),
              },
            });
            await this.audit.record(
              {
                actor,
                action: 'ROAD_FREIGHT_CREATED',
                resourceType: 'road_freight_shipment',
                resourceId: shipment.id,
                after: {
                  reference: candidate,
                  direction: input.direction,
                  bookingReference: input.bookingReference ?? null,
                  customerIdentityId,
                  weightKg: input.weightKg,
                  volumeLiters: input.volumeLiters,
                  packageCount: input.packageCount,
                  lifecycleStatus: 'QUOTE',
                },
              },
              tx,
            );
            return candidate;
          }),
        uniqueViolation,
      );
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      return databaseDomainError(error);
    }
    return this.detail(actor, reference, 'CREATE_RESULT');
  }

  async list(actor: AuthPrincipal, query: CargoListQuery) {
    const where: Prisma.RoadFreightShipmentWhereInput = {
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      ...(query.reference ? { reference: query.reference } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.lifecycleStatus ? { lifecycleStatus: query.lifecycleStatus } : {}),
      ...(query.exceptionStatus ? { exceptionStatus: query.exceptionStatus } : {}),
      ...(query.bookingReference ? { booking: { reference: query.bookingReference } } : {}),
      ...(query.tripReference ? { trip: { reference: query.tripReference } } : {}),
      ...(query.vehicleCode ? { vehicle: { code: query.vehicleCode } } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lt: query.createdTo } : {}),
            },
          }
        : {}),
    };
    const rows = await this.database.client.roadFreightShipment.findMany({
      where,
      take: query.limit + 1,
      orderBy: { id: 'desc' },
      include: cargoSummaryInclude,
    });
    const page = rows.slice(0, query.limit);
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_ACCESSED',
          resourceType: 'road_freight_shipment',
          metadata: {
            access: 'LIST',
            references: page.map((row) => row.reference),
            filters: {
              reference: query.reference ?? null,
              direction: query.direction ?? null,
              lifecycleStatus: query.lifecycleStatus ?? null,
              exceptionStatus: query.exceptionStatus ?? null,
              bookingReference: query.bookingReference ?? null,
              tripReference: query.tripReference ?? null,
              vehicleCode: query.vehicleCode ?? null,
            },
          },
        },
        tx,
      ),
    );
    return {
      items: page.map(cargoSummaryView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(actor: AuthPrincipal, rawReference: string, access = 'DETAIL') {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    const row = await this.database.client.roadFreightShipment.findUnique({
      where: { reference },
      include: cargoDetailInclude,
    });
    if (!row) throw CargoErrors.notFound();
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_ACCESSED',
          resourceType: 'road_freight_shipment',
          resourceId: row.id,
          metadata: { access, reference },
        },
        tx,
      ),
    );
    return cargoDetailView(row);
  }

  async update(actor: AuthPrincipal, rawReference: string, input: CargoUpdateInput) {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);
    try {
      await this.database.client.$transaction(async (tx) => {
        const id = await lockedShipmentId(tx, reference);
        const before = await tx.roadFreightShipment.findUniqueOrThrow({ where: { id } });
        if (
          input.expectedUpdatedAt &&
          before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
        ) {
          throw CargoErrors.conflict();
        }
        const changedFields = Object.keys(input).filter((key) => key !== 'expectedUpdatedAt');
        const after = await tx.roadFreightShipment.update({
          where: { id },
          data: {
            ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
            ...(input.senderContact !== undefined ? { senderContact: input.senderContact } : {}),
            ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
            ...(input.recipientContact !== undefined
              ? { recipientContact: input.recipientContact }
              : {}),
            ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
            ...(input.volumeLiters !== undefined ? { volumeLiters: input.volumeLiters } : {}),
            ...(input.packageCount !== undefined ? { packageCount: input.packageCount } : {}),
            ...(input.dimensionsCm !== undefined
              ? {
                  lengthCm: input.dimensionsCm?.length ?? null,
                  widthCm: input.dimensionsCm?.width ?? null,
                  heightCm: input.dimensionsCm?.height ?? null,
                }
              : {}),
            ...(input.declaredContents !== undefined
              ? { declaredContents: input.declaredContents }
              : {}),
            ...(input.declaredValue !== undefined
              ? {
                  declaredValueMinor: input.declaredValue
                    ? BigInt(input.declaredValue.amountMinor)
                    : null,
                  declaredValueCurrencyCode: input.declaredValue?.currencyCode ?? null,
                  declaredValueCurrencyMinorUnit: input.declaredValue?.currencyMinorUnit ?? null,
                }
              : {}),
            ...(input.fragile !== undefined ? { fragile: input.fragile } : {}),
            ...(input.professional !== undefined ? { professional: input.professional } : {}),
            ...(input.pickupRequired !== undefined ? { pickupRequired: input.pickupRequired } : {}),
            ...(input.deliveryRequired !== undefined
              ? { deliveryRequired: input.deliveryRequired }
              : {}),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROAD_FREIGHT_UPDATED',
            resourceType: 'road_freight_shipment',
            resourceId: id,
            before: safeSnapshot(before),
            after: safeSnapshot(after),
            metadata: { reference, changedFields },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      return databaseDomainError(error);
    }
    return this.detail(actor, reference, 'UPDATE_RESULT');
  }

  async assign(actor: AuthPrincipal, rawReference: string, input: CargoAssignmentInput) {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);
    const occurredAt = input.occurredAt ?? new Date();
    checkEventTime(occurredAt);
    try {
      await this.database.client.$transaction(async (tx) => {
        const id = await lockedShipmentId(tx, reference);
        const shipment = await tx.roadFreightShipment.findUniqueOrThrow({
          where: { id },
          include: {
            trip: { select: { reference: true } },
            vehicle: { select: { code: true } },
          },
        });
        if (
          input.expectedTripReference !== undefined &&
          input.expectedTripReference !== (shipment.trip?.reference ?? null)
        ) {
          throw CargoErrors.conflict();
        }
        if (
          input.expectedVehicleCode !== undefined &&
          input.expectedVehicleCode !== (shipment.vehicle?.code ?? null)
        ) {
          throw CargoErrors.conflict();
        }
        if (
          !['INSPECTED', 'ASSIGNED'].includes(shipment.lifecycleStatus) ||
          shipment.exceptionStatus
        ) {
          throw CargoErrors.invalidTransition();
        }
        const [trip, vehicle] = await Promise.all([
          tx.trip.findUnique({ where: { reference: input.tripReference }, select: { id: true } }),
          tx.vehicle.findUnique({ where: { code: input.vehicleCode }, select: { id: true } }),
        ]);
        if (!trip || !vehicle) throw CargoErrors.assignmentTargetNotFound();

        const beforeAssignment = {
          tripReference: shipment.trip?.reference ?? null,
          vehicleCode: shipment.vehicle?.code ?? null,
        };
        await tx.roadFreightShipment.update({
          where: { id },
          data: { tripId: trip.id, vehicleId: vehicle.id },
        });

        const eventType =
          shipment.lifecycleStatus === 'INSPECTED' ? 'ASSIGNED' : 'ASSIGNMENT_UPDATED';
        const latest = await tx.roadFreightShipmentEvent.findFirst({
          where: { shipmentId: id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        await tx.roadFreightShipmentEvent.create({
          data: {
            shipmentId: id,
            sequence: (latest?.sequence ?? 0) + 1,
            type: eventType,
            lifecycleStatus: 'ASSIGNED',
            exceptionStatus: null,
            occurredAt,
            actorIdentityId: actor.identityId,
            tripId: trip.id,
            vehicleId: vehicle.id,
            payloadFingerprint: cargoEventFingerprint({
              type: eventType,
              occurredAt,
              routeWaypointId: null,
              tripId: trip.id,
              vehicleId: vehicle.id,
            }),
          },
        });
        if (shipment.lifecycleStatus === 'INSPECTED') {
          await tx.roadFreightShipment.update({
            where: { id },
            data: { lifecycleStatus: 'ASSIGNED' },
          });
        }
        await this.audit.record(
          {
            actor,
            action:
              shipment.lifecycleStatus === 'INSPECTED'
                ? 'ROAD_FREIGHT_ASSIGNED'
                : 'ROAD_FREIGHT_ASSIGNMENT_CHANGED',
            resourceType: 'road_freight_shipment',
            resourceId: id,
            before: beforeAssignment,
            after: { tripReference: input.tripReference, vehicleCode: input.vehicleCode },
            metadata: { reference },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      return databaseDomainError(error);
    }
    return this.detail(actor, reference, 'ASSIGNMENT_RESULT');
  }

  async recordEvent(actor: AuthPrincipal, rawReference: string, input: CargoEventInput) {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);
    const occurredAt = input.occurredAt ?? new Date();
    checkEventTime(occurredAt);
    const routeWaypointId = input.routeWaypointId ?? null;
    try {
      return await this.database.client.$transaction(async (tx) => {
        const id = await lockedShipmentId(tx, reference);
        const shipment = await tx.roadFreightShipment.findUniqueOrThrow({ where: { id } });
        const fingerprint = cargoEventFingerprint({
          type: input.type,
          occurredAt,
          routeWaypointId,
          tripId: shipment.tripId,
          vehicleId: shipment.vehicleId,
        });
        if (input.clientEventId) {
          const replay = await tx.roadFreightShipmentEvent.findFirst({
            where: { shipmentId: id, clientEventId: input.clientEventId },
            select: { ...cargoEventSelect, payloadFingerprint: true },
          });
          if (replay) {
            if (replay.payloadFingerprint !== fingerprint) throw CargoErrors.idempotencyConflict();
            const { payloadFingerprint: _payloadFingerprint, ...event } = replay;
            return { created: false, event: cargoEventView(event) };
          }
        }

        let projection;
        try {
          projection = projectCargoEvent(
            {
              lifecycleStatus: shipment.lifecycleStatus,
              exceptionStatus: shipment.exceptionStatus,
            },
            input.type,
          );
        } catch (error) {
          if (error instanceof CargoTransitionError) throw CargoErrors.invalidTransition();
          throw error;
        }

        const latest = await tx.roadFreightShipmentEvent.findFirst({
          where: { shipmentId: id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const event = await tx.roadFreightShipmentEvent.create({
          data: {
            shipmentId: id,
            sequence: (latest?.sequence ?? 0) + 1,
            type: input.type,
            lifecycleStatus: projection.lifecycleStatus,
            exceptionStatus: projection.exceptionStatus,
            occurredAt,
            actorIdentityId: actor.identityId,
            routeWaypointId,
            tripId: shipment.tripId,
            vehicleId: shipment.vehicleId,
            ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
            payloadFingerprint: fingerprint,
          },
          select: cargoEventSelect,
        });
        await tx.roadFreightShipment.update({
          where: { id },
          data: {
            lifecycleStatus: projection.lifecycleStatus,
            exceptionStatus: projection.exceptionStatus,
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROAD_FREIGHT_EVENT_RECORDED',
            resourceType: 'road_freight_shipment',
            resourceId: id,
            metadata: {
              reference,
              event: input.type,
              sequence: event.sequence,
              lifecycleStatus: projection.lifecycleStatus,
              exceptionStatus: projection.exceptionStatus,
            },
          },
          tx,
        );
        return { created: true, event: cargoEventView(event) };
      });
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      return databaseDomainError(error);
    }
  }
}
