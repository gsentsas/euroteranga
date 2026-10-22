import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  cargoQuoteTotal,
  normalizeCargoQuoteReference,
  withFreshCargoQuoteReference,
} from './cargo-quote-rules.js';
import type {
  CargoQuoteCancelInput,
  CargoQuoteCreateInput,
  CargoQuoteLinesInput,
  CargoQuoteTransitionInput,
} from './cargo-quote.dto.js';
import { CargoQuoteErrors } from './cargo-quote.errors.js';
import { cargoQuoteInclude, cargoQuoteView } from './cargo-quote-views.js';
import { CargoErrors } from './cargo.errors.js';
import { normalizeCargoReference } from './cargo-rules.js';

function quoteReferenceCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('reference')
  );
}

function databaseQuoteError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') throw CargoQuoteErrors.notFound();
    if (error.code === 'P2002') {
      const metadata = JSON.stringify(error.meta ?? {});
      if (metadata.includes('one_draft') || metadata.includes('shipment_id')) {
        throw CargoQuoteErrors.draftExists();
      }
      throw CargoQuoteErrors.referenceConflict();
    }
  }
  const message = String(error);
  if (message.includes('accepted road freight quote blocks new issue')) {
    throw CargoQuoteErrors.acceptedBlocksIssue();
  }
  if (message.includes('road freight quote total cannot be negative')) {
    throw CargoQuoteErrors.negativeTotal();
  }
  if (message.includes('road freight quote lines must be contiguous')) {
    throw CargoQuoteErrors.invalidLines();
  }
  if (
    message.includes('road freight quote lines are frozen') ||
    message.includes('terminal road freight quote is immutable')
  ) {
    throw CargoQuoteErrors.frozen();
  }
  if (
    message.includes('invalid road freight quote transition') ||
    message.includes('road freight quote must start DRAFT')
  ) {
    throw CargoQuoteErrors.invalidTransition();
  }
  if (
    message.includes('road freight quote snapshot mismatch') ||
    message.includes('road freight quote version is not next')
  ) {
    throw CargoQuoteErrors.conflict();
  }
  throw error;
}

async function lockedShipment(
  tx: DatabaseTransaction,
  reference: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "road_freight_shipment"
    WHERE "reference" = ${reference}
    FOR UPDATE
  `;
  const id = rows[0]?.id;
  if (!id) throw CargoErrors.notFound();
  return tx.roadFreightShipment.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      direction: true,
      weightKg: true,
      volumeLiters: true,
      packageCount: true,
      fragile: true,
      professional: true,
      pickupRequired: true,
      deliveryRequired: true,
      updatedAt: true,
    },
  });
}

async function lockedQuote(
  tx: DatabaseTransaction,
  shipmentId: string,
  reference: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "road_freight_quote"
    WHERE "shipment_id" = ${shipmentId}::uuid
      AND "reference" = ${reference}
    FOR UPDATE
  `;
  const id = rows[0]?.id;
  if (!id) throw CargoQuoteErrors.notFound();
  return tx.roadFreightQuote.findUniqueOrThrow({
    where: { id },
    include: cargoQuoteInclude,
  });
}

function checkExpectedUpdatedAt(actual: Date, expected?: Date) {
  if (expected && actual.getTime() !== expected.getTime()) throw CargoQuoteErrors.conflict();
}

function safeQuoteAudit(quote: {
  reference: string;
  version: number;
  status: string;
  currencyCode: string;
  currencyMinorUnit: number;
  updatedAt: Date;
}) {
  return {
    reference: quote.reference,
    version: quote.version,
    status: quote.status,
    currencyCode: quote.currencyCode,
    currencyMinorUnit: quote.currencyMinorUnit,
    updatedAt: quote.updatedAt,
  };
}

