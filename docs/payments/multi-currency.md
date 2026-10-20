# Multi-currency payments (PAY-HUB-1)

## Two amounts, never confused

| Amount             | Where                                                  | Meaning                                                                                                           |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Booking amount     | `Payment.amountMinor`, `Payment.currencyCode`          | The ticket's business amount, exactly as in PR-10 (for example 24900 EUR). Finance, refunds and reporting use it. |
| Presentment amount | `PaymentQuote.presentmentAmountMinor`, `…CurrencyCode` | What the payer is asked for, in the currency of their country (for example 163333 XOF).                           |

`Payment.amountMinor` never becomes an FX amount. Settlement by the provider
is a third, later fact (see [reconciliation.md](reconciliation.md)).

## PaymentQuote

An immutable snapshot, created by the server for an active hold:

- the booking amount, currency and minor unit (the exact booking total);
- the presentment amount, currency and minor unit;
- the payer country and the payment method;
- `fxRate` (exact decimal, booking major unit → presentment major unit),
  `fxSource`, `quotedAt`, `expiresAt`;
- `providerCandidate` (internal, never shown).

Rules, enforced by the API and by PostgreSQL (`payment_quote_guard` and
CHECK constraints):

- created only for an active hold of a SCHEDULED trip, never outliving the
  hold; the booking amount must be the exact booking total;
- the presented amount is the booking amount at the stored rate:
  `round_half_up(booking × rate × 10^(presentment minor unit − booking minor unit))`
  (`payment_quote_presentment_from_rate`);
- same currency → `FX_IDENTITY`, rate 1, same amount; different currencies →
  never `FX_IDENTITY`;
- presentment currencies EUR (2), XOF (0), MAD (2), MRU (2); payer countries
  FR, ES, MA, MR, SN;
- immutable: never updated, deleted or truncated. A new price is a new quote;
- valid 10 minutes, and never beyond the hold. An expired quote starts no
  attempt (`PAYMENT_QUOTE_EXPIRED`), and one quote serves one attempt only
  (`PAYMENT_QUOTE_ALREADY_USED`);
- the client only sends intentions (country, method); any amount, currency,
  rate or provider field is refused (400).

PR-10 attempts, made before quotes existed, keep `quote_id` NULL. No quote is
invented for them. Every attempt created after PAY-HUB-1 needs one
(`payment_guard`).

## Rounding

Decimal arithmetic only (Prisma `Decimal`, 80 significant digits), never a
JavaScript `number`. The rate is stored with 12 decimals (`DECIMAL(30, 12)`),
and the amount is computed from the stored rate, rounded half up to the
presentment minor unit: the API and the database CHECK give the same result
for the same input. Examples with the synthetic CI rates: 249.00 EUR →
163 333 XOF (163 333.293); 0.01 EUR → 7 XOF (6.55957).

## FX sources

| Source                | State in PAY-HUB-1                                                                      |
| --------------------- | --------------------------------------------------------------------------------------- |
| `FX_IDENTITY`         | Same currency: no rate needed. Works everywhere.                                        |
| `FX_SYNTHETIC_CI`     | Deterministic, non-commercial rates, **local and CI only** (`SyntheticCiFxRateSource`). |
| `FX_MANUAL_OPS`       | Declared: rates entered and approved in OPS. Later PR.                                  |
| `FX_PROVIDER`         | Declared: the rate applied by the PSP. Later PR.                                        |
| `FX_EXTERNAL_SERVICE` | Declared: a market feed. Later PR.                                                      |

Staging and production have **no rate source**: a quote between two
different currencies is refused (`PAYMENT_FX_UNAVAILABLE`), and the options
API marks those methods unavailable. No commercial rate is invented. The
synthetic table (EUR/XOF 655.957, the fixed parity; MAD 10.8 and MRU 43,
arbitrary test values) never leaves local and CI.

## Provider events

A provider event is accepted only when its amount and currency equal the
quote's **presentment** amount and currency, and the quote covers exactly the
payment's booking amount (`expectedProviderAmount`). A PR-10 attempt is
checked against its own amount. A mismatch is recorded (`AMOUNT_MISMATCH`,
`CURRENCY_MISMATCH`) and changes nothing.
