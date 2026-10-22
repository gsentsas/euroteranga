import { currencyKey } from './finance-rules.js';

export interface FinanceSummaryPaymentInput {
  amountMinor: bigint;
  currencyCode: string;
  currencyMinorUnit: number;
  refunds: Array<{ amountMinor: bigint }>;
}

export interface FinanceSummaryRevenueInput {
  status: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyMinorUnit: number;
}

export interface FinanceSummaryExpenseInput {
  status: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyMinorUnit: number;
  payouts: Array<{ amountMinor: bigint }>;
}

interface CurrencyBucket {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: bigint;
  additionalRevenueMinor: bigint;
  refundMinor: bigint;
  expenseMinor: bigint;
  payoutMinor: bigint;
}

export interface FinanceCurrencyProjection {
  currencyCode: string;
  currencyMinorUnit: number;
  ticketRevenueMinor: string;
  additionalRevenueMinor: string;
  grossRevenueMinor: string;
  refundMinor: string;
  netRevenueMinor: string;
  expenseMinor: string;
  contributionMinor: string;
  payoutMinor: string;
  outstandingExpenseMinor: string;
}

function bucket(
  buckets: Map<string, CurrencyBucket>,
  currencyCode: string,
  currencyMinorUnit: number,
): CurrencyBucket {
  const key = currencyKey(currencyCode, currencyMinorUnit);
  const current = buckets.get(key);
  if (current) return current;
  const created: CurrencyBucket = {
    currencyCode,
    currencyMinorUnit,
    ticketRevenueMinor: 0n,
    additionalRevenueMinor: 0n,
    refundMinor: 0n,
    expenseMinor: 0n,
    payoutMinor: 0n,
  };
  buckets.set(key, created);
  return created;
}

/**
 * Single source of truth for operational Finance currency buckets.
 * No FX, no floating-point money, and no cross-currency total.
 */
export function buildFinanceCurrencySummary(input: {
  payments: readonly FinanceSummaryPaymentInput[];
  revenues: readonly FinanceSummaryRevenueInput[];
  expenses: readonly FinanceSummaryExpenseInput[];
}): FinanceCurrencyProjection[] {
  const buckets = new Map<string, CurrencyBucket>();

  for (const payment of input.payments) {
    const current = bucket(buckets, payment.currencyCode, payment.currencyMinorUnit);
    current.ticketRevenueMinor += payment.amountMinor;
    for (const refund of payment.refunds) current.refundMinor += refund.amountMinor;
  }

  for (const revenue of input.revenues) {
    if (revenue.status !== 'ACTIVE') continue;
    bucket(buckets, revenue.currencyCode, revenue.currencyMinorUnit).additionalRevenueMinor +=
      revenue.amountMinor;
  }

  for (const expense of input.expenses) {
    if (expense.status !== 'ACTIVE') continue;
    const current = bucket(buckets, expense.currencyCode, expense.currencyMinorUnit);
    current.expenseMinor += expense.amountMinor;
    for (const payout of expense.payouts) current.payoutMinor += payout.amountMinor;
  }

  return [...buckets.values()]
    .sort((left, right) =>
      left.currencyCode === right.currencyCode
        ? left.currencyMinorUnit - right.currencyMinorUnit
        : left.currencyCode.localeCompare(right.currencyCode),
    )
    .map((current) => {
      const grossRevenue = current.ticketRevenueMinor + current.additionalRevenueMinor;
      const netRevenue = grossRevenue - current.refundMinor;
      return {
        currencyCode: current.currencyCode,
        currencyMinorUnit: current.currencyMinorUnit,
        ticketRevenueMinor: current.ticketRevenueMinor.toString(),
        additionalRevenueMinor: current.additionalRevenueMinor.toString(),
        grossRevenueMinor: grossRevenue.toString(),
        refundMinor: current.refundMinor.toString(),
        netRevenueMinor: netRevenue.toString(),
        expenseMinor: current.expenseMinor.toString(),
        contributionMinor: (netRevenue - current.expenseMinor).toString(),
        payoutMinor: current.payoutMinor.toString(),
        outstandingExpenseMinor: (current.expenseMinor - current.payoutMinor).toString(),
      };
    });
}
