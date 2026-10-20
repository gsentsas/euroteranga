# Stripe Europe (PAY-EU-1)

The first real payment adapter: Stripe, for payers in **France and Spain**, in
**EUR** only, through Stripe's hosted **Checkout** page.

| Fact        | State                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| SUPPORTED   | Yes: `CARD`, `BIZUM` (ES), `KLARNA` (FR, ES), and documented reasons for every other European method |
| IMPLEMENTED | **Yes**: `StripePaymentProvider` (`apps/api/src/payments/providers/stripe-payment.provider.ts`)      |
| CONFIGURED  | **No**: `PAYMENT_STRIPE_MODE=DISABLED` everywhere; the pilot deploy refuses anything else            |
| LIVE        | **No**: `LIVE` is refused by a release gate in this version                                          |

It never applies to Morocco, Mauritania or Senegal, and never to another
currency. No Stripe account, key or network call is involved in this PR: CI
uses a fake of the Stripe API calls and signs events with the SDK's own test
helper.

## Documentation checked

Verified on **2026-10-20**, on the current Stripe documentation. Availability
is never inferred from a method's name.

| Topic                         | Page                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Methods, locations, Checkout  | <https://docs.stripe.com/payments/payment-methods/payment-method-support>                                               |
| Checkout Session create       | <https://docs.stripe.com/api/checkout/sessions/create>                                                                  |
| Fulfillment (events)          | <https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted>                                                 |
| Webhook signatures            | <https://docs.stripe.com/events/set-up-events>, <https://docs.stripe.com/events/manage-webhook-endpoints>               |
| Cards, brands                 | <https://docs.stripe.com/payments/cards/supported-card-brands>, <https://docs.stripe.com/payments/cartes-bancaires>     |
| Apple Pay, Google Pay         | <https://docs.stripe.com/apple-pay?platform=web>, <https://docs.stripe.com/google-pay?platform=web>                     |
| Bizum                         | <https://docs.stripe.com/payments/bizum>, <https://docs.stripe.com/payments/bizum/accept-a-payment?payment-ui=checkout> |
| Klarna                        | <https://docs.stripe.com/payments/klarna>, <https://docs.stripe.com/payments/klarna/compliance>                         |
| Alma                          | <https://docs.stripe.com/payments/alma>                                                                                 |
| Wero                          | <https://docs.stripe.com/payments/wero>, <https://docs.stripe.com/payments/wero/accept-a-payment?payment-ui=checkout>   |
| SEPA Direct Debit             | <https://docs.stripe.com/payments/sepa-debit>                                                                           |
| Refunds                       | <https://docs.stripe.com/refunds>                                                                                       |
| SDK versions and API versions | <https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md>, <https://www.npmjs.com/package/stripe>                |

## Decisions per method

`INSTANT`, `ASYNC_SHORT` and `ASYNC_LONG` are the confirmation classes of the
catalogue (`payment-catalog.ts`, see [provider-routing.md](provider-routing.md)).

