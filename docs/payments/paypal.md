# PayPal Wallet (PAY-PAYPAL-1)

The second real payment adapter: **PayPal Wallet** through the **Orders API
v2**, for payers in **France and Spain**, in **EUR** only.

| Fact        | FR, ES                                                       | SN                                   |
| ----------- | ------------------------------------------------------------ | ------------------------------------ |
| SUPPORTED   | Yes (catalogue)                                              | Yes (catalogue intention only)       |
| IMPLEMENTED | **Yes**: `PayPalPaymentProvider`                             | **No**: XOF is not a PayPal currency |
| CONFIGURED  | **No**: `PAYMENT_PAYPAL_MODE=DISABLED`, refused on the pilot | No                                   |
| LIVE        | **No**: `LIVE` refused by a release gate in this version     | No                                   |

Morocco and Mauritania have no PayPal method in the catalogue. No PayPal
account, credential or network call is involved in this PR: CI uses a fake of
the PayPal API calls and the official sample events.

## Documentation checked

Verified on **2026-10-20**. A capability is never inferred from a country or
currency code existing in another PayPal API.

| Topic                                              | Source                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Orders v2 (create, get, capture; fields, statuses) | <https://developer.paypal.com/docs/api/orders/v2/>, schema <https://developer.paypal.com/api/orders/v2/schema.yaml> (version 2.36) |
| Payments v2 (captures, refunds, capture events)    | <https://developer.paypal.com/docs/api/payments/v2/>, schema <https://developer.paypal.com/api/payments/v2/schema.yaml>            |
| Webhooks, verify-webhook-signature                 | <https://developer.paypal.com/api/rest/webhooks/rest/>, schema <https://developer.paypal.com/api/webhooks/v1/schema.yaml>          |
| Event names                                        | <https://developer.paypal.com/api/rest/webhooks/event-names/>                                                                      |
| Checkout webhooks to subscribe                     | <https://developer.paypal.com/docs/checkout/apm/reference/subscribe-to-webhooks/>                                                  |
| Uncaptured payments (approval reversal)            | <https://developer.paypal.com/docs/checkout/apm/reference/handle-uncaptured-payments/>                                             |
| PayPal-Request-Id                                  | <https://developer.paypal.com/api/rest/reference/idempotency/>                                                                     |
| Currencies                                         | <https://developer.paypal.com/api/rest/reference/currency-codes/>                                                                  |
| Countries                                          | <https://developer.paypal.com/api/rest/reference/country-codes/>                                                                   |
| Server SDK                                         | <https://github.com/paypal/PayPal-TypeScript-Server-SDK>, <https://www.npmjs.com/package/@paypal/paypal-server-sdk>                |

### What the documentation says, and what EURO TERANGA decides