@Injectable()
export class CargoQuoteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  async list(actor: AuthPrincipal, rawShipmentReference: string) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    const shipment = await this.database.client.roadFreightShipment.findUnique({
      where: { reference: shipmentReference },
      select: { id: true },
    });
    if (!shipment) throw CargoErrors.notFound();

    const rows = await this.database.client.roadFreightQuote.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { version: 'desc' },
      include: cargoQuoteInclude,
    });
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_QUOTE_ACCESSED',
          resourceType: 'road_freight_shipment',
          resourceId: shipment.id,
          metadata: {
            access: 'LIST',
            shipmentReference,
            quoteReferences: rows.map((row) => row.reference),
          },
        },
        tx,
      ),
    );
    return { items: rows.map(cargoQuoteView) };
  }

  async detail(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    access = 'DETAIL',
  ) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    const quoteReference = normalizeCargoQuoteReference(rawQuoteReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    if (!quoteReference) throw CargoQuoteErrors.notFound();

    const row = await this.database.client.roadFreightQuote.findFirst({
      where: { reference: quoteReference, shipment: { reference: shipmentReference } },
      include: cargoQuoteInclude,
    });
    if (!row) throw CargoQuoteErrors.notFound();
    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_QUOTE_ACCESSED',
          resourceType: 'road_freight_quote',
          resourceId: row.id,
          metadata: { access, shipmentReference, quoteReference },
        },
        tx,
      ),
    );
    return cargoQuoteView(row);
  }

  async create(actor: AuthPrincipal, rawShipmentReference: string, input: CargoQuoteCreateInput) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    let totalMinor: bigint;
    try {
      totalMinor = cargoQuoteTotal(input.lines);
    } catch {
      throw CargoQuoteErrors.negativeTotal();
    }
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);

    let quoteReference: string;
    try {
      quoteReference = await withFreshCargoQuoteReference(
        (candidate) =>
          this.database.client.$transaction(async (tx) => {
            const shipment = await lockedShipment(tx, shipmentReference);
            if (
              await tx.roadFreightQuote.findFirst({
                where: { shipmentId: shipment.id, status: 'DRAFT' },
                select: { id: true },
              })
            ) {
              throw CargoQuoteErrors.draftExists();
            }
            const latest = await tx.roadFreightQuote.findFirst({
              where: { shipmentId: shipment.id },
              orderBy: { version: 'desc' },
              select: { version: true },
            });
            const version = (latest?.version ?? 0) + 1;
            const quote = await tx.roadFreightQuote.create({
              data: {
                reference: candidate,
                shipmentId: shipment.id,
                version,
                currencyCode: input.currencyCode,
                currencyMinorUnit: input.currencyMinorUnit,
                snapshotDirection: shipment.direction,
                snapshotWeightKg: shipment.weightKg,
                snapshotVolumeLiters: shipment.volumeLiters,
                snapshotPackageCount: shipment.packageCount,
                snapshotFragile: shipment.fragile,
                snapshotProfessional: shipment.professional,
                snapshotPickupRequired: shipment.pickupRequired,
                snapshotDeliveryRequired: shipment.deliveryRequired,
                shipmentUpdatedAt: shipment.updatedAt,
                createdByIdentityId: actor.identityId,
                lines: {
                  create: input.lines.map((line, position) => ({
                    kind: line.kind,
                    label: line.label,
                    amountMinor: BigInt(line.amountMinor),
                    notes: line.notes ?? null,
                    position,
                  })),
                },
              },
              include: cargoQuoteInclude,
            });
            await this.audit.record(
              {
                actor,
                action: 'ROAD_FREIGHT_QUOTE_CREATED',
                resourceType: 'road_freight_quote',
                resourceId: quote.id,
                after: {
                  reference: candidate,
                  version,
                  status: 'DRAFT',
                  currencyCode: input.currencyCode,
                  currencyMinorUnit: input.currencyMinorUnit,
                  lineCount: input.lines.length,
                  totalMinor: totalMinor.toString(),
                },
                metadata: { shipmentReference },
              },
              tx,
            );
            return candidate;
          }),
        quoteReferenceCollision,
      );
    } catch (error) {
      return databaseQuoteError(error);
    }
    return this.detail(actor, shipmentReference, quoteReference, 'CREATE_RESULT');
  }

  async replaceLines(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteLinesInput,
  ) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    const quoteReference = normalizeCargoQuoteReference(rawQuoteReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    if (!quoteReference) throw CargoQuoteErrors.notFound();
    let totalMinor: bigint;
    try {
      totalMinor = cargoQuoteTotal(input.lines);
    } catch {
      throw CargoQuoteErrors.negativeTotal();
    }
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);

    try {
      await this.database.client.$transaction(async (tx) => {
        const shipment = await lockedShipment(tx, shipmentReference);
        const before = await lockedQuote(tx, shipment.id, quoteReference);
        checkExpectedUpdatedAt(before.updatedAt, input.expectedUpdatedAt);
        if (before.status !== 'DRAFT') throw CargoQuoteErrors.frozen();

        await tx.roadFreightQuoteLine.deleteMany({ where: { quoteId: before.id } });
        await tx.roadFreightQuoteLine.createMany({
          data: input.lines.map((line, position) => ({
            quoteId: before.id,
            kind: line.kind,
            label: line.label,
            amountMinor: BigInt(line.amountMinor),
            notes: line.notes ?? null,
            position,
          })),
        });
        const after = await tx.roadFreightQuote.update({
          where: { id: before.id },
          data: { updatedAt: new Date() },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROAD_FREIGHT_QUOTE_LINES_REPLACED',
            resourceType: 'road_freight_quote',
            resourceId: before.id,
            before: { lineCount: before.lines.length },
            after: { lineCount: input.lines.length, totalMinor: totalMinor.toString() },
            metadata: { shipmentReference, quoteReference },
          },
          tx,
        );
        void after;
      });
    } catch (error) {
      return databaseQuoteError(error);
    }
    return this.detail(actor, shipmentReference, quoteReference, 'UPDATE_RESULT');
  }

  async issue(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteTransitionInput,
  ) {
    return this.transition(
      actor,
      rawShipmentReference,
      rawQuoteReference,
      input,
      'ISSUED',
      'ROAD_FREIGHT_QUOTE_ISSUED',
    );
  }

  async accept(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteTransitionInput,
  ) {
    return this.transition(
      actor,
      rawShipmentReference,
      rawQuoteReference,
      input,
      'ACCEPTED',
      'ROAD_FREIGHT_QUOTE_ACCEPTED',
    );
  }

  async cancel(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteCancelInput,
  ) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    const quoteReference = normalizeCargoQuoteReference(rawQuoteReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    if (!quoteReference) throw CargoQuoteErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);

    try {
      await this.database.client.$transaction(async (tx) => {
        const shipment = await lockedShipment(tx, shipmentReference);
        const before = await lockedQuote(tx, shipment.id, quoteReference);
        checkExpectedUpdatedAt(before.updatedAt, input.expectedUpdatedAt);
        if (!['DRAFT', 'ISSUED'].includes(before.status)) {
          throw CargoQuoteErrors.invalidTransition();
        }
        const after = await tx.roadFreightQuote.update({
          where: { id: before.id },
          data: {
            status: 'CANCELLED',
            cancelledByIdentityId: actor.identityId,
            cancelledAt: new Date(),
          },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROAD_FREIGHT_QUOTE_CANCELLED',
            resourceType: 'road_freight_quote',
            resourceId: before.id,
            before: safeQuoteAudit(before),
            after: safeQuoteAudit(after),
            metadata: { shipmentReference, quoteReference, reason: input.reason },
          },
          tx,
        );
      });
    } catch (error) {
      return databaseQuoteError(error);
    }
    return this.detail(actor, shipmentReference, quoteReference, 'CANCEL_RESULT');
  }

  private async transition(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteTransitionInput,
    target: 'ISSUED' | 'ACCEPTED',
    action: 'ROAD_FREIGHT_QUOTE_ISSUED' | 'ROAD_FREIGHT_QUOTE_ACCEPTED',
  ) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    const quoteReference = normalizeCargoQuoteReference(rawQuoteReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    if (!quoteReference) throw CargoQuoteErrors.notFound();
    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);

    try {
      await this.database.client.$transaction(async (tx) => {
        const shipment = await lockedShipment(tx, shipmentReference);
        const before = await lockedQuote(tx, shipment.id, quoteReference);
        checkExpectedUpdatedAt(before.updatedAt, input.expectedUpdatedAt);

        if (target === 'ISSUED' && before.status !== 'DRAFT') {
          throw CargoQuoteErrors.invalidTransition();
        }
        if (target === 'ACCEPTED' && before.status !== 'ISSUED') {
          throw CargoQuoteErrors.invalidTransition();
        }

        const previousIssued =
          target === 'ISSUED'
            ? await tx.roadFreightQuote.findFirst({
                where: {
                  shipmentId: shipment.id,
                  status: 'ISSUED',
                  id: { not: before.id },
                },
              })
            : null;

        const now = new Date();
        const after = await tx.roadFreightQuote.update({
          where: { id: before.id },
          data:
            target === 'ISSUED'
              ? { status: 'ISSUED', issuedByIdentityId: actor.identityId, issuedAt: now }
              : { status: 'ACCEPTED', acceptedByIdentityId: actor.identityId, acceptedAt: now },
        });

        if (previousIssued) {
          const superseded = await tx.roadFreightQuote.findUniqueOrThrow({
            where: { id: previousIssued.id },
          });
          await this.audit.record(
            {
              actor,
              action: 'ROAD_FREIGHT_QUOTE_SUPERSEDED',
              resourceType: 'road_freight_quote',
              resourceId: previousIssued.id,
              before: safeQuoteAudit(previousIssued),
              after: safeQuoteAudit(superseded),
              metadata: { shipmentReference, replacementQuoteReference: quoteReference },
            },
            tx,
          );
        }

        await this.audit.record(
          {
            actor,
            action,
            resourceType: 'road_freight_quote',
            resourceId: before.id,
            before: safeQuoteAudit(before),
            after: safeQuoteAudit(after),
            metadata: { shipmentReference, quoteReference },
          },
          tx,
        );
      });
    } catch (error) {
      return databaseQuoteError(error);
    }
    return this.detail(actor, shipmentReference, quoteReference, `${target}_RESULT`);
  }
}
