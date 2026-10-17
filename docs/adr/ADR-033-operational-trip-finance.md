# ADR-033 — Operational trip finance without a general ledger

- **Status:** Accepted
- **Date:** 2026-10-17
- **Scope:** PR-22

## Context

EURO TERANGA needs trip profitability, expense settlement and a refund
workflow before a real payment provider is selected. Existing succeeded
payments are already authoritative ticket revenue. Duplicating them or
combining EUR and XOF without an exchange-rate policy would create false
business facts.

## Decision

1. Ticket revenue remains derived from `Payment(status=SUCCEEDED)`.
2. Additional revenue, trip expenses, refunds, credit memos, payouts and
   receipt metadata use dedicated operational models.
3. All money is exact minor-unit integer data; PR-22 JSON uses strings.
4. Contribution is calculated per currency/minor-unit pair; no implicit FX.
5. Refund and matching credit memo are atomic and append-only.
6. A confirmed booking may be cancelled only after full refund.
7. Payout is settlement and never reduces contribution a second time.
8. Receipt bytes reuse private object storage and malware scanning.
9. CSV/XLSX are operational exports, never FEC/general-ledger output.
10. `finance.read`, `finance.manage` and `payment.refund` are separate
    capabilities.

## Consequences

The operational margin has one ticket-revenue source of truth.
Refund/cancellation races serialize on payment rows and preserve the
trip -> payment -> booking lock hierarchy. Cross-currency consolidation waits
for a future explicit FX domain. Production PSP refund/void integration,
statutory accounting, taxes, FEC and bank reconciliation remain out of scope.

## Alternatives rejected

- Duplicate succeeded payments into `TripRevenue`: risks double counting.
- Convert everything to EUR: no authoritative rate or valuation policy exists.
- Treat payouts as expenses: would double-count cost.
- Allow cancellation after a partial refund: would release confirmed inventory
  before the customer is fully refunded.
- Build a general ledger now: unvalidated statutory/accounting scope.
