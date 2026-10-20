# Provider routing (PAY-HUB-1, PAY-EU-1, PAY-PAYPAL-1, PAY-SN-1A)

A **method** is what the customer chooses (Wave, a CB card, Bankily). A
**provider** is who collects it (Wave directement, Stripe, PayPal, etc.). The
two are kept apart everywhere:
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

| Field                           | Meaning                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `methodCountries`               | Narrower countries of some methods (Stripe: Bizum in Spain only).                                                                                                                        |
| `amountLimits`                  | Presentment bounds per method and country (Stripe: 0.50 EUR minimum, Bizum and Klarna maxima).                                                                                           |
| `cardNetworks`                  | Networks accepted for `CARD`, per country: badges of the card option, never choices.                                                                                                     |
| `deviceWallets`                 | Wallets its card page may add on an eligible device (never a promise, never a choice).                                                                                                   |
| `collectionWindowSeconds`       | How long its checkout stays payable (Stripe: 31 minutes); null without a checkout of its own.                                                                                            |
| `minimumHoldRemainingSeconds`   | Hold time that must remain to start (Stripe: 36 minutes, the window plus 5).                                                                                                             |
| `excludedMethods`               | Methods it could offer but does not collect for EURO TERANGA, with the documented reason.                                                                                                |
| `localCancelPreventsCollection` | PAY-PAYPAL-1: no money moves unless EURO TERANGA asks for it (SANDBOX, PayPal), so cancelling the attempt locally is enough; false for Stripe, whose checkout is closed at Stripe first. |

A declaration alone never makes a provider routable: only an **injected,
active adapter** is (`PAYMENT_PROVIDERS`). Adapters: SANDBOX (local and CI),
STRIPE since PAY-EU-1 (only with `PAYMENT_STRIPE_MODE` TEST or LIVE) and
PAYPAL since PAY-PAYPAL-1 (only with `PAYMENT_PAYPAL_MODE` SANDBOX or LIVE;
France and Spain, EUR), and WAVE since PAY-SN-1A (`WAVE_SN`, SN, XOF;
`PAYMENT_WAVE_MODE=LIVE` remains release-gated). All real adapters are
DISABLED by default. Orange Money is only a declared direct target and has no
adapter until the official Senegal merchant contract is available.

### Règle Sénégal absolue

- `WAVE_SN` possède exactement un provider : `WAVE` direct.
- `ORANGE_MONEY_SN` cible exactement `ORANGE_MONEY` direct, actuellement non
  implémenté.
- `PAYDUNYA` et `PAYTECH` conservent leurs codes historiques mais déclarent
  `methods=[]`, `countries=[]`, `currencies=[]`, `implemented=false`.
- Wave indisponible donne `PAYMENT_METHOD_UNAVAILABLE`; jamais Orange, carte
  ou agrégateur. Orange indisponible donne la même erreur; jamais Wave.

### Providers with a capture step (PayPal)

For PayPal the payer's approval takes no money. The approval is a
non-terminal event: EURO TERANGA captures only while the attempt is PENDING
and its hold has at least 60 seconds left, after a short locked check that
records `PAYMENT_CAPTURE_REQUESTED`, and outside any transaction. Only the
capture's own terminal event (`PAYMENT.CAPTURE.COMPLETED`) can succeed the
attempt. A capture key derived from the payment reference makes a
redelivered approval the same capture. See [paypal.md](paypal.md).

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
   - candidate down → the next active provider **of the same method**, s'il
     en existe un dans une autre intégration;
   - nobody collects that method → `PAYMENT_METHOD_UNAVAILABLE`, and nothing
     is created.

There is **never a fallback to another method**: a Wave payment is never
charged to a card, even when a card provider is active. The customer chooses
another method, and gets a new quote.

PAY-SN-1A va plus loin pour le Sénégal : aucune deuxième route du même moyen
n'est déclarée. Il n'existe donc aucun fallback Wave ou Orange, même vers un
provider du même moyen.

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
- PAY-SN-1A : Wave uniquement pour `WAVE_SN/SN/XOF`, hold minimum 2100 s,
  PayDunya/PayTech non routables, Orange indisponible, aucun fallback,
  gateway fake et zéro réseau (`wave-payment.provider.spec.ts`,
  `wave-payments.int.spec.ts`).

- Unit: priority, candidate first, stable tie-break, same-method fallback, no
  cross-method fallback, countries and currencies (`payment-capability.registry.spec.ts`).
- Les anciens tests synthétiques du hub démontrent le mécanisme générique de
  fallback de même méthode. Les déclarations PAY-SN-1A et leurs tests dédiés
  ferment explicitement cette possibilité pour Wave et Orange Sénégal.