| Method                 | Countries | Class      | Implemented | Why                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CARD`                 | FR, ES    | INSTANT    | **Yes**     | Checkout type `card`. Visa, Mastercard and American Express are accepted without extra configuration (Amex: every account country except BR, MY, TH, AE). Cartes Bancaires: SEPA-area accounts, customers in France; co-badged cards let the payer choose the network on Stripe's page (EU rule). Badges: FR `CB, Visa, Mastercard, American Express`; ES `Visa, Mastercard, American Express`.              |
| `APPLE_PAY`            | FR, ES    | INSTANT    | No (badge)  | Not a Checkout payment method type: hosted Checkout may add it to the card page, only when the device and browser meet Apple's requirements. Never a separate choice; the CARD option says it _may_ appear. A wallet payment arrives as a `card` payment.                                                                                                                                                    |
| `GOOGLE_PAY`           | FR, ES    | INSTANT    | No (badge)  | Same model as Apple Pay ("If you don't meet device and integration requirements, Stripe doesn't render Google Pay").                                                                                                                                                                                                                                                                                         |
| `BIZUM`                | ES only   | INSTANT    | **Yes**     | Customers in Spain (a Spanish IBAN linked to a phone number in the bank app), EUR, 0.50-5,000 EUR, Checkout in payment mode, no manual capture, full and partial refunds (395 days, asynchronous), disputes within 120 days. The payer types the phone number on the Bizum flow: EURO TERANGA never sees or stores it. The Checkout guide shows an **early-access request**: the account needs Bizum access. |
| `KLARNA`               | FR, ES    | INSTANT    | **Yes**     | Customer and business locations include France and Spain, EUR, Checkout. Largest offers: France pay in full 4,000 EUR (pay later 500, pay in 3 1-3,000); Spain pay in full 10,000 EUR. Klarna's prohibited categories (charities, politics, B2B, money services, gift cards, collections, fines, gambling, direct marketing, fundraising) do not include passenger transport.                                |
| `ALMA`                 | FR, ES    | INSTANT    | **No**      | Alma prohibits "Transportation services" and "Travel services" (and B2B, sole proprietorships): EURO TERANGA is not eligible. `BUSINESS_CATEGORY_PROHIBITED`.                                                                                                                                                                                                                                                |
| `WERO`                 | FR only   | INSTANT    | **No**      | Customers in Belgium, France, Germany and Luxembourg (not Spain); business locations include FR and ES. But the pinned SDK's `allowed_payment_method_types` has no `wero` value: a session cannot be restricted to Wero exactly, so it is not offered (`NOT_SUPPORTED_BY_PINNED_SDK`). Re-check with the next SDK and the account's preview access.                                                          |
| `SEPA_DIRECT_DEBIT`    | FR, ES    | ASYNC_LONG | **No**      | Delayed notification: success at T+6 business days, disputes "no questions asked" for 8 weeks. A seat hold cannot wait: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY`.                                                                                                                                                                                                                                          |
| `SEPA_CREDIT_TRANSFER` | FR, ES    | ASYNC_LONG | **No**      | Bank transfers (`customer_balance`) are paid when the customer sends the money, days later: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY`. Never approximated by another method.                                                                                                                                                                                                                                |
| `PAYPAL`               | FR, ES    | INSTANT    | No          | Its own provider PR (PAY-PAYPAL-1).                                                                                                                                                                                                                                                                                                                                                                          |

The catalogue keeps `CARD_CB`, `CARD_VISA`, `CARD_MASTERCARD` and
`CARD_AMEX` as vocabulary (earlier attempts, reporting) but never offers them:
Stripe does not let a payer pick the network before the card is known, so a
separate "Visa" choice would be a promise Stripe cannot keep.

## Integration

- **SDK**: the official `stripe` package, **23.0.0** exactly (published
  2026-09-30, at least two weeks before this PR; no dependency of its own),
  pinned API version **`2026-09-30.endive`**. No CDN, no wrapper, no
  hand-written HTTP. The client sends no telemetry and retries with the same
  idempotency key.
- **Hosted Checkout** (`mode: payment`). EURO TERANGA never renders a payment
  form, so no publishable key is needed and no card, phone or IBAN reaches our
  servers.
- **Exact method**: `allowed_payment_method_types` holds the one Stripe type of
  the customer's method (`card`, `bizum` or `klarna`). Any other method is
  refused before calling Stripe (`PAYMENT_METHOD_UNAVAILABLE`), never replaced.
- **Exact amount**: one line item of the quote's presentment amount, in `eur`.
  The amount is never the client's: it comes from the immutable quote. The
  returned session must echo the same amount, currency and mode, and its page
  must be on `https://checkout.stripe.com/`, otherwise the attempt is refused
  (`PAYMENT_PROVIDER_UNAVAILABLE`).
- **Idempotency key**: the payment reference (`ETP-...`). A replay of the same
  attempt sends exactly the same request, so Stripe returns the same session.
- **Metadata**: only `euroteranga_payment_reference` (on the session and on its
  PaymentIntent), and `client_reference_id` with the same value. No name,
  e-mail, phone or booking detail beyond the product label
  `Réservation <booking reference>`.
- **Order of operations** (PAY-HUB-1, unchanged): the PENDING attempt is
  committed first; Stripe is called outside any transaction; the session id is
  attached in a second short transaction.

### Checkout lifetime and the seat hold

A Checkout Session can be paid until its `expires_at`, which Stripe accepts
between **30 minutes and 24 hours** after creation. EURO TERANGA sets it to
**31 minutes** after the attempt (one minute of clock margin), derived from the
stored attempt so a replay sends the same value.

The hold must outlast that window: Stripe is routable only while **36
minutes** of hold remain (31 + a 5-minute margin), so Checkout always closes
before the seats can be freed. With the default 15-minute hold
(`BOOKING_HOLD_TTL_SECONDS=900`) Stripe is therefore **unavailable** (fail
closed). Before Stripe can be configured, the owner must raise the hold:
`BOOKING_HOLD_TTL_SECONDS=3600` leaves a customer 24 minutes to start paying.

A result can still arrive after the hold (a webhook delayed by an outage). It
never confirms the booking: the attempt becomes `FAILED` with
`BOOKING_EXPIRED`, its success event is recorded, and the money must be
refunded (see Refunds and Reconciliation).

### Returns

