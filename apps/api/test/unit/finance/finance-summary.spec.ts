import { describe, expect, it } from 'vitest';
import { buildFinanceCurrencySummary } from '../../../src/finance/finance-summary.js';

describe('OPS-PROFIT finance currency projection', () => {
  it('keeps exact finance contribution per currency without double-counting payouts', () => {
    const result = buildFinanceCurrencySummary({
      payments: [
        {
          amountMinor: 30000n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          refunds: [{ amountMinor: 5000n }],
        },
      ],
      revenues: [
        {
          status: 'ACTIVE',
          amountMinor: 10000n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
        },
        {
          status: 'VOIDED',
          amountMinor: 999999n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
        },
      ],
      expenses: [
        {
          status: 'ACTIVE',
          amountMinor: 7000n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          payouts: [{ amountMinor: 3000n }],
        },
        {
          status: 'VOIDED',
          amountMinor: 999999n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          payouts: [],
        },
        {
          status: 'ACTIVE',
          amountMinor: 50000n,
          currencyCode: 'XOF',
          currencyMinorUnit: 0,
          payouts: [],
        },
      ],
    });

    expect(result).toEqual([
      {
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        ticketRevenueMinor: '30000',
        additionalRevenueMinor: '10000',
        grossRevenueMinor: '40000',
        refundMinor: '5000',
        netRevenueMinor: '35000',
        expenseMinor: '7000',
        contributionMinor: '28000',
        payoutMinor: '3000',
        outstandingExpenseMinor: '4000',
      },
      {
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
        ticketRevenueMinor: '0',
        additionalRevenueMinor: '0',
        grossRevenueMinor: '0',
        refundMinor: '0',
        netRevenueMinor: '0',
        expenseMinor: '50000',
        contributionMinor: '-50000',
        payoutMinor: '0',
        outstandingExpenseMinor: '50000',
      },
    ]);
  });
});
