# Provider routing (PAY-HUB-1, PAY-EU-1)

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

PAY-EU-1 adds, per provider:

| Field                         | Meaning                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `methodCountries`             | Narrower countries of some methods (Stripe: Bizum in Spain only).                              |
| `amountLimits`                | Presentment bounds per method and country (Stripe: 0.50 EUR minimum, Bizum and Klarna maxima). |
| `cardNetworks`                | Networks accepted for `CARD`, per country: badges of the card option, never choices.           |
| `deviceWallets`               | Wallets its card page may add on an eligible device (never a promise, never a choice).         |
| `collectionWindowSeconds`     | How long its checkout stays payable (Stripe: 31 minutes); null without a checkout of its own.  |
| `minimumHoldRemainingSeconds` | Hold time that must remain to start (Stripe: 36 minutes, the window plus 5).                   |
| `excludedMethods`             | Methods it could offer but does not collect for EURO TERANGA, with the documented reason.      |

A declaration alone never makes a provider routable: only an **injected,
active adapter** is (`PAYMENT_PROVIDERS`). Adapters: SANDBOX (local and CI)
and, since PAY-EU-1, STRIPE (only with `PAYMENT_STRIPE_MODE` TEST or LIVE;
DISABLED by default).

## Fail-closed conditions

A provider collects a request only if **all** hold
(`capabilityCollects`):

1. it is active and declares the method, the payer country (and the method's
   own countries, if narrower) and the presentment currency;
2. the method is not `ASYNC_LONG` (days to confirm: SEPA debit, bank transfer,
   cash). A hold cannot wait that long, so such methods are unavailable until
   an explicit booking policy exists
   (`ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY`), whatever the provider,
   SANDBOX included;
3. the presentment amount is within the provider's bounds for that method and
   country;
4. the hold has at least `minimumHoldRemainingSeconds` left, so the
   provider's checkout closes before the seats can be freed.

The same check runs for the options (with the converted amount and the hold
left), the quote (on the locked booking) and the initiation (on the quote's
amount).

## How a payment is routed

1. **Options.** For a booking and a payer country, each method of the
   catalogue is `available` only if an active adapter collects it (the
   conditions above) and the amount can be converted. A `CARD` option also
   lists the accepted networks and possible device wallets of the provider
   that would collect it, and nothing when none would.
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
  booking reference, the method, the payer country, the **presentment**
  amount and currency, and the deadline of its checkout (the attempt's
  creation plus its collection window, so a replay sends the same request).
  Never a password, session, PIN, OTP, card number or security code.
- A provider's redirect URL only tells the browser where to go; returning
  from it confirms nothing. Only an authenticated provider event does.

## Tests

- PAY-EU-1: Stripe routing (FR and ES cards, Bizum in Spain only, Klarna;
  nothing in MA, MR, SN or another currency; Wero, Alma, SEPA and wallets
  never), amounts, hold window, `ASYNC_LONG` (`stripe-payment.provider.spec.ts`,
  `stripe-payments.int.spec.ts`).

- Unit: priority, candidate first, stable tie-break, same-method fallback, no
  cross-method fallback, countries and currencies (`payment-capability.registry.spec.ts`).
- Integration: synthetic WAVE, PAYDUNYA and STRIPE adapters; Wave down after
  the quote → PAYDUNYA collects the presentment amount; nobody left for Wave
  → refused, the card provider never called (`payment-hub.int.spec.ts`).