| Topic                                 | Documented                                                                                                                                                                                                                                                                                                                               | Decision                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create Order                          | `POST /v2/checkout/orders`, `intent: CAPTURE`; with `payment_source.paypal.experience_context` the order is `PAYER_ACTION_REQUIRED` and returns a `rel: payer-action` link (`https://www.paypal.com/checkoutnow?token=<order id>`). Order ids: `^[A-Z0-9]+$`, 36 max.                                                                    | One purchase unit, `amount` EUR, `custom_id` = our payment reference (reconciliation, not shown to the payer), description `Réservation <booking>`. `shipping_preference: NO_SHIPPING` (a ticket ships nothing), `user_action: PAY_NOW`, `payment_method_preference: IMMEDIATE_PAYMENT_REQUIRED`, `return_url`/`cancel_url` to the client area. No payer, e-mail, phone, address or shipping is sent. |
| Approval link                         | `payer-action` (with `payment_source`), `approve` (without).                                                                                                                                                                                                                                                                             | Only one `payer-action` link, https, host `www.sandbox.paypal.com` (SANDBOX) or `www.paypal.com` (LIVE), path `/checkoutnow`, only `token=<this order id>`, no port, credentials or fragment. Anything else: refused (`PAYMENT_PROVIDER_UNAVAILABLE`). The browser also follows only these two hosts on `/checkoutnow`.                                                                               |
| Amount                                | `value` string, two decimals for EUR; up to 15 integer digits.                                                                                                                                                                                                                                                                           | Written from minor units in integer arithmetic (`24900` → `"249.00"`); read back only from exactly two decimals.                                                                                                                                                                                                                                                                                      |
| Capture Order                         | `POST /v2/checkout/orders/{id}/capture`; capture statuses `COMPLETED`, `DECLINED`, `PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED`; `PENDING` reasons include `PENDING_REVIEW`, `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`.                                                                                                     | Called only after an authenticated approval, outside any transaction. Its response never confirms anything.                                                                                                                                                                                                                                                                                           |
| PayPal-Request-Id                     | Retries with the same id return the latest status instead of repeating the action; without it a request is duplicated; one id per request and call type; 38 single-byte characters (idempotency page); stored 6 hours, up to 72 on request (SDK reference).                                                                              | Create: the payment reference (16 characters). Capture: `<payment reference>-CAPTURE` (24 characters), never random. An order with intent CAPTURE is captured once: a capture with another key on a captured order is refused by PayPal (`ORDER_ALREADY_CAPTURED`), which the adapter treats as already captured.                                                                                     |
| Void an order                         | The Orders v2 index lists no void or cancel operation for a CAPTURE order.                                                                                                                                                                                                                                                               | **`LOCAL_CANCEL_PREVENTS_CAPTURE`**: cancelling the attempt locally is enough (nothing is collected without our capture); EURO TERANGA never claims it closed the order at PayPal. The order expires on its own.                                                                                                                                                                                      |
| Webhook verification                  | `POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the `PAYPAL-*` headers), `webhook_id` and `webhook_event` "posted back exactly as it was received"; answer `verification_status` `SUCCESS` or `FAILURE`. Not available for mock events. | Headers bounded as that request bounds them; the raw body inserted unchanged as `webhook_event`; the webhook ID from our configuration only; any other answer than `SUCCESS` refused (401); no answer (timeout, error) is 503, so PayPal redelivers. PAYPAL-CERT-URL is never fetched here, and no signature is computed by hand.                                                                     |
| Retries                               | Non-2xx deliveries are retried up to 25 times over 3 days; any 2xx stops them.                                                                                                                                                                                                                                                           | Recorded or not-ours events answer 200; an unknown order on a capture event 404; verification unavailable 503.                                                                                                                                                                                                                                                                                        |
| `CHECKOUT.ORDER.APPROVED`             | "A buyer approved a checkout order"; listen for it "and then capture the payment".                                                                                                                                                                                                                                                       | Non-terminal. Capture only if the attempt is PENDING, the stated amount and currency (if present) are the quote's, the booking is still an active hold with at least 60 seconds left, and the trip is still payable. Otherwise nothing is captured (`CAPTURE_REFUSED`).                                                                                                                               |
| `PAYMENT.CAPTURE.COMPLETED`           | Resource `capture` (Payments v2 `capture-2`), order id in `resource.supplementary_data.related_ids.order_id`.                                                                                                                                                                                                                            | **The only success.** Correlated by that order id (never guessed: absent → 400). Amount and currency checked against the quote (PAY-HUB-1 `expectedProviderAmount`).                                                                                                                                                                                                                                  |
| `PAYMENT.CAPTURE.PENDING`             | "The state of a payment capture changes to pending".                                                                                                                                                                                                                                                                                     | Acknowledged, nothing changes: the attempt stays PENDING and the booking HELD.                                                                                                                                                                                                                                                                                                                        |
| `PAYMENT.CAPTURE.DENIED` / `DECLINED` | `DENIED` is listed for Payments v1, `DECLINED` for Payments v2 (official sample).                                                                                                                                                                                                                                                        | Both are a failure (`DECLINED`).                                                                                                                                                                                                                                                                                                                                                                      |
| `CHECKOUT.PAYMENT-APPROVAL.REVERSED`  | Sent when an approved order is not captured in time (default 3 hours); PayPal cancels the order; order id in `resource.order_id`. The page's sample is for an alternative payment method.                                                                                                                                                | A failure before any capture (`CHECKOUT_EXPIRED`), with no amount (none moved).                                                                                                                                                                                                                                                                                                                       |
| Currencies                            | 25 currencies, EUR included; **XOF, MAD and MRU are not listed**. Receiving a currency the account does not hold may leave a payment pending until accepted.                                                                                                                                                                             | EUR only. PayPal is not implemented for Senegal, and the router never selects it there.                                                                                                                                                                                                                                                                                                               |
| Countries                             | FR, ES, SN, MA and MR are all in the country-code list, which says nothing about service availability.                                                                                                                                                                                                                                   | Not taken as proof of anything.                                                                                                                                                                                                                                                                                                                                                                       |
| Refunds                               | `POST /v2/payments/captures/{capture_id}/refund`, empty body for a full refund, `amount` for a partial one.                                                                                                                                                                                                                              | **`PAYPAL_COLLECTION_IMPLEMENTED`, `PAYPAL_REFUND_EXECUTION_NOT_YET_IMPLEMENTED`.**                                                                                                                                                                                                                                                                                                                   |

### Refused hypotheses

- **PayPal for Senegal in XOF**: XOF is not a PayPal currency. The PAY-HUB-1
  declaration (`FR, ES, SN`, `EUR, XOF`) is corrected to `FR, ES`, `EUR`.
- **An approval is a payment**: it is not. Neither `CHECKOUT.ORDER.APPROVED`,
  nor the capture's HTTP response, nor the return to `return_url` confirms a
  booking.
- **Fetching PAYPAL-CERT-URL and verifying the RSA signature ourselves**:
  refused; PayPal's own verification API decides.
- **Cancelling the order at PayPal**: no such operation for a CAPTURE order;
  local cancellation prevents the capture instead.
- **The JavaScript SDK, popups or card fields**: not needed; the hosted
  approval page and a server-side flow are enough.

## SDK

The official **`@paypal/paypal-server-sdk` 2.5.0**, pinned exactly (published
2026-08-21; the version the SDK's README installs). It covers Orders and
Payments; it has no webhook controller, so the verify-webhook-signature call
goes through the SDK's own request builder (`Client.getRequestBuilderFactory`):
the same OAuth 2.0 client credentials, transport and base URL
(`api-m.sandbox.paypal.com` or `api-m.paypal.com`, from our mode only). The
SDK's default timeout (none) is replaced by 10 seconds; its logger stays off.
Its dependencies (`@apimatic/*`, `axios`) come with it; the dependency audit
is clean for them.

## Flow

1. The PENDING attempt is committed (PAY-HUB-1).
2. Outside any transaction: Create Order (`PayPal-Request-Id` = payment
   reference), exact EUR amount; the order id is stored as
   `providerPaymentId`.
3. The browser goes to the validated approval page; the payer approves.
4. `CHECKOUT.ORDER.APPROVED`, verified by PayPal: in one short transaction on
   the locked rows, the attempt and its hold are checked and a
   `PAYMENT_CAPTURE_REQUESTED` audit event is written; after commit, Capture
   Order with `<reference>-CAPTURE`. The attempt stays PENDING.
5. `PAYMENT.CAPTURE.COMPLETED` (amount and currency exact) succeeds the
   attempt and confirms the booking, once. `PENDING` waits; `DENIED`,
   `DECLINED` and the approval reversal fail it.

### Hold and late events

- An attempt starts while at least **2 minutes** of hold remain; the default
  15-minute hold suits PayPal (unlike Stripe Checkout), because approving
  takes no money.
- A capture is requested only while **60 seconds** of hold remain. A late
  approval is never captured.
- A capture still `PENDING` never confirms. If it completes after the hold,
  the attempt fails (`BOOKING_EXPIRED`) and the seats are not taken back; the
  money must be refunded (the recorded success is the evidence).
- A capture whose outcome is unknown (timeout, 5xx) answers 503: PayPal
  redelivers the approval and the same capture is asked again. A capture
  PayPal refuses (422, e.g. `INSTRUMENT_DECLINED`) captures nothing and
  changes nothing locally; the order is later reversed.

### Cancellation

- Customer or staff cancellation of a PENDING PayPal attempt needs no PayPal
  call (`LOCAL_CANCEL_PREVENTS_CAPTURE`); a later approval is refused
  (`PAYMENT_NOT_PENDING`).
- Once a capture has been requested, the attempt can no longer be cancelled
  (`409 PAYMENT_PROVIDER_COMPLETING`): both paths lock the payment row, so the
  two cannot cross.
- Trip and booking cancellations cancel PENDING attempts in their own
  transactions; a capture already requested may still complete, and is then
  recorded, refused (`PAYMENT_NOT_PENDING`) and must be refunded.

## Configuration

| Variable                       | Values                                  | Notes                                                        |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| `PAYMENT_PAYPAL_MODE`          | `DISABLED` (default), `SANDBOX`, `LIVE` | Independent of `PAYMENT_PROVIDER` and `PAYMENT_STRIPE_MODE`. |
| `PAYMENT_PAYPAL_CLIENT_ID`     | REST app client ID                      | Server-side only; never sent to a browser.                   |
| `PAYMENT_PAYPAL_CLIENT_SECRET` | REST app secret                         | Secret: never logged, never returned.                        |
| `PAYMENT_PAYPAL_WEBHOOK_ID`    | `^[A-Za-z0-9]{1,50}$`                   | Not a secret, but never taken from a request.                |

- `DISABLED`: all three must be unset; no adapter, no client, no route.
- `SANDBOX`: all three required; **local and CI only**.
- `LIVE`: refused by the release gate (`PAYPAL_LIVE_MODE_ENABLED = false`) and
  by the module.
- **Pilot**: `pilot-env-guard.sh` refuses `PAYMENT_PAYPAL_MODE` other than
  unset or `DISABLED`, and any of the three variables (even the non-secret
  ones), on top of its Stripe rules. No server environment is changed.

## Webhook

`POST /v1/payments/webhooks/paypal`, present only in SANDBOX or LIVE. Events
to subscribe: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`,
`PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.COMPLETED`,
`PAYMENT.CAPTURE.DENIED` (and `PAYMENT.CAPTURE.DECLINED`).

| Answer                                                          | When                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 200 `CAPTURE_REQUESTED` / `ALREADY_CAPTURED` / `NOT_CAPTURABLE` | An approval that was captured, or that PayPal refused to capture    |
| 200 `CAPTURE_REFUSED` + reason                                  | An approval not captured (not ours, not pending, hold over, amount) |
| 200 `PAYMENT_SUCCEEDED` / `PAYMENT_FAILED` / `REJECTED` + code  | A terminal event, recorded                                          |
| 200 `DUPLICATE`                                                 | The same event redelivered with the same payload                    |
| 200 `IGNORED`                                                   | Capture pending, refunds, reversals and other types                 |
| 401 / 413 / 415 / 400                                           | Not verified, oversized, wrong content type, malformed              |
| 404                                                             | A terminal event for an unknown order                               |
| 409                                                             | The same event id with another payload                              |
| 503                                                             | Verification or capture outcome unknown: PayPal redelivers          |

Only the SHA-256 of a terminal event's payload is stored (`payment_event`);
approvals leave an audit event (`PAYMENT_CAPTURE_REQUESTED`) with the event
id, never the payload. No PayPal account data (payer id, e-mail, shipping) is
read or stored.

## Refunds and reconciliation

**`PAYPAL_COLLECTION_IMPLEMENTED`, `PAYPAL_REFUND_EXECUTION_NOT_YET_IMPLEMENTED`.**
OPS records refunds and says so on screen; a PayPal refund is executed in the
PayPal account, then recorded. `capabilities()` reports
`refundExecutionImplemented: false`. A refund-execution PR (shared by the PSP
adapters) is needed before LIVE.

Never confused: the PayPal **order** (`providerPaymentId`), its **capture**
(the money), any **refund**, PayPal's **fee** (`seller_receivable_breakdown`)
and the **payout** to the bank. Only the order id is stored; no fee, net
amount, settlement or payout is invented (`payment_settlement` stays empty).
Money collected without a confirmed booking shows as a `PAYMENT_SUCCEEDED`
event on an attempt that is not SUCCEEDED (see
[reconciliation.md](reconciliation.md)).

## Before CONFIGURED (not in this PR)

1. Owner approval; a PayPal business account (FR or ES) holding EUR.
2. A REST app; its webhook for the events above; its credentials in the
   target environment file only.
3. A reviewed change allowing SANDBOX on staging, and the pilot guard updated.
4. Refund execution and settlement import (before LIVE).

## Tests

- Unit (`paypal-payment.provider.spec.ts`): capability and routing (FR and ES
  only; never SN, MA, MR, XOF, MAD, MRU; hold), exact amounts, the order
  request (no personal data), every hostile approval link, error logging,
  capture idempotency and outcomes, webhook verification (posted back
  unchanged, webhook ID, every header missing or oversized, content type,
  size, FAILURE, unavailable, no certificate fetch, no payload logged), the
  official sample events, wiring.
- Config (`payment-env.test.ts`) and pilot guard (`pilot-env-guard.test.ts`).
- Integration (`paypal-payments.int.spec.ts`, real PostgreSQL, fake PayPal):
  options, PENDING committed and no transaction during Create and Capture,
  forged ids and amounts refused, approval captured but never confirming,
  redelivered approvals (one capture), late approval and approval after
  cancellation not captured, no cancellation once capture requested, amount,
  currency and foreign order refused, unknown capture outcome, capture
  pending, completed once, duplicate, same id with another payload, denied,
  declined, reversed, wrong amount and currency, completion after the hold,
  returns, verification, no credential or raw event stored or logged, and no
  route while DISABLED.
