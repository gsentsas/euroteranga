# Provider routing (PAY-HUB-1)

A **method** is what the customer chooses (Wave, a CB card, Bankily). A
**provider** is who collects it (Wave directly, an aggregator such as
PayDunya or PayTech, a card acquirer). The two are kept apart everywhere:
the catalogue lists methods (`payment-catalog.ts`), the capability registry
lists providers (`payment-capability.registry.ts`), and the customer never
sees a provider name.

## Capabilities

Each provider declares, once:

| Field                                                       | Meaning                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `providerCode`                                              | `SANDBOX`, `STRIPE`, `PAYPAL`, `PAYDUNYA`, `PAYTECH`, `WAVE`, … |
| `supportedMethods`, `payerCountries`, `supportedCurrencies` | What it can collect, for whom, in which currency.               |
| `testMode`                                                  | Moves no real money (SANDBOX).                                  |
| `refundCapabilities`, `partialRefundCapabilities`           | `NONE`, `FULL` or `FULL_AND_PARTIAL`; partial refunds allowed.  |
| `webhookCapabilities`                                       | Signed events, replay protection, timestamp check.              |
| `instantConfirmation`, `requiresRedirect`, `requiresPhone`  | How the payer completes it.                                     |
| `requiresMerchantEntityCountry`                             | Countries where EURO TERANGA needs a merchant entity.           |
| `priority`                                                  | Lower is preferred. Internal only, never returned to a client.  |
| `active`                                                    | Runtime switch of an adapter.                                   |

A declaration alone never makes a provider routable: only an **injected,
active adapter** is (`PAYMENT_PROVIDERS`). In PAY-HUB-1 the only adapter is
SANDBOX, in local and CI.

## How a payment is routed

1. **Options.** For a booking and a payer country, each method of the
   catalogue is `available` only if an active adapter collects that method,
   in that country, in the presentment currency, and the amount can be
   converted.
2. **Quote.** `POST …/payment-quotes` checks the same, then stores the
   chosen method, the country, the amounts and the best provider as
   `providerCandidate` (internal, never shown).
3. **Initiation.** `POST …/payments` routes again for **the quote's method**,
   the quote's candidate first:
   - candidate still active → it collects;
   - candidate down → the next active provider **of the same method**
     (Wave direct → PayDunya → PayTech, by priority, then code);
   - nobody collects that method → `PAYMENT_METHOD_UNAVAILABLE`, and nothing
     is created.

There is **never a fallback to another method**: a Wave payment is never
charged to a card, even when a card provider is active. The customer chooses
another method, and gets a new quote.

## Safety rules kept from PR-10

- The PENDING attempt is committed **before** the provider is called, and no
  database transaction is open during the call.
- A PENDING attempt keeps its provider: a replay never re-routes it.
- The provider receives the payment reference (its idempotency key), the
  booking reference, the method, the payer country and the **presentment**
  amount and currency. Never a password, session, PIN, OTP, card number or
  security code.
- A provider's redirect URL only tells the browser where to go; returning
  from it confirms nothing. Only an authenticated provider event does.

## Tests

- Unit: priority, candidate first, stable tie-break, same-method fallback, no
  cross-method fallback, countries and currencies (`payment-capability.registry.spec.ts`).
- Integration: synthetic WAVE, PAYDUNYA and STRIPE adapters; Wave down after
  the quote → PAYDUNYA collects the presentment amount; nobody left for Wave
  → refused, the card provider never called (`payment-hub.int.spec.ts`).