`success_url` and `cancel_url` point to the client area
(`CLIENT_PUBLIC_URL/compte?paiement=retour` or `?paiement=abandon`). They are
browser destinations only: no API route handles them, and coming back
confirms, fails or cancels nothing. The browser follows a redirect only to
`https://checkout.stripe.com` (`paymentRedirectTarget`).

### Cancellation

Before a customer (or `payment.manage` staff) cancels a PENDING Stripe
attempt, its session is expired at Stripe, outside any transaction:

- expired (now or earlier): the attempt is cancelled;
- already completed by the payer: the attempt is **not** cancelled
  (`409 PAYMENT_PROVIDER_COMPLETING`); Stripe's event decides it;
- Stripe unreachable: nothing changes (`503 PAYMENT_PROVIDER_UNAVAILABLE`).

## Webhook

`POST /v1/payments/webhooks/stripe`, present only when Stripe is TEST or LIVE.

- **Authentication**: `Stripe-Signature` verified by the official SDK
  (`Stripe.webhooks.constructEvent`) on the raw body, with the endpoint's
  signing secret: HMAC-SHA256, constant-time comparison, 300-second
  tolerance. A timestamp more than 300 seconds in the future is refused too.
  Content type `application/json` only (415 otherwise), 32 KiB at most (413),
  signature header bounded (1 KiB). The SDK's errors carry the payload: they
  are never logged.
