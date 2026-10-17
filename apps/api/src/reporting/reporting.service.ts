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
    averageNetRevenuePerPassengerMinor: integerAverageMinor(
      net,
      commercial?.passengers ?? 0,
    ),
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
        'La pÃ©riode contient trop de voyages. RÃ©duisez la pÃ©riode ou ajoutez un filtre.',
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
         ²È="25½Õ¹ÑÌ¤ì(€€€€€ô(€€€ô((€€€±•ĞÉ•Í½±Ù•‘%¹¥‘•¹Ñ½Õ¹Ğ€ô€Àì(€€€±•ĞÉ•Í½±ÕÑ¥½¹5¥¹ÕÑ•Ì€ô€Àì(€€€±•ĞÉ•Í½±ÕÑ¥½¹M…µÁ±•½Õ¹Ğ€ô€Àì(€€€½¹ÍĞÍ•Ù•É¥Ñä€ôì1=\è€À°5%U4è€À°!% è€À°I%Q%0è€Àôì(€€€™½È€¡½¹ÍĞ¥¹¥‘•¹Ğ½˜¥¹¥‘•¹ÑÌ¤ì(€€€€€Í•Ù•É¥Ñåm¥¹¥‘•¹Ğ¹Í•Ù•É¥Ñåt€¬ô€Äì(€€€€€½¹ÍĞÁ•ÉQÉ¥À€ôÑÉ¥Á5•ÑÉ¥Ì¹•Ğ¡¥¹¥‘•¹Ğ¹ÑÉ¥Á%¤ì(€€€€€¥˜€¡Á•ÉQÉ¥À¤Á•ÉQÉ¥À¹¥¹¥‘•¹Ñ½Õ¹Ğ€¬ô€Äì(€€€€€½¹ÍĞÑÉ¥À€ôÑÉ¥Á	å%¹•Ğ¡¥¹¥‘•¹Ğ¹ÑÉ¥Á%¤ì(€€€€€¥˜€¡ÑÉ¥À¤É½ÕÑ•5•ÑÉ¥Ì¹•Ğ¡ÑÉ¥À¹É½ÕÑ•Y•ÉÍ¥½¸¹¥¤„¹¥¹¥‘•¹Ñ½Õ¹Ğ€¬ô€Äì(€€€€€¥˜€¡¥¹¥‘•¹Ğ¹É•Í½±Ù•‘Ğ¤ì(€€€€€€€É•Í½±Ù•‘%¹¥‘•¹Ñ½Õ¹Ğ€¬ô€Äì(€€€€€€€½¹ÍĞµ¥¹ÕÑ•Ì€ô5…Ñ ¹µ…à (€€€€€€€€€€À°(€€€€€€€€€€¡¥¹¥‘•¹Ğ¹É•Í½±Ù•‘Ğ¹•ÑQ¥µ” ¤€´¥¹¥‘•¹Ğ¹½Á•¹•‘Ğ¹•ÑQ¥µ” ¤¤€¼€ØÁ|ÀÀÀ°(€€€€€€€€¤ì(€€€€€€€É•Í½±ÕÑ¥½¹5¥¹ÕÑ•Ì€¬ôµ¥¹ÕÑ•Ìì(€€€€€€€É•Í½±ÕÑ¥½¹M…µÁ±•½Õ¹Ğ€¬ô€Äì(€€€€€ô(€€€ô((€€€±•Ğ±½…‘•‘	……•½Õ¹Ğ€ô€Àì(€€€±•Ğ‘•±¥Ù•É•‘	……•½Õ¹Ğ€ô€Àì(€€€±•Ğ‰……•¹½µ…±å½Õ¹Ğ€ô€Àì(€€€™½È€¡½¹ÍĞ¥Ñ•´½˜‰……”¤ì(€€€€€¥˜€¡¥Ñ•´¹}½Õ¹Ğ¹•Ù•¹ÑÌ€ø€À¤±½…‘•‘	……•½Õ¹Ğ€¬ô€Äì(€€€€€¥˜€¡¥Ñ•´¹±¥™•å±•MÑ…ÑÕÌ€ôôô€1%YIœ¤‘•±¥Ù•É•‘	……•½Õ¹Ğ€¬ô€Äì(€€€€€¥˜€¡¥Ñ•´¹•á•ÁÑ¥½¹MÑ…ÑÕÌ€„ôô¹Õ±°¤‰……•¹½µ…±å½Õ¹Ğ€¬ô€Äì(€€€ô((€€€½¹ÍĞ‘•Á…ÉÑÕÉ••±…åÌ€ôÑÉ¥ÁÌ(€€€€€€¹µ…À ¡ÑÉ¥À¤€ôø‘•±…å5¥¹ÕÑ•Ì¡ÑÉ¥À¹Á±…¹¹•‘•Á…ÉÑÕÉ•Ğ°ÑÉ¥À¹…ÑÕ…±•Á…ÉÑÕÉ•Ğ¤¤(€€€€€€¹™¥±Ñ•È ¡Ù…±Õ”¤èÙ…±Õ”¥Ì¹Õµ‰•È€ôøÙ…±Õ”€„ôô¹Õ±°¤ì(€€€½¹ÍĞ‘•±…å•‘•Á…ÉÑÕÉ•½Õ¹Ğ€ô‘•Á…ÉÑÕÉ••±…åÌ¹™¥±Ñ•È ¡µ¥¹ÕÑ•Ì¤€ôøµ¥¹ÕÑ•Ì€ø€À¤¹±•¹Ñ ì(€€€½¹ÍĞ½¹Q¥µ••Á…ÉÑÕÉ•½Õ¹Ğ€ô‘•Á…ÉÑÕÉ••±…åÌ¹±•¹Ñ €´‘•±…å•‘•Á…ÉÑÕÉ•½Õ¹Ğì(€€€½¹ÍĞ…ÑÕ…±ÕÉ…Ñ¥½¹Ì€ôÑÉ¥ÁÌ(€€€€€€¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹…ÑÕ…±•Á…ÉÑÕÉ•Ğ€˜˜ÑÉ¥À¹…ÑÕ…±ÉÉ¥Ù…±Ğ¤(€€€€€€¹µ…À (€€€€€€€€¡ÑÉ¥À¤€ôø(€€€€€€€€€€¡ÑÉ¥À¹…ÑÕ…±ÉÉ¥Ù…±Ğ„¹•ÑQ¥µ” ¤€´ÑÉ¥À¹…ÑÕ…±•Á…ÉÑÕÉ•Ğ„¹•ÑQ¥µ” ¤¤€¼€ØÁ|ÀÀÀ°(€€€€€€¤(€€€€€€¹™¥±Ñ•È ¡µ¥¹ÕÑ•Ì¤€ôøµ¥¹ÕÑ•Ì€øô€À¤ì((€€€½¹ÍĞ…Ñ¥Ù•Y•¡¥±•%‘Ì€ô¹•ÜM•Ğ (€€€€€Ù•¡¥±•Ì¹™¥±Ñ•È ¡Ù•¡¥±”¤€ôøÙ•¡¥±”¹ÍÑ…ÑÕÌ€ôôô€Q%Yœ¤¹µ…À ¡Ù•¡¥±”¤€ôøÙ•¡¥±”¹¥¤°(€€€€¤ì(€€€½¹ÍĞÕÍ•‘Y•¡¥±•%‘Ì€ô¹•ÜM•Ğ (€€€€€ÑÉ¥ÁÌ¹µ…À ¡ÑÉ¥À¤€ôøÑÉ¥À¹Ù•¡¥±•%¤¹™¥±Ñ•È ¡¥¤è¥¥ÌÍÑÉ¥¹œ€ôø¥€„ôô¹Õ±°¤°(€€€€¤ì(€€€½¹ÍĞ…Ñ¥Ù•UÍ•‘Y•¡¥±•½Õ¹Ğ€ôl¸¸¹ÕÍ•‘Y•¡¥±•%‘Ít¹™¥±Ñ•È ¡¥¤€ôø…Ñ¥Ù•Y•¡¥±•%‘Ì¹¡…Ì¡¥¤¤¹±•¹Ñ ì(€€€½¹ÍĞ…ÍÍ¥¹•‘QÉ¥Á½Õ¹Ğ€ôÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹Ù•¡¥±•%€„ôô¹Õ±°¤¹±•¹Ñ ì((€€€½¹ÍĞÉ••¹ÑQÉ¥ÁÌ€ôÑÉ¥ÁÌ¹Í±¥” À°€ÈÔ¤¹µ…À ¡ÑÉ¥À¤€ôøì(€€€€€½¹ÍĞµ•ÑÉ¥Ì€ôÑÉ¥Á5•ÑÉ¥Ì¹•Ğ¡ÑÉ¥À¹¥¤„ì(€€€€€É•ÑÕÉ¸ì(€€€€€€€¥èÑÉ¥À¹¥°(€€€€€€€É•™•É•¹”èÑÉ¥À¹É•™•É•¹”°(€€€€€€€ÍÑ…ÑÕÌèÑÉ¥À¹ÍÑ…ÑÕÌ°(€€€€€€€Á±…¹¹•‘•Á…ÉÑÕÉ•ĞèÑÉ¥À¹Á±…¹¹•‘•Á…ÉÑÕÉ•Ğ°(€€€€€€€Á±…¹¹•‘ÉÉ¥Ù…±ĞèÑÉ¥À¹Á±…¹¹•‘ÉÉ¥Ù…±Ğ°(€€€€€€€É½ÕÑ”èì(€€€€€€€€€¥èÑÉ¥À¹É½ÕÑ•Y•ÉÍ¥½¸¹É½ÕÑ”¹¥°(€€€€€€€€€½‘”èÑÉ¥À¹É½ÕÑ•Y•ÉÍ¥½¸¹É½ÕÑ”¹½‘”°(€€€€€€€€€¹…µ”èÑÉ¥À¹É½ÕÑ•Y•ÉÍ¥½¸¹É½ÕÑ”¹¹…µ”°(€€€€€€€€€Ù•ÉÍ¥½¸èÑÉ¥À¹É½ÕÑ•Y•ÉÍ¥½¸¹Ù•ÉÍ¥½¸°(€€€€€€€ô°(€€€€€€€Ù•¡¥±”èÑÉ¥À¹Ù•¡¥±”€üì¥èÑÉ¥À¹Ù•¡¥±•%„°½‘”èÑÉ¥À¹Ù•¡¥±”¹½‘”ô€è¹Õ±°°(€€€€€€€‰½½­¥¹½Õ¹Ğèµ•ÑÉ¥Ì¹‰½½­¥¹½Õ¹Ğ°(€€€€€€€…¹•±±•‘	½½­¥¹½Õ¹Ğèµ•ÑÉ¥Ì¹…¹•±±•‘	½½­¥¹½Õ¹Ğ°(€€€€€€€Á…ÍÍ•¹•É½Õ¹Ğèµ•ÑÉ¥Ì¹Á…ÍÍ•¹•É½Õ¹Ğ°(€€€€€€€Í½±‘M•…Ñ½Õ¹Ğèµ•ÑÉ¥Ì¹Í½±‘M•…Ñ½Õ¹Ğ°(€€€€€€€½™™•É•‘M•…Ñ…Á…¥ÑäèÑÉ¥À¹Í•…Ñ5…ÁY•ÉÍ¥½¸ü¹}½Õ¹Ğ¹•±±Ì€üü€À°(€€€€€€€±½…‘…Ñ½ÈèÍ…™•I…Ñ”¡µ•ÑÉ¥Ì¹Í½±‘M•…Ñ½Õ¹Ğ°ÑÉ¥À¹Í•…Ñ5…ÁY•ÉÍ¥½¸ü¹}½Õ¹Ğ¹•±±Ì€üü€À¤°(€€€€€€€¥¹¥‘•¹Ñ½Õ¹Ğèµ•ÑÉ¥Ì¹¥¹¥‘•¹Ñ½Õ¹Ğ°(€€€€€€€ÕÉÉ•¹¥•ÌèÍ½ÉÑ•‘5½¹•ä¡µ•ÑÉ¥Ì¹µ½¹•ä¤°(€€€€€ôì(€€€ô¤ì((€€€½¹ÍĞÉ½ÕÑ•Ì€ôl¸¸¹É½ÕÑ•5•ÑÉ¥Ì¹Ù…±Õ•Ì ¥t(€€€€€€¹Í½ÉĞ ¡„°ˆ¤€ôøˆ¹ÑÉ¥Á½Õ¹Ğ€´„¹ÑÉ¥Á½Õ¹Ğñğˆ¹Í½±‘M•…Ñ½Õ¹Ğ€´„¹Í½±‘M•…Ñ½Õ¹Ğ¤(€€€€€€¹Í±¥” À°€ÈÀ¤(€€€€€€¹µ…À ¡É½ÕÑ”¤€ôø€¡ì(€€€€€€€É½ÕÑ•Y•ÉÍ¥½¹%èÉ½ÕÑ”¹É½ÕÑ•Y•ÉÍ¥½¹%°(€€€€€€€É½ÕÑ•%èÉ½ÕÑ”¹É½ÕÑ•%°(€€€€€€€É½ÕÑ•½‘”èÉ½ÕÑ”¹É½ÕÑ•½‘”°(€€€€€€€É½ÕÑ•9…µ”èÉ½ÕÑ”¹É½ÕÑ•9…µ”°(€€€€€€€É½ÕÑ•Y•ÉÍ¥½¸èÉ½ÕÑ”¹É½ÕÑ•Y•ÉÍ¥½¸°(€€€€€€€ÑÉ¥Á½Õ¹ĞèÉ½ÕÑ”¹ÑÉ¥Á½Õ¹Ğ°(€€€€€€€Á…ÍÍ•¹•É½Õ¹ĞèÉ½ÕÑ”¹Á…ÍÍ•¹•É½Õ¹Ğ°(€€€€€€€Í½±‘M•…Ñ½Õ¹ĞèÉ½ÕÑ”¹Í½±‘M•…Ñ½Õ¹Ğ°(€€€€€€€½™™•É•‘M•…Ñ…Á…¥ÑäèÉ½ÕÑ”¹½™™•É•‘M•…Ñ…Á…¥Ñä°(€€€€€€€±½…‘…Ñ½ÈèÍ…™•I…Ñ”¡É½ÕÑ”¹Í½±‘M•…Ñ½Õ¹Ğ°É½ÕÑ”¹½™™•É•‘M•…Ñ…Á…¥Ñä¤°(€€€€€€€…¹•±±…Ñ¥½¹½Õ¹ĞèÉ½ÕÑ”¹…¹•±±…Ñ¥½¹½Õ¹Ğ°(€€€€€€€¥¹¥‘•¹Ñ½Õ¹ĞèÉ½ÕÑ”¹¥¹¥‘•¹Ñ½Õ¹Ğ°(€€€€€€€ÕÉÉ•¹¥•ÌèÍ½ÉÑ•‘5½¹•ä¡É½ÕÑ”¹µ½¹•ä¤°(€€€€€ô¤¤ì(((€€€É•ÑÕÉ¸ì(€€€€€Á•É¥½èì(€€€€€€€™É½´èÅÕ•Éä¹™É½´°(€€€€€€€Ñ¼èÅÕ•Éä¹Ñ¼°(€€€€€€€Í•µ…¹Ñ¥Ìè€m™É½´±Ñ¼¤½¸ÑÉ¥À¹Á±…¹¹•‘•Á…ÉÑÕÉ•Ğœ…Ì½¹ÍĞ°(€€€€€ô°(€€€€€™¥±Ñ•ÉÌèì(€€€€€€€É½ÕÑ•%èÅÕ•Éä¹É½ÕÑ•%€üü¹Õ±°°(€€€€€€€ÑÉ¥Á%èÅÕ•Éä¹ÑÉ¥Á%€üü¹Õ±°°(€€€€€€€Ù•¡¥±•%èÅÕ•Éä¹Ù•¡¥±•%€üü¹Õ±°°(€€€€€€€ÍÑ…ÑÕÌèÅÕ•Éä¹ÍÑ…ÑÕÌ€üü¹Õ±°°(€€€€€ô°(€€€€€…Ñ¥Ù¥Ñäèì(€€€€€€€ÑÉ¥Á½Õ¹Ğ°(€€€€€€€‘É…™ÑQÉ¥Á½Õ¹ĞèÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹ÍÑ…ÑÕÌ€ôôô€IPœ¤¹±•¹Ñ °(€€€€€€€Í¡•‘Õ±•‘QÉ¥Á½Õ¹ĞèÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹ÍÑ…ÑÕÌ€ôôô€M!U1œ¤¹±•¹Ñ °(€€€€€€€¥¹AÉ½É•ÍÍQÉ¥Á½Õ¹ĞèÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹ÍÑ…ÑÕÌ€ôôô€%9}AI=IMLœ¤¹±•¹Ñ °(€€€€€€€½µÁ±•Ñ•‘QÉ¥Á½Õ¹ĞèÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹ÍÑ…ÑÕÌ€ôôô€=5A1Qœ¤¹±•¹Ñ °(€€€€€€€…¹•±±•‘QÉ¥Á½Õ¹ĞèÑÉ¥ÁÌ¹™¥±Ñ•È ¡ÑÉ¥À¤€ôøÑÉ¥À¹ÍÑ…ÑÕÌ€ôôô€911œ¤¹±•¹Ñ °(€€€€€ô°(€€€€€½µµ•É¥…°èì(€€€€€€€‰½½­¥¹½Õ¹Ğè‰½½­¥¹Ì¹±•¹Ñ °(€€€€€€€½¹™¥Éµ•‘	½½­¥¹½Õ¹Ğ°(€€€€€€€…¹•±±•‘	½½­¥¹½Õ¹Ğ°(€€€€€€€Á…ÍÍ•¹•É½Õ¹Ğ°(€€€€€€€Í½±‘M•…Ñ½Õ¹Ğ°(€€€€€€€½™™•É•‘M•…Ñ…Á…¥Ñä°(€€€€€€€±½…‘…Ñ½ÈèÍ…™•I…Ñ”¡Í½±‘M•…Ñ½Õ¹Ğ°½™™•É•‘M•…Ñ…Á…¥Ñä¤°(€€€€€€€…¹•±±…Ñ¥½¹I…Ñ”èÍ…™•I…Ñ”¡…¹•±±•‘	½½­¥¹½Õ¹Ğ°‰½½­¥¹Ì¹±•¹Ñ ¤°(€€€€€ô°(€€€€€™¥¹…¹”èì(€€€€€€€ÕÉÉ•¹¥•ÌèÍ½ÉÑ•‘5½¹•ä¡…±±5½¹•ä°½µµ•É¥…±	åÕÉÉ•¹ä°ÁÉ½™¥Ñ…‰¥±¥Ñå	åÕÉÉ•¹ä¤°(€€€€€€€™á½¹Ù•ÉÍ¥½¹ÁÁ±¥•è™…±Í”…Ì½¹ÍĞ°(€€€€€ô°(€€€€€½Á•É…Ñ¥½¹Ìèì(€€€€€€€‘•Á…ÉÑÕÉ•M…µÁ±•½Õ¹Ğè‘•Á…ÉÑÕÉ••±…åÌ¹±•¹Ñ °(€€€€€€€½¹Q¥µ••Á…ÉÑÕÉ•½Õ¹Ğ°(€€€€€€€‘•±…å•‘•Á…ÉÑÕÉ•½Õ¹Ğ°(€€€€€€€…Ù•É…••±…å5¥¹ÕÑ•Ìè(€€€€€€€€€‘•Á…ÉÑÕÉ••±…åÌ¹±•¹Ñ €ø€À(€€€€€€€€€€€€ü‘•Á…ÉÑÕÉ••±…åÌ¹É•‘Õ” ¡ÍÕ´°Ù…±Õ”¤€ôøÍÕ´€¬Ù…±Õ”°€À¤€¼‘•Á…ÉÑÕÉ••±…åÌ¹±•¹Ñ (€€€€€€€€€€€€è¹Õ±°°(€€€€€€€µ…á¥µÕµ•±…å5¥¹ÕÑ•Ìè(€€€€€€€€€‘•Á…ÉÑÕÉ••±…åÌ¹±•¹Ñ €ø€À€ü5…Ñ ¹µ…à ¸¸¹‘•Á…ÉÑÕÉ••±…åÌ¤€è¹Õ±°°(€€€€€€€…ÑÕ…±ÕÉ…Ñ¥½¹M…µÁ±•½Õ¹Ğè…ÑÕ…±ÕÉ…Ñ¥½¹Ì¹±•¹Ñ °(€€€€€€€…Ù•É…•ÑÕ…±ÕÉ…Ñ¥½¹5¥¹ÕÑ•Ìè(€€€€€€€€€…ÑÕ…±ÕÉ…Ñ¥½¹Ì¹±•¹Ñ €ø€À(€€€€€€€€€€€€ü…ÑÕ…±ÕÉ…Ñ¥½¹Ì¹É•‘Õ” ¡ÍÕ´°Ù…±Õ”¤€ôøÍÕ´€¬Ù…±Õ”°€À¤€¼…ÑÕ…±ÕÉ…Ñ¥½¹Ì¹±•¹Ñ (€€€€€€€€€€€€è¹Õ±°°(€€€€€ô°(€€€€€¥¹¥‘•¹ÑÌèì(€€€€€€€¥¹¥‘•¹Ñ½Õ¹Ğè¥¹¥‘•¹ÑÌ¹±•¹Ñ °(€€€€€€€½Á•¹%¹¥‘•¹Ñ½Õ¹Ğè¥¹¥‘•¹ÑÌ¹™¥±Ñ•È (€€€€€€€€€€¡¥¹¥‘•¹Ğ¤€ôø¥¹¥‘•¹Ğ¹ÍÑ…ÑÕÌ€„ôô€IM=1Yœ€˜˜¥¹¥‘•¹Ğ¹ÍÑ…ÑÕÌ€„ôô€1=Mœ°(€€€€€€€€¤¹±•¹Ñ °(€€€€€€€É•Í½±Ù•‘%¹¥‘•¹Ñ½Õ¹Ğ°(€€€€€€€Í•Ù•É¥Ñä°(€€€€€€€…Ù•É…•I•Í½±ÕÑ¥½¹5¥¹ÕÑ•Ìè(€€€€€€€€€É•Í½±ÕÑ¥½¹M…µÁ±•½Õ¹Ğ€ø€À€üÉ•Í½±ÕÑ¥½¹5¥¹ÕÑ•Ì€¼É•Í½±ÕÑ¥½¹M…µÁ±•½Õ¹Ğ€è¹Õ±°°(€€€€€ô°(€€€€€‰……”èì(€€€€€€€‰……•½Õ¹Ğè‰……”¹±•¹Ñ °(€€€€€€€±½…‘•‘	……•½Õ¹Ğ°(€€€€€€€‘•±¥Ù•É•‘	……•½Õ¹Ğ°(€€€€€€€…¹½µ…±å	……•½Õ¹Ğè‰……•¹½µ…±å½Õ¹Ğ°(€€€€€€€‰……•%¹¥‘•¹Ñ½Õ¹Ğè¥¹¥‘•¹ÑÌ¹™¥±Ñ•È ¡¥¹¥‘•¹Ğ¤€ôø¥¹¥‘•¹Ğ¹ÑåÁ”€ôôô€	œ¤¹±•¹Ñ °(€€€€€€€…¹½µ…±åI…Ñ”èÍ…™•I…Ñ”¡‰……•¹½µ…±å½Õ¹Ğ°‰……”¹±•¹Ñ ¤°(€€€€€ô°(€€€€€™±••Ğèì(€€€€€€€Ù•¡¥±•½Õ¹ĞèÙ•¡¥±•Ì¹±•¹Ñ °(€€€€€€€…Ñ¥Ù•Y•¡¥±•½Õ¹Ğè…Ñ¥Ù•Y•¡¥±•%‘Ì¹Í¥é”°(€€€€€€€½ÕÑ=™M•ÉÙ¥•Y•¡¥±•½Õ¹ĞèÙ•¡¥±•Ì¹™¥±Ñ•È ¡Ù•¡¥±”¤€ôøÙ•¡¥±”¹ÍÑ…ÑÕÌ€ôôô€=UQ}=}MIY%œ¤(€€€€€€€€€€¹±•¹Ñ °(€€€€€€€É•Ñ¥É•‘Y•¡¥±•½Õ¹ĞèÙ•¡¥±•Ì¹™¥±Ñ•È ¡Ù•¡¥±”¤€ôøÙ•¡¥±”¹ÍÑ…ÑÕÌ€ôôô€IQ%Iœ¤¹±•¹Ñ °(€€€€€€€ÕÍ•‘Y•¡¥±•½Õ¹ĞèÕÍ•‘Y•¡¥±•%‘Ì¹Í¥é”°(€€€€€€€…Ñ¥Ù•UÍ•‘Y•¡¥±•½Õ¹Ğ°(€€€€€€€ÕÑ¥±¥é…Ñ¥½¹I…Ñ”èÍ…™•I…Ñ”¡…Ñ¥Ù•UÍ•‘Y•¡¥±•½Õ¹Ğ°…Ñ¥Ù•Y•¡¥±•%‘Ì¹Í¥é”¤°(€€€€€€€ÑÉ¥ÁÍA•ÉUÍ•‘Y•¡¥±”èÍ…™•I…Ñ”¡…ÍÍ¥¹•‘QÉ¥Á½Õ¹Ğ°ÕÍ•‘Y•¡¥±•%‘Ì¹Í¥é”¤°(€€€€€ô°(€€€€€É½ÕÑ•Ì°(€€€€€É••¹ÑQÉ¥ÁÌ°(€€€€€ÁÉ¥Ù…äèì½¹Ñ…¥¹ÍA…ÍÍ•¹•ÉA¥¤è™…±Í”…Ì½¹ÍĞô°(€€€ôì(€ô)ô(