# Settlement and reconciliation (PAY-HUB-1)

Three facts, at three moments, in three models:

| Fact                  | Model               | When                                  | Changes              |
| --------------------- | ------------------- | ------------------------------------- | -------------------- |
| The payer was quoted  | `PaymentQuote`      | Before the attempt                    | Nothing (immutable)  |
| The payment succeeded | `Payment` SUCCEEDED | On the provider's authenticated event | Confirms the booking |
| The money was settled | `PaymentSettlement` | Later, from the provider or the bank  | Nothing else, ever   |

**`Payment.SUCCEEDED` is not "settlement received".** A settlement arriving
days later never changes the payment or the booking retroactively. Provider
settlements are also **not** the operating-expense `Payout` of PR-22.

## PaymentSettlement (foundation)

PAY-HUB-1 creates the table and its guards; no service writes it yet (each
provider PR adds its settlement import). One row per settled payment:

| Column                                                   | Meaning                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `paymentId`                                              | The SUCCEEDED payment (unique: one settlement per payment).      |
| `provider`, `providerTransactionId`                      | Must be the payment's provider and its `providerPaymentId`.      |
| `settlementReference`                                    | The provider's or bank's batch reference (unique per provider).  |
| `grossAmountMinor`, `providerFeeMinor`, `netAmountMinor` | Net = gross − fee, fee ≥ 0 (CHECK).                              |
| `settlementCurrencyCode`, `settlementCurrencyMinorUnit`  | May differ from both the booking and the presentment currency.   |
| `settledAt`                                              | When the provider settled (never more than 5 min in the future). |
| `recordedAt`                                             | Set by PostgreSQL when the row is written.                       |

Guards (`payment_settlement_guard`): only for a SUCCEEDED payment, with its
own provider transaction; immutable (no update, delete or truncate). There is
no parallel ledger: finance keeps reading `Payment` amounts (booking currency),
and the settlement is the reconciliation evidence.

## Reconciling

For a provider and a period:

1. every SUCCEEDED payment of that provider should eventually have one
   settlement; a missing one is a reconciliation item, not a payment error;
2. the settled gross is compared with the quote's presentment amount (what
   the payer was asked for), and the fee is recorded as such;
3. the booking amount (`Payment.amountMinor`) stays the business amount.

STAFF can already filter attempts by provider, method, payer country,
presentment currency and creation period (`GET /v1/admin/payments`), and the
staff view shows each attempt's quote (method, country, presented amount,
rate).