- **Events to subscribe** (snapshot events, API version above):
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`.

| Stripe event                                  | Result                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `checkout.session.completed`, `paid`          | `PAYMENT_SUCCEEDED`: confirms the booking if its hold is still active     |
| `checkout.session.completed`, `unpaid`        | Nothing yet (a delayed payment): its own success or failure event follows |
| `checkout.session.async_payment_succeeded`    | `PAYMENT_SUCCEEDED`                                                       |
| `checkout.session.async_payment_failed`       | `PAYMENT_FAILED`, `UNKNOWN` (Stripe gives no reason on the session)       |
| `checkout.session.expired`                    | `PAYMENT_FAILED`, `CHECKOUT_EXPIRED`                                      |
| Any other type, or a session without our ref. | Acknowledged (`IGNORED`), nothing recorded                                |

- **Checks** (PAY-HUB-1 pipeline): the amount and currency must equal the
  quote's presentment (`expectedProviderAmount`); a mismatch is recorded
  (`AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`) and changes nothing. The event's
  `livemode` must match the configured mode. Only the SHA-256 of the payload
  is stored.
- **Responses**: every authenticated event that was recorded answers 200, a
  refusal included (`{ outcome: "REJECTED", code }`): the record is the
  evidence, and Stripe would only redeliver the same payload. A redelivery of
  an event already recorded with the **same** payload answers 200
  `DUPLICATE`; the same event id with **another** payload is refused (409).
  An unknown session answers 404, so Stripe retries until the attempt carries
  its session id.

## Configuration

| Variable                        | Values                                   | Notes                                                    |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `PAYMENT_STRIPE_MODE`           | `DISABLED` (default), `TEST`, `LIVE`     | Independent of `PAYMENT_PROVIDER` (SANDBOX or DISABLED). |
| `PAYMENT_STRIPE_SECRET_KEY`     | `sk_test_`/`rk_test_` (`_live_` in LIVE) | Restricted keys are accepted. Server-side only.          |
| `PAYMENT_STRIPE_WEBHOOK_SECRET` | `whsec_...`                              | Signing secret of the webhook endpoint.                  |

- `DISABLED`: both secrets must be unset; no adapter, no client, no route.
- `TEST`: both test secrets required; **local and CI only** (a staging test
  account is a later decision).
- `LIVE`: live secrets required, and refused anyway by the release gate
  (`STRIPE_LIVE_MODE_ENABLED = false`) and by the module.
- Configuration errors name the variable, never its value.
- **Pilot**: `infrastructure/plesk/pilot-env-guard.sh` (sourced by
  `deploy-release.sh`) refuses `PAYMENT_STRIPE_MODE` other than unset or
  `DISABLED`, and any Stripe secret. The server's environment is not changed
  by this PR.

## Refunds

**`STRIPE_COLLECTION_IMPLEMENTED`, `STRIPE_REFUND_EXECUTION_NOT_YET_IMPLEMENTED`.**

Stripe supports full and partial refunds for every implemented method
(Refunds API on the PaymentIntent; asynchronous, `refund.updated` /
`refund.failed`; Stripe's processing fees are not returned; cards show the
credit in about 5-10 business days; Bizum within 395 days, Klarna within 180).
EURO TERANGA does **not** send refunds to Stripe yet:

- the OPS refund form records a refund fact and its credit note only, and now
  says so on screen ("aucun ordre de remboursement n'est envoyé au
  prestataire de paiement");
- the refund must first be executed in the Stripe Dashboard, then recorded;
- `capabilities()` reports `refundExecutionImplemented: false` for every
  provider.

A refund execution PR (Refunds API, idempotency, `refund.*` events,
reconciliation) is required before LIVE.

## Reconciliation

Four different facts, never merged:

| Fact                   | Where                                      | Meaning                                         |
| ---------------------- | ------------------------------------------ | ----------------------------------------------- |
| `Payment` SUCCEEDED    | EURO TERANGA, from a signed Checkout event | The payer paid; the booking is confirmed        |
| Charge / PaymentIntent | Stripe                                     | The card or account was charged                 |
| Balance transaction    | Stripe                                     | Gross, Stripe fee and net, once known to Stripe |
| Payout                 | Stripe to the bank                         | Batches of balance, days later                  |

No fee, net amount or payout is invented: `payment_settlement` stays empty
until a settlement import PR reads Stripe's balance transactions.

Collected but not confirmed (a refund is due), visible today in the attempt's
events: a `PAYMENT_SUCCEEDED` event on an attempt that is `FAILED`
(`BOOKING_EXPIRED`, `BOOKING_NOT_PAYABLE`) or `CANCELLED`
(`PAYMENT_NOT_PENDING` rejection).

```sql
SELECT p.reference, p.status, p.failure_code, e.provider_event_id, e.received_at
FROM payment p
JOIN payment_event e ON e.payment_id = p.id AND e.type = 'PAYMENT_SUCCEEDED'
WHERE p.provider = 'STRIPE' AND p.status <> 'SUCCEEDED';
```

## Security and privacy

- No card number, security code, PIN, OTP, phone number or IBAN is collected,
  stored or logged; payers type them on Stripe's (or Bizum's, Klarna's) pages.
- No raw Stripe object is stored or logged: the adapter reads a few fields,
  logs only error types, codes and request ids, and stores the payload hash.
- Secrets never leave the server: not in responses, logs, the UI or
  `NEXT_PUBLIC_` variables.

## Before CONFIGURED (not in this PR)

1. Owner approval; a Stripe account whose business location is FR or ES.
2. In the Dashboard: card, Klarna, and Bizum (early access, `bizum_payments`
   capability active) enabled; Alma, SEPA debit and bank transfers left off.
3. A webhook endpoint for the four events above; its secret in the target
   environment file only.
4. `BOOKING_HOLD_TTL_SECONDS` raised (3600 recommended).
5. A reviewed change allowing `TEST` on staging, and the pilot guard updated.
6. Refund execution and settlement import (before LIVE).
7. Closing Checkout when a trip or booking cancellation cancels a PENDING
   attempt (see Known limitations).

## Known limitations

- **Trip and booking cancellations** cancel PENDING attempts inside their own
  transactions, without expiring the Stripe session (a network call cannot
  run there). The session still closes by itself within 31 minutes; a payment
  made there is recorded and refused (`PAYMENT_NOT_PENDING`) and must be
  refunded. Only the customer and staff cancellation of an attempt expires the
  session first.
- **Replay after a lost first request**: `expires_at` is derived from the
  attempt's creation; a replay more than a minute later of a request that never
  reached Stripe is refused by Stripe (`expires_at` under 30 minutes away). The
  attempt stays PENDING without a session; the customer cancels it and starts
  again.
- Wero, Alma and SEPA stay unavailable as explained above.

## Tests

- Unit (`stripe-payment.provider.spec.ts`): capability (countries, currency,
  methods, Bizum in Spain only, amounts, hold window, networks), exact session
  request (amount, EUR, single type, idempotency key, metadata, deadline,
  return URLs), refusals without calling Stripe, misbehaving sessions, error
  logging without secrets, cancellation outcomes, webhook signature (valid,
  forged, other secret, old and future timestamps, tampered body, content type,
  size), normalization (paid, unpaid, delayed success and failure, expired,
  ignored, foreign, live in test mode), wiring (DISABLED wires nothing, TEST
  next to SANDBOX, LIVE never starts).
- Config (`payment-env.test.ts`), pilot guard (`pilot-env-guard.test.ts`).
- Integration (`stripe-payments.int.spec.ts`, real PostgreSQL, fake Stripe
  API): options per country, PENDING committed before the call and no open
  transaction during it, replay, Bizum and Klarna sessions, returns that
  confirm nothing, signed webhooks end to end (success once, duplicate, same id
  with another payload, wrong amount, wrong currency, unknown session, already
  terminal, delayed success and failure, expiry, late success after the hold),
  cancellation, and no secret or raw payload in storage, responses or logs.
- Mutation checks: see the PR description.
