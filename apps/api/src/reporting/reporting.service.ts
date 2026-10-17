import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { DatabaseService } from '../database/database.service.js';
import type { reportingQuerySchema } from './reporting.dto.js';
import { delayMinutes, exactRatio, integerAverageMinor, safeRate } from './reporting-rules.js';

type ReportingQuery = z.infer<typeof reportingQuerySchema>;

type MoneyKind = 'ticket' | 'additional' | 'refund' | 'expense' | 'payout';

interface MutableMoneyBucket {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: bigint;
  additionalRevenueMinor: bigint;
  refundMinor: bigint;
  expenseMinor: bigint;
  payoutMinor: bigint;
}

interface CommercialCount {
  confirmedBookings: number;
  passengers: number;
  soldSeats: number;
}

interface MutableRoute {
  routeVersionId: string;
  routeId: string;
  routeCode: string;
  routeName: string;
  routeVersion: number;
  tripCount: number;
  passengerCount: number;
  soldSeatCount: number;
  offeredSeatCapacity: number;
  cancellationCount: number;
  incidentCount: number;
  money: Map<string, MutableMoneyBucket>;
}

interface MutableTripMetrics {
  passengerCount: number;
  soldSeatCount: number;
  incidentCount: number;
  bookingCount: number;
  cancelledBookingCount: number;
  money: Map<string, MutableMoneyBucket>;
}

const MAX_TRIPS = 5_000;

function key(currencyCode: string, currencyMinorUnit: number): string {
  return currencyCode + ':' + String(currencyMinorUnit);
}

function bucket(
  buckets: Map<string, MutableMoneyBucket>,
  currencyCode: string,
  currencyMinorUnit: number,
): MutableMoneyBucket {
  const bucketKey = key(currencyCode, currencyMinorUnit);
  const current = buckets.get(bucketKey);
  if (current) return current;
  const created: MutableMoneyBucket = {
    currencyCode,
    currencyMinorUnit,
    ticketRevenueMinor: 0n,
    additionalRevenueMinor: 0n,
    refundMinor: 0n,
    expenseMinor: 0n,
    payoutMinor: 0n,
  };
  buckets.set(bucketKey, created);
  return created;
}

function addMoney(
  buckets: Map<string, MutableMoneyBucket>,
  kind: MoneyKind,
  amountMinor: bigint,
  currencyCode: string,
  currencyMinorUnit: number,
): void {
  const target = bucket(buckets, currencyCode, currencyMinorUnit);
  if (kind === 'ticket') target.ticketRevenueMinor += amountMinor;
  if (kind === 'additional') target.additionalRevenueMinor += amountMinor;
  if (kind === 'refund') target.refundMinor += amountMinor;
  if (kind === 'expense') target.expenseMinor += amountMinor;
  if (kind === 'payout') target.payoutMinor += amountMinor;
}

function moneyView(
  source: MutableMoneyBucket,
  commercial: CommercialCount | undefined,
  profitability?: { profitable: number; loss: number; breakEven: number },
) {
  const gross = source.ticketRevenueMinor + source.additionalRevenueMinor;
  const net = gross - source.refundMinor;
  const contribution = net - source.expenseMinor;
  return {
    currencyCode: source.currencyCode,
    currencyMinorUnit: source.currencyMinorUnit,
    ticketRevenueMinor: source.ticketRevenueMinor.toString(),
    additionalRevenueMinor: source.additionalRevenueMinor.toString(),
    grossRevenueMinor: gross.toString(),
    refundMinor: source.refundMinor.toString(),
    refundRate: exactRatio(source.refundMinor, gross),
    netRevenueMinor: net.toString(),
    expenseMinor: source.expenseMinor.toString(),
    contributionMinor: contribution.toString(),
    contributionRate: exactRatio(contribution, net),
    payoutMinor: source.payoutMinor.toString(),
    outstandingExpenseMinor: (source.expenseMinor - source.payoutMinor).toString(),
    averageTicketRevenuePerConfirmedBookingMinor: integerAverageMinor(
      source.ticketRevenueMinor,
      commercial?.confirmedBookings ?? 0,
    ),
    averageNetRevenuePerPassengerMinor: integerAverageMinor(net, commercial?.passengers ?? 0),
    averageNetRevenuePerSoldSeatMinor: integerAverageMinor(net, commercial?.soldSeats ?? 0),
    profitableTripCount: profitability?.profitable ?? 0,
    lossTripCount: profitability?.loss ?? 0,
    breakEvenTripCount: profitability?.breakEven ?? 0,
  };
}

