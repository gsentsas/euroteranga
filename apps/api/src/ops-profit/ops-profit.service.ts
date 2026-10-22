import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { buildFinanceCurrencySummary } from '../finance/finance-summary.js';
import { FinanceErrors } from '../finance/finance.errors.js';

const CAPACITY_STATES = [
  'ASSIGNED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED',
  'AVAILABLE',
] as const;

function quoteTotal(lines: Array<{ kind: 'CHARGE' | 'DISCOUNT'; amountMinor: bigint }>): bigint {
  return lines.reduce(
    (total, line) => total + (line.kind === 'CHARGE' ? line.amountMinor : -line.amountMinor),
    0n,
  );
}

function parseWeightMilliKg(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function formatWeightMilliKg(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1000n;
  const fraction = String(absolute % 1000n).padStart(3, '0');
  return `${sign}${whole}.${fraction}`;
}

@Injectable()
export class OpsProfitService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async tripProfitability(actor: AuthPrincipal, rawReference: string) {
    const reference = rawReference.trim().toUpperCase();
    const trip = await this.database.client.trip.findUnique({
      where: { reference },
      select: {
        id: true,
        reference: true,
        status: true,
        vehicle: {
          select: {
            code: true,
            payloadCapacityKg: true,
            cargoVolumeLiters: true,
          },
        },
        supportVehicle: {
          select: {
            code: true,
            payloadCapacityKg: true,
            cargoVolumeLiters: true,
          },
        },
        costPlan: {
          select: {
            status: true,
            currencyCode: true,
            currencyMinorUnit: true,
            items: {
              select: { amountMinor: true },
            },
          },
        },
        roadFreightShipments: {
          select: {
            id: true,
            lifecycleStatus: true,
            weightKg: true,
            volumeLiters: true,
            quotes: {
              where: { status: 'ACCEPTED' },
              select: {
                id: true,
                currencyCode: true,
                currencyMinorUnit: true,
                lines: {
                  select: {
                    kind: true,
                    amountMinor: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!trip) throw FinanceErrors.tripNotFound();

    const [payments, revenues, expenses] = await Promise.all([
      this.database.client.payment.findMany({
        where: { booking: { tripId: trip.id }, status: 'SUCCEEDED' },
        select: {
          amountMinor: true,
          currencyCode: true,
          currencyMinorUnit: true,
          refunds: { select: { amountMinor: true } },
        },
      }),
      this.database.client.tripRevenue.findMany({
        where: { tripId: trip.id },
        select: {
          status: true,
          amountMinor: true,
          currencyCode: true,
          currencyMinorUnit: true,
        },
      }),
      this.database.client.tripExpense.findMany({
        where: { tripId: trip.id },
        select: {
          status: true,
          amountMinor: true,
          currencyCode: true,
          currencyMinorUnit: true,
          payouts: { select: { amountMinor: true } },
        },
      }),
    ]);

    const financeActuals = buildFinanceCurrencySummary({ payments, revenues, expenses });

    const plannedCostMinor = trip.costPlan
      ? trip.costPlan.items.reduce((total, item) => total + item.amountMinor, 0n)
      : null;
    const actualEur = financeActuals.find(
      (currency) => currency.currencyCode === 'EUR' && currency.currencyMinorUnit === 2,
    );
    const actualExpenseMinor = BigInt(actualEur?.expenseMinor ?? '0');
    const varianceMinor =
      plannedCostMinor === null ? null : actualExpenseMinor - plannedCostMinor;
    const remainingBudgetMinor =
      plannedCostMinor === null ? null : plannedCostMinor - actualExpenseMinor;
    const varianceBasisPoints =
      plannedCostMinor && plannedCostMinor !== 0n && varianceMinor !== null
        ? (varianceMinor * 10000n) / plannedCostMinor
        : null;

    const commercialBuckets = new Map<
      string,
      { currencyCode: string; currencyMinorUnit: number; amountMinor: bigint; quoteCount: number }
    >();
    let acceptedQuoteCount = 0;
    let shipmentsWithoutAcceptedQuote = 0;

    for (const shipment of trip.roadFreightShipments) {
      if (shipment.quotes.length === 0) shipmentsWithoutAcceptedQuote += 1;
      for (const quote of shipment.quotes) {
        acceptedQuoteCount += 1;
        const key = `${quote.currencyCode}:${quote.currencyMinorUnit}`;
        const bucket = commercialBuckets.get(key) ?? {
          currencyCode: quote.currencyCode,
          currencyMinorUnit: quote.currencyMinorUnit,
          amountMinor: 0n,
          quoteCount: 0,
        };
        bucket.amountMinor += quoteTotal(quote.lines);
        bucket.quoteCount += 1;
        commercialBuckets.set(key, bucket);
      }
    }

    const cargoCommercial = [...commercialBuckets.values()]
      .sort((left, right) =>
        left.currencyCode === right.currencyCode
          ? left.currencyMinorUnit - right.currencyMinorUnit
          : left.currencyCode.localeCompare(right.currencyCode),
      )
      .map((bucket) => ({
        currencyCode: bucket.currencyCode,
        currencyMinorUnit: bucket.currencyMinorUnit,
        acceptedQuoteCount: bucket.quoteCount,
        acceptedCommercialValueMinor: bucket.amountMinor.toString(),
        recognizedRevenueMinor: '0',
      }));

    let usedWeightMilliKg = 0n;
    let usedVolumeLiters = 0n;
    for (const shipment of trip.roadFreightShipments) {
      if (!CAPACITY_STATES.includes(shipment.lifecycleStatus as (typeof CAPACITY_STATES)[number])) {
        continue;
      }
      usedWeightMilliKg += parseWeightMilliKg(shipment.weightKg.toString());
      usedVolumeLiters += BigInt(shipment.volumeLiters);
    }

    const convoyVehicles = [trip.vehicle, trip.supportVehicle].filter(
      (vehicle): vehicle is NonNullable<typeof vehicle> => vehicle !== null,
    );
    const payloadCapacityKg = convoyVehicles.reduce(
      (total, vehicle) => total + BigInt(vehicle.payloadCapacityKg ?? 0),
      0n,
    );
    const cargoVolumeLiters = convoyVehicles.reduce(
      (total, vehicle) => total + BigInt(vehicle.cargoVolumeLiters ?? 0),
      0n,
    );

    const warnings: string[] = [];
    if (!trip.costPlan) warnings.push('NO_TRIP_COST_PLAN');
    if (financeActuals.length > 1) warnings.push('MULTI_CURRENCY_NO_FX');
    if (acceptedQuoteCount > 0) warnings.push('CARGO_COMMERCIAL_NOT_RECOGNIZED_REVENUE');

    await this.database.client.$transaction((tx) =>
      this.audit.record(
        {
          actor,
          action: 'OPS_PROFIT_TRIP_ACCESSED',
          resourceType: 'trip',
          resourceId: trip.id,
          metadata: {
            tripReference: trip.reference,
            financeCurrencies: financeActuals.map((currency) => currency.currencyCode),
            cargoCommercialCurrencies: cargoCommercial.map((currency) => currency.currencyCode),
            cargoShipmentCount: trip.roadFreightShipments.length,
          },
        },
        tx,
      ),
    );

    return {
      trip: {
        id: trip.id,
        reference: trip.reference,
        status: trip.status,
      },
      financeActuals,
      plannedCost: trip.costPlan
        ? {
            status: trip.costPlan.status,
            currencyCode: trip.costPlan.currencyCode,
            currencyMinorUnit: trip.costPlan.currencyMinorUnit,
            plannedCostMinor: plannedCostMinor!.toString(),
            actualExpenseMinor: actualExpenseMinor.toString(),
            varianceMinor: varianceMinor!.toString(),
            remainingBudgetMinor: remainingBudgetMinor!.toString(),
            varianceBasisPoints: varianceBasisPoints?.toString() ?? null,
          }
        : null,
      cargo: {
        shipmentCount: trip.roadFreightShipments.length,
        acceptedQuoteCount,
        shipmentsWithoutAcceptedQuote,
        commercial: cargoCommercial,
        capacity: {
          vehicleCount: convoyVehicles.length,
          vehicleCodes: convoyVehicles.map((vehicle) => vehicle.code),
          payloadCapacityKg: payloadCapacityKg.toString(),
          cargoVolumeLiters: cargoVolumeLiters.toString(),
          usedWeightKg: formatWeightMilliKg(usedWeightMilliKg),
          usedVolumeLiters: usedVolumeLiters.toString(),
        },
      },
      warnings,
      fxConversionApplied: false as const,
      cargoRevenueRecognitionApplied: false as const,
    };
  }
}
