# Operational finance

PR-22 adds trip-level operational finance to EURO TERANGA. It is deliberately
**not** a general ledger, statutory accounting system, tax engine or ERP.

## Boundary

The domain answers operational questions: succeeded ticket revenue per trip,
additional baggage/options revenue, refunds, trip expenses, settlement and
contribution **per currency**.

It does not implement a chart of accounts, journal, trial balance, FEC,
statutory VAT/tax rules, bank reconciliation, foreign-exchange policy, or a
real PSP refund API. A `CreditNote` is an operational credit memo paired with
a refund; it is not presented as a statutory tax invoice.

The editable pre-departure estimate in [trip-costs.md](trip-costs.md) is also a
separate source: a planned `TripCostItem` is not an incurred `TripExpense` and
is never included in contribution or settlement.

## Sources of truth

Ticket revenue is never duplicated: it is derived from existing
`Payment(status=SUCCEEDED)` rows.

PR-22 adds:

- `TripRevenue`: additional revenue only (`BAGGAGE`, `OPTION`, `OTHER`);
- `TripExpense`: fuel, ferry, toll, crew, hotel, maintenance, border,
  insurance or other operational expense;
- `Refund`: a refund fact against one succeeded payment;
- `CreditNote`: one-to-one operational memo, created atomically with refund;
- `Payout`: settlement of an expense;
- `FinanceReceipt`: private evidence for an expense.

A payout never creates a second expense.

## Exact money and currencies

All values are integer minor units. PR-22 JSON exposes amounts as strings so
the browser cannot round a BIGINT.

Contribution is computed independently for each
`(currencyCode, currencyMinorUnit)` bucket:

```text
gross revenue = succeeded ticket payments + active additional revenues
net revenue   = gross revenue - refunds
contribution  = net revenue - active expenses
outstanding   = active expenses - payouts
```

No cross-currency total is produced. The API returns
`fxConversionApplied: false`.

## Refund and cancellation invariant

A refund targets a `SUCCEEDED` payment, uses the exact payment currency,
is positive, is idempotent by `(paymentId, clientRefundId)`, and cumulative
refunds cannot exceed the payment amount. A matching `CreditNote` is created
in the same transaction.

The payment row is locked before refund insertion, so concurrent refunds
serialize and cannot over-refund. PR-22 records the operational fact only:
SANDBOX moves no real money and no external refund network call occurs.

A confirmed booking remains non-cancellable while only partially refunded.
After full refund, cancellation may release its seats and inventory locks.
A trip still refuses cancellation while any confirmed booking is not fully
refunded. The lock hierarchy remains:

```text
trip -> payment -> booking -> booking seats -> seat locks
```

## History

Revenue and expense facts are immutable after insertion. Corrections are
`ACTIVE -> VOIDED` with actor, database timestamp and mandatory reason.
Voided rows are terminal. An expense with a payout cannot be voided.

`Refund`, `CreditNote`, `Payout` and `FinanceReceipt` are append-only.
Finance history tables reject `TRUNCATE`.

## Receipts and exports

Receipts reuse private object storage and malware scanning. PDF, JPEG and PNG
are accepted. PostgreSQL stores only private object key, SHA-256, MIME type,
size, uploader and timestamp; the object key is never exposed to the browser.
Downloads are authenticated, authorized, audited and `private, no-store`.

CSV and XLSX exports contain the same operational projection and preserve
currencies separately. They are not accounting exports and are not FEC files.

## RBAC

| Permission       | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `finance.read`   | Read trip finance, refunds and settlements; download receipts/exports |
| `finance.manage` | Record/void additional revenue and expenses, payouts and receipts     |
| `payment.refund` | Record bounded refunds against succeeded payments                     |

Default grants: SUPER_ADMIN, DIRECTOR and FINANCE receive all three;
OPS_MANAGER and AUDITOR receive `finance.read` only.

## API

All routes are under `/v1/admin/finance`.

| Method | Route                                               | Permission       |
| ------ | --------------------------------------------------- | ---------------- |
| GET    | `/trips/:tripReference`                             | `finance.read`   |
| POST   | `/trips/:tripReference/revenues`                    | `finance.manage` |
| POST   | `/trips/:tripReference/expenses`                    | `finance.manage` |
| POST   | `/revenues/:reference/void`                         | `finance.manage` |
| POST   | `/expenses/:reference/void`                         | `finance.manage` |
| POST   | `/payments/:paymentReference/refunds`               | `payment.refund` |
| POST   | `/expenses/:reference/payouts`                      | `finance.manage` |
| POST   | `/expenses/:reference/receipts`                     | `finance.manage` |
| GET    | `/expenses/:reference/receipts/:receiptId/download` | `finance.read`   |
| GET    | `/trips/:tripReference/export.csv`                  | `finance.read`   |
| GET    | `/trips/:tripReference/export.xlsx`                 | `finance.read`   |

## Audit

PR-22 records `FINANCE_TRIP_ACCESSED`, revenue/expense recorded and voided
events, `PAYMENT_REFUNDED`, `FINANCE_PAYOUT_RECORDED`,
`FINANCE_RECEIPT_UPLOADED` and `FINANCE_RECEIPT_ACCESSED`. Exact amounts
are stringified in audit metadata; private object keys and provider secrets
are never logged.