function sortedMoney(
  buckets: Map<string, MutableMoneyBucket>,
  commercialByCurrency: Map<string, CommercialCount> = new Map(),
  profitabilityByCurrency: Map<
    string,
    { profitable: number; loss: number; breakEven: number }
  > = new Map(),
) {
  return [...buckets.values()]
    .sort((a, b) =>
      a.currencyCode === b.currencyCode
        ? a.currencyMinorUnit - b.currencyMinorUnit
        : a.currencyCode.localeCompare(b.currencyCode),
    )
    .map((value) =>
      moneyView(
        value,
        commercialByCurrency.get(key(value.currencyCode, value.currencyMinorUnit)),
        profitabilityByCurrency.get(key(value.currencyCode, value.currencyMinorUnit)),
      ),
    );
}

@Injectable()
export class ReportingService {
  constructor(private readonly database: DatabaseService) {}

  private where(query: ReportingQuery): Prisma.TripWhereInput {
    return {
      plannedDepartureAt: { gte: query.from, lt: query.to },
      ...(query.routeId ? { routeVersion: { routeId: query.routeId } } : {}),
      ...(query.tripId ? { id: query.tripId } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
  }

  async overview(query: ReportingQuery) {
    const where = this.where(query);
    const tripCount = await this.database.client.trip.count({ where });
    if (tripCount > MAX_TRIPS) {
      throw new PublicApiError(
        422,
        'REPORTING_RANGE_TOO_LARGE',
        'La période contient trop de voyages. Réduisez la période ou ajoutez un filtre.',
      );
    }

    const [trips, bookings, payments, revenues, expenses, incidents, baggage, vehicles] =
      await Promise.all([
        this.database.client.trip.findMany({
          where,
          orderBy: [{ plannedDepartureAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            reference: true,
            status: true,
            plannedDepartureAt: true,
            plannedArrivalAt: true,
            actualDepartureAt: true,
            actualArrivalAt: true,
            vehicleId: true,
            vehicle: { select: { code: true } },
            routeVersion: {
              select: {
                id: true,
                version: true,
                route: { select: { id: true, code: true, name: true } },
              },
            },
            seatMapVersion: {
              select: {
                _count: { select: { cells: { where: { kind: 'SEAT' } } } },
              },
            },
          },
        }),
        this.database.client.booking.findMany({
          where: { trip: where },
          select: {
            id: true,
            tripId: true,
            confirmedAt: true,
            cancelledAt: true,
            currencyCode: true,
            currencyMinorUnit: true,
            _count: {
              select: {
                passengers: true,
                seats: { where: { releasedAt: null } },
              },
            },
          },
        }),
        this.database.client.payment.findMany({
          where: { status: 'SUCCEEDED', booking: { trip: where } },
          select: {
            bookingId: true,
            booking: { select: { tripId: true } },
            amountMinor: true,
            currencyCode: true,
            currencyMinorUnit: true,
            refunds: { select: { amountMinor: true } },
          },
        }),
        this.database.client.tripRevenue.findMany({
          where: { status: 'ACTIVE', trip: where },
          select: {
            tripId: true,
            amountMinor: true,
            currencyCode: true,
            currencyMinorUnit: true,
          },
        }),
        this.database.client.tripExpense.findMany({
          where: { status: 'ACTIVE', trip: where },
          select: {
            tripId: true,
            amountMinor: true,
            currencyCode: true,
            currencyMinorUnit: true,
            payouts: { select: { amountMinor: true } },
          },
        }),
        this.database.client.incident.findMany({
          where: { trip: where },
          select: {
            tripId: true,
            type: true,
            severity: true,
            status: true,
            openedAt: true,
            resolvedAt: true,
          },
        }),
        this.database.client.baggage.findMany({
          where: { bookingPassenger: { booking: { trip: where } } },
          select: {
            bookingId: true,
            lifecycleStatus: true,
            exceptionStatus: true,
            _count: { select: { events: { where: { type: 'LOADED' } } } },
          },
        }),
        this.database.client.vehicle.findMany({ select: { id: true, status: true } }),
      ]);

    const tripById = new Map(trips.map((trip) => [trip.id, trip]));
    const routeMetrics = new Map<string, MutableRoute>();
    const tripMetrics = new Map<string, MutableTripMetrics>();
    const allMoney = new Map<string, MutableMoneyBucket>();
    const commercialByCurrency = new Map<string, CommercialCount>();
    const tripMoney = new Map<string, Map<string, MutableMoneyBucket>>();

    let offeredSeatCapacity = 0;
    for (const trip of trips) {
      const capacity = trip.seatMapVersion?._count.cells ?? 0;
      offeredSeatCapacity += capacity;
      tripMetrics.set(trip.id, {
        passengerCount: 0,
        soldSeatCount: 0,
        incidentCount: 0,
        bookingCount: 0,
        cancelledBookingCount: 0,
        money: new Map(),
      });
      const routeVersionId = trip.routeVersion.id;
      const route = routeMetrics.get(routeVersionId) ?? {
        routeVersionId,
        routeId: trip.routeVersion.route.id,
        routeCode: trip.routeVersion.route.code,
        routeName: trip.routeVersion.route.name,
        routeVersion: trip.routeVersion.version,
        tripCount: 0,
        passengerCount: 0,
        soldSeatCount: 0,
        offeredSeatCapacity: 0,
        cancellationCount: 0,
        incidentCount: 0,
        money: new Map(),
      };
      route.tripCount += 1;
      route.offeredSeatCapacity += capacity;
      routeMetrics.set(routeVersionId, route);
      tripMoney.set(trip.id, new Map());
    }

    let confirmedBookingCount = 0;
    let cancelledBookingCount = 0;
    let passengerCount = 0;
    let soldSeatCount = 0;
    for (const booking of bookings) {
      const trip = tripById.get(booking.tripId);
      const perTrip = tripMetrics.get(booking.tripId);
      if (!trip || !perTrip) continue;
      const perRoute = routeMetrics.get(trip.routeVersion.id)!;
      perTrip.bookingCount += 1;
      if (booking.cancelledAt) {
        cancelledBookingCount += 1;
        perTrip.cancelledBookingCount += 1;
        perRoute.cancellationCount += 1;
      }
      const activeConfirmed = booking.confirmedAt !== null && booking.cancelledAt === null;
      if (!activeConfirmed) continue;
      confirmedBookingCount += 1;
      passengerCount += booking._count.passengers;
      soldSeatCount += booking._count.seats;
      perTrip.passengerCount += booking._count.passengers;
      perTrip.soldSeatCount += booking._count.seats;
      perRoute.passengerCount += booking._count.passengers;
      perRoute.soldSeatCount += booking._count.seats;
      const currency = key(booking.currencyCode, booking.currencyMinorUnit);
      const counts = commercialByCurrency.get(currency) ?? {
        confirmedBookings: 0,
        passengers: 0,
        soldSeats: 0,
      };
      counts.confirmedBookings += 1;
      counts.passengers += booking._count.passengers;
      counts.soldSeats += booking._count.seats;
      commercialByCurrency.set(currency, counts);
    }

    const recordMoney = (
      tripId: string,
      kind: MoneyKind,
      amountMinor: bigint,
      currencyCode: string,
      currencyMinorUnit: number,
    ) => {
      const trip = tripById.get(tripId);
      if (!trip) return;
      addMoney(allMoney, kind, amountMinor, currencyCode, currencyMinorUnit);
      addMoney(tripMoney.get(tripId)!, kind, amountMinor, currencyCode, currencyMinorUnit);
      addMoney(
        routeMetrics.get(trip.routeVersion.id)!.money,
        kind,
        amountMinor,
        currencyCode,
        currencyMinorUnit,
      );
    };

    for (const payment of payments) {
      const tripId = payment.booking.tripId;
      recordMoney(
        tripId,
        'ticket',
        payment.amountMinor,
        payment.currencyCode,
        payment.currencyMinorUnit,
      );
      for (const refund of payment.refunds) {
        recordMoney(
          tripId,
          'refund',
          refund.amountMinor,
          payment.currencyCode,
          payment.currencyMinorUnit,
        );
      }
    }
    for (const revenue of revenues) {
      recordMoney(
        revenue.tripId,
        'additional',
        revenue.amountMinor,
        revenue.currencyCode,
        revenue.currencyMinorUnit,
      );
    }
    for (const expense of expenses) {
      recordMoney(
        expense.tripId,
        'expense',
        expense.amountMinor,
        expense.currencyCode,
        expense.currencyMinorUnit,
      );
      for (const payout of expense.payouts) {
        recordMoney(
          expense.tripId,
          'payout',
          payout.amountMinor,
          expense.currencyCode,
          expense.currencyMinorUnit,
        );
      }
    }

    const profitabilityByCurrency = new Map<
      string,
      { profitable: number; loss: number; breakEven: number }
    >();
    for (const buckets of tripMoney.values()) {
      for (const value of buckets.values()) {
        const contribution =
          value.ticketRevenueMinor +
          value.additionalRevenueMinor -
          value.refundMinor -
          value.expenseMinor;
        const currency = key(value.currencyCode, value.currencyMinorUnit);
        const counts = profitabilityByCurrency.get(currency) ?? {
          profitable: 0,
          loss: 0,
          breakEven: 0,
        };
        if (contribution > 0n) counts.profitable += 1;
        else if (contribution < 0n) counts.loss += 1;
        else counts.breakEven += 1;
        profitabilityByCurrency.set(currency, counts);
      }
    }

    let resolvedIncidentCount = 0;
    let resolutionMinutes = 0;
    let resolutionSampleCount = 0;
    const severity = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const incident of incidents) {
      severity[incident.severity] += 1;
      const perTrip = tripMetrics.get(incident.tripId);
      if (perTrip) perTrip.incidentCount += 1;
      const trip = tripById.get(incident.tripId);
      if (trip) routeMetrics.get(trip.routeVersion.id)!.incidentCount += 1;
      if (incident.resolvedAt) {
        resolvedIncidentCount += 1;
        const minutes = Math.max(
          0,
          (incident.resolvedAt.getTime() - incident.openedAt.getTime()) / 60_000,
        );
        resolutionMinutes += minutes;
        resolutionSampleCount += 1;
      }
    }

    let loadedBaggageCount = 0;
    let deliveredBaggageCount = 0;
    let baggageAnomalyCount = 0;
    for (const item of baggage) {
      if (item._count.events > 0) loadedBaggageCount += 1;
      if (item.lifecycleStatus === 'DELIVERED') deliveredBaggageCount += 1;
      if (item.exceptionStatus !== null) baggageAnomalyCount += 1;
    }

    const departureDelays = trips
      .map((trip) => delayMinutes(trip.plannedDepartureAt, trip.actualDepartureAt))
      .filter((value): value is number => value !== null);
    const delayedDepartureCount = departureDelays.filter((minutes) => minutes > 0).length;
    const onTimeDepartureCount = departureDelays.length - delayedDepartureCount;
    const actualDurations = trips
      .filter((trip) => trip.actualDepartureAt && trip.actualArrivalAt)
      .map((trip) => (trip.actualArrivalAt!.getTime() - trip.actualDepartureAt!.getTime()) / 60_000)
      .filter((minutes) => minutes >= 0);

    const activeVehicleIds = new Set(
      vehicles.filter((vehicle) => vehicle.status === 'ACTIVE').map((vehicle) => vehicle.id),
    );
    const usedVehicleIds = new Set(
      trips.map((trip) => trip.vehicleId).filter((id): id is string => id !== null),
    );
    const activeUsedVehicleCount = [...usedVehicleIds].filter((id) =>
      activeVehicleIds.has(id),
    ).length;
    const assignedTripCount = trips.filter((trip) => trip.vehicleId !== null).length;

    const recentTrips = trips.slice(0, 25).map((trip) => {
      const metrics = tripMetrics.get(trip.id)!;
      return {
        id: trip.id,
        reference: trip.reference,
        status: trip.status,
        plannedDepartureAt: trip.plannedDepartureAt,
        plannedArrivalAt: trip.plannedArrivalAt,
        route: {
          id: trip.routeVersion.route.id,
          code: trip.routeVersion.route.code,
          name: trip.routeVersion.route.name,
          version: trip.routeVersion.version,
        },
        vehicle: trip.vehicle ? { id: trip.vehicleId!, code: trip.vehicle.code } : null,
        bookingCount: metrics.bookingCount,
        cancelledBookingCount: metrics.cancelledBookingCount,
        passengerCount: metrics.passengerCount,
        soldSeatCount: metrics.soldSeatCount,
        offeredSeatCapacity: trip.seatMapVersion?._count.cells ?? 0,
        loadFactor: safeRate(metrics.soldSeatCount, trip.seatMapVersion?._count.cells ?? 0),
        incidentCount: metrics.incidentCount,
        currencies: sortedMoney(metrics.money),
      };
    });

    const routes = [...routeMetrics.values()]
      .sort((a, b) => b.tripCount - a.tripCount || b.soldSeatCount - a.soldSeatCount)
      .slice(0, 20)
      .map((route) => ({
        routeVersionId: route.routeVersionId,
        routeId: route.routeId,
        routeCode: route.routeCode,
        routeName: route.routeName,
        routeVersion: route.routeVersion,
        tripCount: route.tripCount,
        passengerCount: route.passengerCount,
        soldSeatCount: route.soldSeatCount,
        offeredSeatCapacity: route.offeredSeatCapacity,
        loadFactor: safeRate(route.soldSeatCount, route.offeredSeatCapacity),
        cancellationCount: route.cancellationCount,
        incidentCount: route.incidentCount,
        currencies: sortedMoney(route.money),
      }));

    return {
      period: {
        from: query.from,
        to: query.to,
        semantics: '[from,to) on trip.plannedDepartureAt' as const,
      },
      filters: {
        routeId: query.routeId ?? null,
        tripId: query.tripId ?? null,
        vehicleId: query.vehicleId ?? null,
        status: query.status ?? null,
      },
      activity: {
        tripCount,
        draftTripCount: trips.filter((trip) => trip.status === 'DRAFT').length,
        scheduledTripCount: trips.filter((trip) => trip.status === 'SCHEDULED').length,
        inProgressTripCount: trips.filter((trip) => trip.status === 'IN_PROGRESS').length,
        completedTripCount: trips.filter((trip) => trip.status === 'COMPLETED').length,
        cancelledTripCount: trips.filter((trip) => trip.status === 'CANCELLED').length,
      },
      commercial: {
        bookingCount: bookings.length,
        confirmedBookingCount,
        cancelledBookingCount,
        passengerCount,
        soldSeatCount,
        offeredSeatCapacity,
        loadFactor: safeRate(soldSeatCount, offeredSeatCapacity),
        cancellationRate: safeRate(cancelledBookingCount, bookings.length),
      },
      finance: {
        currencies: sortedMoney(allMoney, commercialByCurrency, profitabilityByCurrency),
        fxConversionApplied: false as const,
      },
      operations: {
        departureSampleCount: departureDelays.length,
        onTimeDepartureCount,
        delayedDepartureCount,
        averageDelayMinutes:
          departureDelays.length > 0
            ? departureDelays.reduce((sum, value) => sum + value, 0) / departureDelays.length
            : null,
        maximumDelayMinutes: departureDelays.length > 0 ? Math.max(...departureDelays) : null,
        actualDurationSampleCount: actualDurations.length,
        averageActualDurationMinutes:
          actualDurations.length > 0
            ? actualDurations.reduce((sum, value) => sum + value, 0) / actualDurations.length
            : null,
      },
      incidents: {
        incidentCount: incidents.length,
        openIncidentCount: incidents.filter(
          (incident) => incident.status !== 'RESOLVED' && incident.status !== 'CLOSED',
        ).length,
        resolvedIncidentCount,
        severity,
        averageResolutionMinutes:
          resolutionSampleCount > 0 ? resolutionMinutes / resolutionSampleCount : null,
      },
      baggage: {
        baggageCount: baggage.length,
        loadedBaggageCount,
        deliveredBaggageCount,
        anomalyBaggageCount: baggageAnomalyCount,
        baggageIncidentCount: incidents.filter((incident) => incident.type === 'BAGGAGE').length,
        anomalyRate: safeRate(baggageAnomalyCount, baggage.length),
      },
      fleet: {
        vehicleCount: vehicles.length,
        activeVehicleCount: activeVehicleIds.size,
        outOfServiceVehicleCount: vehicles.filter((vehicle) => vehicle.status === 'OUT_OF_SERVICE')
          .length,
        retiredVehicleCount: vehicles.filter((vehicle) => vehicle.status === 'RETIRED').length,
        usedVehicleCount: usedVehicleIds.size,
        activeUsedVehicleCount,
        utilizationRate: safeRate(activeUsedVehicleCount, activeVehicleIds.size),
        tripsPerUsedVehicle: safeRate(assignedTripCount, usedVehicleIds.size),
      },
      routes,
      recentTrips,
      privacy: { containsPassengerPii: false as const },
    };
  }
}
