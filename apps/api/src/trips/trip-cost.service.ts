import { Prisma, type DatabaseTransaction, type TripStatus } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { tripCostReplaceSchema } from './trip-cost.dto.js';
import { TripErrors } from './trip.errors.js';

type TripCostReplace = z.infer<typeof tripCostReplaceSchema>;

const planSelect = {
  id: true,
  tripId: true,
  status: true,
  currencyCode: true,
  currencyMinorUnit: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      category: true,
      label: true,
      amountMinor: true,
      notes: true,
      position: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.TripCostPlanSelect;

type PlanRow = Prisma.TripCostPlanGetPayload<{ select: typeof planSelect }>;

/** JSON-safe view; totals are always derived from the authoritative lines. */
function planView(tripId: string, plan: PlanRow | null) {
  if (!plan) {
    return {
      id: null,
      tripId,
      status: 'DRAFT' as const,
      currencyCode: 'EUR' as const,
      currencyMinorUnit: 2,
      totalCostMinor: '0',
      createdAt: null,
      updatedAt: null,
      items: [],
    };
  }
  const items = plan.items.map((item) => ({
    ...item,
    amountMinor: item.amountMinor.toString(),
  }));
  return {
    ...plan,
    totalCostMinor: plan.items.reduce((total, item) => total + item.amountMinor, 0n).toString(),
    items,
  };
}

/** Only business fields participate in no-op detection. */
function semanticPlan(view: ReturnType<typeof planView>) {
  return {
    status: view.status,
    currencyCode: view.currencyCode,
    items: view.items.map(({ category, label, amountMinor, notes, position }) => ({
      category,
      label,
      amountMinor,
      notes,
      position,
    })),
  };
}

/** Serialize all trip mutations on the same row, matching TripService's lock order. */
async function lockTrip(tx: DatabaseTransaction, tripId: string): Promise<TripStatus> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: TripStatus }>>`
    SELECT "id", "status" FROM "trip" WHERE "id" = ${tripId}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw TripErrors.tripNotFound();
  return row.status;
}

/** Internal operational cost plan; never used by public or customer APIs. */
@Injectable()
export class TripCostService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Read an existing plan, or the empty EUR draft implied for every trip. */
  async costPlan(tripId: string) {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: { id: true, costPlan: { select: planSelect } },
    });
    if (!trip) throw TripErrors.tripNotFound();
    return planView(trip.id, trip.costPlan);
  }

  /**
   * Replace status and all ordered lines atomically. The server derives the
   * total, a semantic no-op writes nothing, and LOCKED is terminal.
   */
  replaceCostPlan(tripId: string, input: TripCostReplace, actor: Actor) {
    return this.database.client.$transaction(async (tx) => {
      const tripStatus = await lockTrip(tx, tripId);
      const stored = await tx.tripCostPlan.findUnique({
        where: { tripId },
        select: planSelect,
      });
      const before = planView(tripId, stored);
      const requested = {
        status: input.status,
        currencyCode: input.currencyCode,
        items: [...input.items]
          .sort((left, right) => left.position - right.position)
          .map((item) => ({
            category: item.category,
            label: item.label,
            amountMinor: item.amountMinor,
            notes: item.notes ?? null,
            position: item.position,
          })),
      };
      if (JSON.stringify(semanticPlan(before)) === JSON.stringify(requested)) return before;
      if (tripStatus === 'CANCELLED') throw TripErrors.cancelled();
      if (stored?.status === 'LOCKED') throw TripErrors.costPlanLocked();

      const plan = stored
        ? stored
        : await tx.tripCostPlan.create({
            data: { tripId, status: 'DRAFT', currencyCode: 'EUR', currencyMinorUnit: 2 },
            select: planSelect,
          });
      await tx.tripCostItem.deleteMany({ where: { planId: plan.id } });
      if (requested.items.length > 0) {
        await tx.tripCostItem.createMany({
          data: requested.items.map((item) => ({
            planId: plan.id,
            category: item.category,
            label: item.label,
            amountMinor: BigInt(item.amountMinor),
            notes: item.notes,
            position: item.position,
          })),
        });
      }
      await tx.tripCostPlan.update({
        where: { id: plan.id },
        data: {
          status: requested.status,
          currencyCode: requested.currencyCode,
          currencyMinorUnit: 2,
        },
      });
      const after = planView(
        tripId,
        await tx.tripCostPlan.findUniqueOrThrow({ where: { id: plan.id }, select: planSelect }),
      );
      await this.audit.record(
        {
          actor,
          action: 'TRIP_COST_UPDATED',
          resourceType: 'trip',
          resourceId: tripId,
          before,
          after,
          metadata: {
            previousTotalCostMinor: before.totalCostMinor,
            totalCostMinor: after.totalCostMinor,
            currencyCode: after.currencyCode,
            status: after.status,
          },
        },
        tx,
      );
      return after;
    });
  }
}
