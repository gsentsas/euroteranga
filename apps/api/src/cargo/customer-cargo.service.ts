import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../auth/rate-limit/rate-limit.service.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CargoQuoteErrors } from './cargo-quote.errors.js';
import { normalizeCargoQuoteReference } from './cargo-quote-rules.js';
import type { CargoQuoteTransitionInput } from './cargo-quote.dto.js';
import type { CustomerCargoCreateInput, CustomerCargoListQuery } from './cargo.dto.js';
import { CargoErrors } from './cargo.errors.js';
import { normalizeCargoReference } from './cargo-rules.js';
import { CargoService } from './cargo.service.js';
import { publicCargoTrackingStatus } from './cargo-tracking-rules.js';

const customerQuoteSelect = {
  reference: true,
  version: true,
  status: true,
  currencyCode: true,
  currencyMinorUnit: true,
  snapshotDirection: true,
  snapshotWeightKg: true,
  snapshotVolumeLiters: true,
  snapshotPackageCount: true,
  snapshotFragile: true,
  snapshotProfessional: true,
  snapshotPickupRequired: true,
  snapshotDeliveryRequired: true,
  shipmentUpdatedAt: true,
  lines: {
    orderBy: { position: 'asc' as const },
    select: {
      kind: true,
      label: true,
      amountMinor: true,
      position: true,
    },
  },
  issuedAt: true,
  acceptedAt: true,
  cancelledAt: true,
  supersededAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RoadFreightQuoteSelect;

const customerCargoSummarySelect = {
  id: true,
  reference: true,
  direction: true,
  lifecycleStatus: true,
  exceptionStatus: true,
  senderName: true,
  senderContact: true,
  recipientName: true,
  recipientContact: true,
  weightKg: true,
  volumeLiters: true,
  packageCount: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  declaredContents: true,
  declaredValueMinor: true,
  declaredValueCurrencyCode: true,
  declaredValueCurrencyMinorUnit: true,
  fragile: true,
  professional: true,
  pickupRequired: true,
  deliveryRequired: true,
  booking: { select: { reference: true } },
  trip: {
    select: {
      reference: true,
      status: true,
      plannedDepartureAt: true,
      plannedArrivalAt: true,
      routeVersion: { select: { route: { select: { code: true, name: true } } } },
    },
  },
  quotes: {
    where: { issuedAt: { not: null } },
    orderBy: { version: 'desc' as const },
    take: 1,
    select: customerQuoteSelect,
  },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RoadFreightShipmentSelect;

const customerCargoEventSelect = {
  sequence: true,
  lifecycleStatus: true,
  exceptionStatus: true,
  occurredAt: true,
  routeWaypoint: {
    select: {
      sequence: true,
      stop: { select: { code: true, name: true } },
      checkpoint: {
        select: { code: true, name: true, travellerVisible: true },
      },
    },
  },
} as const satisfies Prisma.RoadFreightShipmentEventSelect;

const customerCargoDetailSelect = {
  ...customerCargoSummarySelect,
  events: {
    orderBy: { sequence: 'asc' as const },
    select: customerCargoEventSelect,
  },
} as const satisfies Prisma.RoadFreightShipmentSelect;

type CustomerCargoSummaryRow = Prisma.RoadFreightShipmentGetPayload<{
  select: typeof customerCargoSummarySelect;
}>;
type CustomerCargoDetailRow = Prisma.RoadFreightShipmentGetPayload<{
  select: typeof customerCargoDetailSelect;
}>;
type CustomerCargoQuoteRow = Prisma.RoadFreightQuoteGetPayload<{
  select: typeof customerQuoteSelect;
}>;

function customerQuoteView(row: CustomerCargoQuoteRow) {
  let charges = 0n;
  let discounts = 0n;
  const lines = row.lines.map((line) => {
    if (line.kind === 'CHARGE') charges += line.amountMinor;
    else discounts += line.amountMinor;
    return {
      kind: line.kind,
      label: line.label,
      amountMinor: line.amountMinor.toString(),
      position: line.position,
    };
  });

  return {
    reference: row.reference,
    version: row.version,
    status: row.status,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    totalMinor: (charges - discounts).toString(),
    snapshot: {
      direction: row.snapshotDirection,
      weightKg: row.snapshotWeightKg.toFixed(3),
      volumeLiters: row.snapshotVolumeLiters,
      packageCount: row.snapshotPackageCount,
      fragile: row.snapshotFragile,
      professional: row.snapshotProfessional,
      pickupRequired: row.snapshotPickupRequired,
      deliveryRequired: row.snapshotDeliveryRequired,
      shipmentUpdatedAt: row.shipmentUpdatedAt,
    },
    lines,
    issuedAt: row.issuedAt,
    acceptedAt: row.acceptedAt,
    cancelledAt: row.cancelledAt,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function declaredValueView(row: CustomerCargoSummaryRow) {
  if (
    row.declaredValueMinor === null ||
    row.declaredValueCurrencyCode === null ||
    row.declaredValueCurrencyMinorUnit === null
  ) {
    return null;
  }
  return {
    amountMinor: row.declaredValueMinor.toString(),
    currencyCode: row.declaredValueCurrencyCode,
    currencyMinorUnit: row.declaredValueCurrencyMinorUnit,
  };
}

function customerCargoSummaryView(row: CustomerCargoSummaryRow) {
  return {
    reference: row.reference,
    direction: row.direction,
    status: publicCargoTrackingStatus(row.lifecycleStatus, row.exceptionStatus),
    sender: { name: row.senderName, contact: row.senderContact },
    recipient: { name: row.recipientName, contact: row.recipientContact },
    weightKg: row.weightKg.toFixed(3),
    volumeLiters: row.volumeLiters,
    packageCount: row.packageCount,
    dimensionsCm:
      row.lengthCm === null || row.widthCm === null || row.heightCm === null
        ? null
        : { length: row.lengthCm, width: row.widthCm, height: row.heightCm },
    declaredContents: row.declaredContents,
    declaredValue: declaredValueView(row),
    fragile: row.fragile,
    professional: row.professional,
    pickupRequired: row.pickupRequired,
    deliveryRequired: row.deliveryRequired,
    booking: row.booking ? { reference: row.booking.reference } : null,
    trip: row.trip
      ? {
          reference: row.trip.reference,
          status: row.trip.status,
          route: row.trip.routeVersion.route,
          plannedDepartureAt: row.trip.plannedDepartureAt,
          plannedArrivalAt: row.trip.plannedArrivalAt,
        }
      : null,
    latestQuote: row.quotes[0] ? customerQuoteView(row.quotes[0]) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function customerCargoDetailView(row: CustomerCargoDetailRow) {
  const base = customerCargoSummaryView(row);
  const timeline = row.events.map((event) => {
    const waypoint = event.routeWaypoint;
    const visibleCheckpoint = waypoint?.checkpoint?.travellerVisible
      ? waypoint.checkpoint
      : null;
    const place = waypoint?.stop ?? visibleCheckpoint;
    return {
      sequence: event.sequence,
      status: publicCargoTrackingStatus(event.lifecycleStatus, event.exceptionStatus),
      occurredAt: event.occurredAt,
      location:
        waypoint && place
          ? {
              sequence: waypoint.sequence,
              kind: waypoint.stop ? ('STOP' as const) : ('CHECKPOINT' as const),
              code: place.code,
              name: place.name,
            }
          : null,
    };
  });
  return {
    ...base,
    lastUpdatedAt: row.events.at(-1)?.occurredAt ?? row.updatedAt,
    timeline,
  };
}

function safeQuoteAudit(row: {
  reference: string;
  version: number;
  status: string;
  currencyCode: string;
  currencyMinorUnit: number;
  updatedAt: Date;
}) {
  return {
    reference: row.reference,
    version: row.version,
    status: row.status,
    currencyCode: row.currencyCode,
    currencyMinorUnit: row.currencyMinorUnit,
    updatedAt: row.updatedAt,
  };
}

async function lockedOwnedShipmentId(
  tx: DatabaseTransaction,
  reference: string,
  customerIdentityId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "road_freight_shipment"
    WHERE "reference" = ${reference}
      AND "customer_identity_id" = ${customerIdentityId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) throw CargoErrors.notFound();
  return rows[0].id;
}

async function lockedVisibleQuoteId(
  tx: DatabaseTransaction,
  shipmentId: string,
  reference: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "road_freight_quote"
    WHERE "shipment_id" = ${shipmentId}::uuid
      AND "reference" = ${reference}
      AND "issued_at" IS NOT NULL
    FOR UPDATE
  `;
  if (!rows[0]) throw CargoQuoteErrors.notFound();
  return rows[0].id;
}

function customerQuoteError(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  const message = String(error);
  if (
    message.includes('invalid road freight quote transition') ||
    message.includes('terminal road freight quote is immutable')
  ) {
    throw CargoQuoteErrors.invalidTransition();
  }
  throw error;
}

@Injectable()
export class CustomerCargoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
    private readonly cargo: CargoService,
  ) {}

  async create(actor: AuthPrincipal, input: CustomerCargoCreateInput) {
    if (input.bookingReference) {
      const ownedBooking = await this.database.client.booking.findFirst({
        where: { reference: input.bookingReference, customerIdentityId: actor.identityId },
        select: { id: true },
      });
      if (!ownedBooking) throw CargoErrors.bookingNotFound();
    }

    const created = await this.cargo.create(actor, {
      ...input,
      customerIdentityId: actor.identityId,
    });
    return this.detail(actor, created.reference, 'CUSTOMER_CREATE_RESULT');
  }

  async list(actor: AuthPrincipal, query: CustomerCargoListQuery) {
    const rows = await this.database.client.roadFreightShipment.findMany({
      where: {
        customerIdentityId: actor.identityId,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      take: query.limit + 1,
      orderBy: { id: 'desc' },
      select: customerCargoSummarySelect,
    });
    const page = rows.slice(0, query.limit);

    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_ACCESSED',
          resourceType: 'road_freight_shipment',
          metadata: {
            access: 'CUSTOMER_LIST',
            references: page.map((row) => row.reference),
          },
        },
        tx,
      ),
    );

    return {
      items: page.map(customerCargoSummaryView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(actor: AuthPrincipal, rawReference: string, access = 'CUSTOMER_DETAIL') {
    const reference = normalizeCargoReference(rawReference);
    if (!reference) throw CargoErrors.notFound();
    const row = await this.database.client.roadFreightShipment.findFirst({
      where: { reference, customerIdentityId: actor.identityId },
      select: customerCargoDetailSelect,
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

    return customerCargoDetailView(row);
  }

  async quotes(actor: AuthPrincipal, rawShipmentReference: string) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    const shipment = await this.database.client.roadFreightShipment.findFirst({
      where: {
        reference: shipmentReference,
        customerIdentityId: actor.identityId,
      },
      select: { id: true },
    });
    if (!shipment) throw CargoErrors.notFound();

    const rows = await this.database.client.roadFreightQuote.findMany({
      where: { shipmentId: shipment.id, issuedAt: { not: null } },
      orderBy: { version: 'desc' },
      select: customerQuoteSelect,
    });

    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'ROAD_FREIGHT_QUOTE_ACCESSED',
          resourceType: 'road_freight_shipment',
          resourceId: shipment.id,
          metadata: {
            access: 'CUSTOMER_LIST',
            shipmentReference,
            quoteReferences: rows.map((row) => row.reference),
          },
        },
        tx,
      ),
    );

    return { items: rows.map(customerQuoteView) };
  }

  async acceptQuote(
    actor: AuthPrincipal,
    rawShipmentReference: string,
    rawQuoteReference: string,
    input: CargoQuoteTransitionInput,
  ) {
    const shipmentReference = normalizeCargoReference(rawShipmentReference);
    const quoteReference = normalizeCargoQuoteReference(rawQuoteReference);
    if (!shipmentReference) throw CargoErrors.notFound();
    if (!quoteReference) throw CargoQuoteErrors.notFound();

    await this.rateLimits.consume(RATE_LIMITS.cargoOperationIdentity, actor.identityId);

    try {
      return await this.database.client.$transaction(async (tx) => {
        const shipmentId = await lockedOwnedShipmentId(tx, shipmentReference, actor.identityId);
        const quoteId = await lockedVisibleQuoteId(tx, shipmentId, quoteReference);
        const before = await tx.roadFreightQuote.findUniqueOrThrow({
          where: { id: quoteId },
          select: customerQuoteSelect,
        });

        if (
          input.expectedUpdatedAt &&
          before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
        ) {
          throw CargoQuoteErrors.conflict();
        }
        if (before.status !== 'ISSUED') throw CargoQuoteErrors.invalidTransition();

        await tx.roadFreightQuote.update({
          where: { id: quoteId },
          data: {
            status: 'ACCEPTED',
            acceptedByIdentityId: actor.identityId,
            acceptedAt: new Date(),
          },
        });
        const after = await tx.roadFreightQuote.findUniqueOrThrow({
          where: { id: quoteId },
          select: customerQuoteSelect,
        });

        await this.audit.record(
          {
            actor,
            action: 'ROAD_FREIGHT_QUOTE_ACCEPTED',
            resourceType: 'road_freight_quote',
            resourceId: quoteId,
            before: safeQuoteAudit(before),
            after: safeQuoteAudit(after),
            metadata: {
              access: 'CUSTOMER_ACCEPT',
              shipmentReference,
              quoteReference,
            },
          },
          tx,
        );

        return customerQuoteView(after);
      });
    } catch (error) {
      return customerQuoteError(error);
    }
  }
}
