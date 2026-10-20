# Payment domain

> Implemented in PR-10 and extended by PR-22 operational refunds: payment
> attempts, provider events, booking confirmation and bounded refund facts. **NOT PRODUCTION DEPLOYED.** **No real payment service
> provider (PSP) is configured**: the only active provider, **SANDBOX**, is a local simulation for
> development, tests and CI (the Stripe and PayPal adapters exist but are disabled). No real money is ever moved, and no card, security
> code or IBAN is ever collected. Browser and integration tests use synthetic
> data only.

> **PAY-HUB-1** adds the multi-provider foundation: a catalogue of
> customer-facing methods distinct from providers, a capability registry, and
> immutable multi-currency quotes. Every new attempt starts from a quote;
> `Payment.amountMinor` keeps its PR-10 meaning (the booking amount). No real
> provider is activated. See [docs/payments](../payments/) (payment matrix,
> provider routing, multi-currency, reconciliation, provider onboarding).

> **PAY-EU-1** adds the first real adapter, **Stripe** (hosted Checkout,
> France and Spain, EUR; `CARD`, `BIZUM` in Spain, `KLARNA`). It is
> **disabled by default** (`PAYMENT_STRIPE_MODE=DISABLED`), refused on the
> pilot, and never LIVE in this release. Refunds are still recorded facts,
> not sent to Stripe. See [stripe-europe.md](../payments/stripe-europe.md).

> **PAY-PAYPAL-1** adds **PayPal Wallet** (Orders API v2, France and Spain,
> EUR). The payer's approval is not a payment: EURO TERANGA captures only
> while the attempt and its hold are payable, and only the capture's own
> event confirms the booking. Disabled by default
> (`PAYMENT_PAYPAL_MODE=DISABLED`), refused on the pilot, never LIVE in this
> release; refunds are not sent to PayPal. See
> [paypal.md](../payments/paypal.md).

PR-10 lets the authenticated CUSTOMER who owns a HELD booking start a payment
attempt. The attempt's result arrives later as a signed provider event. A
success confirms the booking atomically, and the booking then keeps its seats
for good.

## Scope

Included:

- `Payment` attempts with an immutable history (a new attempt is a new row),
  exact server-derived amounts, at most one PENDING and one SUCCEEDED attempt
  per booking;
- an internal `PaymentProvider` abstraction and the SANDBOX provider;
- `PaymentEvent`: each provider event, authenticated (HMAC), recorded once and
  idempotent;
- booking confirmation (`Booking.confirmedAt`, status CONFIRMED), confirmed
  inventory permanence, and PR-22 cancellation only after full refund;
- CUSTOMER initiation (idempotent), reading and cancellation of an attempt;
- STAFF reading with `payment.read`, and cancellation of a PENDING attempt with
  `payment.manage`;
- audit, RBAC, the typed client, and the Booking, Client and OPS interfaces.

Deferred:

- **any real PSP** (PayDunya, Wave, Orange Money, card acquiring…; Stripe has
  an adapter since PAY-EU-1, disabled by default) and PCI-scoped data
  collection (Stripe collects card data on its own page);
- **real provider-side refund execution**: PR-22 records the operational
  refund fact and matching credit memo, but SANDBOX moves no money and no
  production PSP refund API is selected;
- **ticketing**, ticket PDF, QR codes;
- **passengers**, check-in, boarding, baggage;
- promotions, coupons, detailed taxes, commissions and general accounting.

## Model

| Object         | Purpose                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Payment`      | One attempt to pay one booking. It stores its public reference, booking, paying CUSTOMER (always the booking owner), provider and opaque provider id, status, exact `amountMinor` (BIGINT), `currencyCode`, `currencyMinorUnit`, optional `idempotencyKey`, normalized `failureCode`, and one timestamp per terminal transition. |
| `PaymentEvent` | One provider event received through the webhook. It stores the provider, its unique `providerEventId`, normalized type, SHA-256 `payloadHash`, `receivedAt`, and either `processedAt` (it moved the payment out of PENDING) or a stable `rejectionCode` (recorded, changed nothing). The payload itself is not stored.           |
| `Booking`      | Gains `confirmedAt`, set once by a succeeded payment.                                                                                                                                                                                                                                                                            |

There is no card, security code, IBAN, bank account or raw provider payload
anywhere in the schema.

The public reference is `ETP-` followed by 12 cryptographically random
Crockford-base32 characters. It is never derived from the booking reference,
the customer or the time. Internal ids remain UUIDv7.

## Payment lifecycle

```
PENDING ──> SUCCEEDED   (a processed provider success event)
        ├─> FAILED      (a processed provider event: failure, or a success
        │                that can no longer apply)
        └─> CANCELLED   (the customer, STAFF with payment.manage, or a
                         booking/trip cancellation cascade)
```

The three terminal states are final: no `FAILED -> SUCCEEDED`, no
`CANCELLED -> SUCCEEDED`, nothing after `SUCCEEDED`. A new attempt is a new
`Payment`. SUCCEEDED and FAILED require a processed provider event in the
database. An isolated `UPDATE` of `Payment` cannot mark it paid: the
transactional pipeline requires a processed `PaymentEvent` and the atomic
booking confirmation. Provider authenticity is verified at the webhook
boundary by the API, not cryptographically by PostgreSQL. An actor with full
SQL access to the payment and event tables remains part of the trusted
computing base.

Normalized failure codes (never raw provider text): `DECLINED`,
`INSUFFICIENT_FUNDS`, `AUTHENTICATION_FAILED`, `CHECKOUT_EXPIRED`,
`PROVIDER_ERROR` and `UNKNOWN` (anything else the provider says). Two codes
are decided by EURO TERANGA when a success can no longer apply:
`BOOKING_EXPIRED` and `BOOKING_NOT_PAYABLE`.

## Booking confirmation

The derived booking status becomes, in priority order:

1. `CANCELLED` when `cancelledAt` is set;
2. otherwise `CONFIRMED` when `confirmedAt` is set;
3. otherwise `EXPIRED` when `holdExpiresAt <= database now()`;
4. otherwise `HELD`.

**CONFIRMED means the payment succeeded and the booking is confirmed.** It does
not mean that a ticket is issued, a passenger is registered or check-in is done.

`confirmedAt` goes from NULL to a timestamp once, in the success transaction,
while the hold is still active (`confirmedAt < holdExpiresAt`), and never
changes afterwards. A confirmed booking:

- **keeps its seats occupied after `holdExpiresAt`**: availability, search and
  the overbooking checks count its locks; the expired-hold cleanup never
  selects it; PostgreSQL refuses to release its seats or delete its locks;
- cannot be cancelled while its succeeded payment is only partially refunded:
  `409 BOOKING_CONFIRMED`;
- may be cancelled after the succeeded payment is fully refunded (PR-22), at
  which point its seats and inventory locks are released;
- prevents trip cancellation only while it is not fully refunded:
  `409 TRIP_HAS_CONFIRMED_BOOKINGS`. Fully refunded confirmed bookings join
  the normal trip-cancellation cascade.

## PR-22 operational refunds

A `Refund` is append-only and targets one SUCCEEDED payment. Cumulative
refunds cannot exceed the payment amount; concurrent refunds serialize on the
payment row. `clientRefundId` makes retries idempotent. One matching
operational `CreditNote` is created in the same transaction.

This is a business record, not a PSP network operation. The current SANDBOX
provider moves no real money. See [finance.md](finance.md) and ADR-033.

## Exact amount

The client never sends an amount, a currency or a unit price. The server
derives the total from the booking only:

```
amountMinor = Booking.unitAmountMinor × number of booking seats
```

The multiplication uses integer `BigInt` arithmetic and is stored in a BIGINT
column, because 20 seats × the largest INTEGER fare exceed 2³¹. PostgreSQL
checks that `amountMinor`, `currencyCode` and `currencyMinorUnit` are exactly
the booking's total. Before any JSON response, an amount must pass
`Number.isSafeInteger` (exact up to 2⁵³ − 1); otherwise the response fails
instead of being rounded. No float is used anywhere.

## Provider abstraction

The business services only use the internal `PaymentProvider` interface:

- `createPayment(request)` registers an attempt at the provider and returns an
  opaque `providerPaymentId` and an optional redirect URL. It is called only
  **after** the PENDING `Payment` and `PAYMENT_CREATED` audit have committed,
  with `Payment.reference` as a mandatory provider-side idempotency key. The
  provider must return the same provider attempt for every call carrying the
  same reference. No network call ever holds a database lock;
- `verifyWebhook(request, now)` authenticates a raw webhook (content type,
  size, timestamp freshness, signature in constant time);
- `parseWebhook(rawBody)` turns an authenticated payload into a normalized
  event (our types and failure codes, never provider text).

A provider never decides a business state directly. The result always arrives
as an authenticated event, through the same pipeline a real PSP will use.

`PAYMENT_PROVIDER` selects the provider:

- `DISABLED` is the default: initiation answers `503 PAYMENT_PROVIDER_UNAVAILABLE`
  and no webhook route answers;
- `SANDBOX` is accepted only when `APP_ENV` is `local` or `ci`. The
  configuration refuses it in staging and production. It needs
  `PAYMENT_SANDBOX_WEBHOOK_SECRET`: a base64 key of at least 32 bytes,
  server-side only (never `NEXT_PUBLIC_`), distinct from the authentication
  keys. `.env.example` carries a published development-only value.

### SANDBOX

SANDBOX contacts no external service and moves no money. `createPayment` only
returns an opaque, deterministic id `sbx_…` for a given `Payment.reference`
and no redirect: retries therefore model the provider idempotency contract,
and nothing is collected in the browser. The result is simulated by sending a
signed SANDBOX event to the webhook. The browser and integration test
harnesses do exactly that.

A SANDBOX event is JSON:

```json
{
  "id": "evt_…",
  "type": "payment.succeeded",
  "data": {
    "providerPaymentId": "sbx_…",
    "amountMinor": 24690,
    "currency": "EUR"
  }
}
```

`type` is `payment.succeeded` or `payment.failed`; only a failure may carry
`data.failureReason`, which is mapped onto the normalized codes. The schema is
strict: any other field is refused.

The signature header is `ET-Sandbox-Signature: t=<unix seconds>,v1=<hex>`,
where `v1` is the HMAC-SHA256 of `<t>.<raw body>` under the webhook key.

## Webhook

`POST /v1/payments/webhooks/sandbox` (only when `PAYMENT_PROVIDER=SANDBOX`)
has no user session and no CSRF token: it is authenticated by the provider
signature over the **raw** request body. Nest keeps it as `request.rawBody`.

| Check                                         | Failure                                         |
| --------------------------------------------- | ----------------------------------------------- |
| `Content-Type: application/json`              | 415 `PAYMENT_WEBHOOK_INVALID`                   |
| body present, at most 8 KiB                   | 400 / 413 `PAYMENT_WEBHOOK_INVALID`             |
| body above the global 32 KiB JSON limit       | 413 `PAYLOAD_TOO_LARGE` (refused while parsing) |
| signature header well formed                  | 401 `PAYMENT_WEBHOOK_INVALID`                   |
| timestamp within ±300 s of the server         | 401 `PAYMENT_WEBHOOK_INVALID`                   |
| HMAC matches, compared with `timingSafeEqual` | 401 `PAYMENT_WEBHOOK_INVALID`                   |
| strict event schema                           | 400 `PAYMENT_WEBHOOK_INVALID`                   |
| attempt known (provider + provider id)        | 404 `PAYMENT_NOT_FOUND` (nothing recorded)      |
| `providerEventId` not seen before             | 409 `PAYMENT_WEBHOOK_REPLAY` (nothing changes)  |

Accepted events are processed in one transaction:

1. lock the payment `FOR UPDATE`, found by provider and provider payment id;
2. refuse a replay: the unique `(provider, providerEventId)` key, checked under
   the payment lock and enforced by PostgreSQL;
3. if the amount or the currency differs from the attempt: record the event
   (`AMOUNT_MISMATCH` / `CURRENCY_MISMATCH`), leave the attempt PENDING, answer
   422;
4. if the attempt is no longer PENDING: record the event
   (`PAYMENT_ALREADY_SUCCEEDED` → 409 `PAYMENT_ALREADY_SUCCEEDED`, otherwise
   `PAYMENT_NOT_PENDING` → 409 `PAYMENT_INVALID_TRANSITION`);
5. failure: record the processed event, set `PENDING -> FAILED` with the
   normalized code, audit `PAYMENT_FAILED`. The booking stays HELD until it
   expires, and the customer may try again;
6. success: lock the booking `FOR UPDATE`. The success applies only to a booking
   that is still an active hold: `confirmedAt` NULL, `cancelledAt` NULL and
   `holdExpiresAt > database now()`. Otherwise the event is processed as a
   failure (`BOOKING_EXPIRED` → 409 `PAYMENT_BOOKING_EXPIRED`;
   `BOOKING_NOT_PAYABLE` → 409 `PAYMENT_BOOKING_NOT_PAYABLE` or
   `PAYMENT_BOOKING_CONFIRMED`);
7. otherwise: record the processed event, set `PENDING -> SUCCEEDED`, set
   `Booking.confirmedAt = database now()`, audit `PAYMENT_SUCCEEDED` and
   `BOOKING_CONFIRMED`, then commit.

If any audit insert fails, the whole transaction rolls back: no event is
recorded, the attempt stays PENDING and the booking HELD. The provider's retry
of the same event then succeeds.

### Expired hold during payment

PR-10 accepts a success only while the booking is still HELD when the event is
processed. A late success fails the attempt (`BOOKING_EXPIRED`), the booking
stays EXPIRED and its seats are not taken back. With SANDBOX, no customer can
be charged. With Stripe (PAY-EU-1), an attempt only starts while the hold
outlasts the Checkout session by five minutes, and the session expires before
the hold; a late success can only come from a delayed event, is recorded,
never confirms, and must be refunded. With PayPal (PAY-PAYPAL-1), a late
approval is never captured, and a capture completing after the hold is
recorded, never confirms, and must be refunded. **A real PSP integration must add a provider-specific strategy for
asynchronous payments and compensation:** void or refund a capture that
arrives too late, a success on a cancelled attempt, or a mismatched amount.
Until then these cases are recorded and refused, never applied.

## Idempotency

`POST /v1/booking/bookings/:reference/payments` accepts an optional
`Idempotency-Key` header: 16–64 characters among `A-Z a-z 0-9 - _`, for
example a UUID that the browser keeps in memory for one payment intent. The key
is stored on the attempt, unique per **(customer, key)**:

- the same key again for the same booking returns the same attempt (`200`
  instead of `201`), even under concurrency;
- the same key for another booking is refused (`422
PAYMENT_IDEMPOTENCY_KEY_REUSED`);
- another key while an attempt is PENDING answers `409 PAYMENT_ALREADY_PENDING`.

Only the key itself is stored. It is not a secret and it is never logged in
audit events: they only record whether a key was used.

Initiation is deliberately split into three phases:

1. **Reservation transaction:** trip `FOR SHARE`, booking `FOR UPDATE`, full
   payable-state validation, idempotency replay, existing-PENDING check, exact
   amount derivation, then insertion of `Payment` PENDING with
   `providerPaymentId = NULL` and `PAYMENT_CREATED` audit; commit.
2. **Provider call:** outside every transaction, call `createPayment` with the
   committed `Payment.reference`.
3. **Attachment transaction:** lock that `Payment` `FOR UPDATE`, require it to
   remain PENDING, and attach the returned provider id once.

If the provider call fails or its response is lost before Phase 3, the
reserved row is not deleted: it stays PENDING with `providerPaymentId = NULL`.
Replaying the same `Idempotency-Key` finds that exact row, calls the provider
again with the same `Payment.reference`, and attaches the idempotent result.
No second `Payment` row is created. Callers that need recovery must therefore
send an idempotency key; a keyless retry sees the already-reserved PENDING
attempt and is refused.

## Transactions and lock order

There is one hierarchy, without cycle: **trip → payment → booking → booking
seats → seat locks**. Nothing takes a trip after a booking, or a payment after
a booking.

| Operation                    | Locks, in order                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Payment reservation          | trip `FOR SHARE` → booking `FOR UPDATE` → new payment row                                                                               |
| Provider id attachment       | payment `FOR UPDATE`                                                                                                                    |
| Provider event (webhook)     | payment `FOR UPDATE` → booking `FOR UPDATE` (success only)                                                                              |
| Attempt cancellation         | payment `FOR UPDATE`                                                                                                                    |
| Booking cancellation (PR-09) | the booking's PENDING payments `FOR UPDATE` (by id) → booking `FOR UPDATE` → seats → locks                                              |
| Trip cancellation            | trip `FOR UPDATE` → the trip's PENDING payments `FOR UPDATE` (by id) → every non-cancelled booking `FOR UPDATE` (by id) → seats → locks |
| Hold creation (PR-09)        | trip `FOR SHARE` → expired bookings `FOR UPDATE` (by id) → new booking → seats → sorted locks                                           |

Initiation takes the trip `FOR SHARE` (compatible with hold creations) so that
a trip cancellation, holding the trip `FOR UPDATE`, sees a stable set of PENDING
attempts. Neither the booking guard nor the confirmation takes the trip after a
booking: the confirmation trigger only reads the trip status. A trip
cancellation already holds every booking of the trip, so a cancelled trip
cannot keep a confirmable booking.

The provider call sits between the two short transactions above. It holds no
database lock. If reservation loses to booking/trip cancellation or another
keyless PENDING attempt, it is never made. If reservation wins, cancellation
may subsequently win before provider-id attachment; the reserved database row
is still the durable record of the attempted external effect. A real PSP may
add an outbox, void or compensation workflow without moving its network call
inside a transaction.

A booking cancellation locks the booking's PENDING attempts before the booking
and cancels them together with it (`PAYMENT_CANCELLED`). If an attempt was
created between its two lock steps, it answers `409 BOOKING_CANCEL_CONFLICT`
rather than inverting the order.

The concurrency tests prove each race on a real PostgreSQL database. Free
rounds run both requests at once and check the invariants. Forced-order rounds
hold a row lock in a separate transaction so that both requests queue behind it
in a chosen order (PostgreSQL grants row locks in arrival order), which makes
each side win deterministically:

- A: two keyless initiations → one PENDING, one 409, and no provider call from
  the loser;
- B: the same key three times → one attempt for all; every possible provider
  call carries exactly the same `Payment.reference`;
- C: the same event twice → one effect, one replay;
- D: two success events → confirmed once;
- E: success vs booking cancellation;
- F: success vs expiry cleanup → never a confirmed booking without its seat;
- G: success vs trip cancellation → never a cancelled trip with a confirmed
  booking;
- H: success vs failure → one terminal transition;
- I and J: initiation vs trip or booking cancellation → no PENDING attempt
  left on a cancelled trip or booking.

## PostgreSQL guards

Migration `20261013230000_payments` enforces these rules for every writer:

- **CHECK constraints:**
  - `payment_reference_format`, positive amount, currency format, minor unit
    0–3;
  - provider id, idempotency key and provider event id formats;
  - known failure codes;
  - `payment_status_consistent`: exactly the timestamp and failure code of the
    status;
  - transitions after creation;
  - payload hash format;
  - `payment_event_outcome_consistent`: processed xor rejected, known
    rejection codes;
  - `booking_confirmation_consistent`: never with a cancellation, within the
    hold.
- **Partial unique indexes:** one PENDING and one SUCCEEDED attempt per
  booking; one processed event per payment. The schema does not show them
  (see ADR-027), and drift detection does not cover them. The database tests
  assert them.
- **`payment_guard`:**
  - on creation: PENDING, by the booking owner, for an active hold of a
    SCHEDULED trip, with exactly the booking total;
  - identity, booking, amount, currency and key are immutable;
  - the provider id can be learnt once, then never changes;
  - only `PENDING -> terminal` transitions, and terminal rows are final;
  - SUCCEEDED needs a processed success event and an active hold;
  - FAILED needs a processed event;
  - DELETE is refused.
- **`payment_success_confirms_booking`** (deferred constraint trigger): a
  SUCCEEDED attempt commits only together with its booking's confirmation.
- **`payment_event_guard`:** append-only (no UPDATE or DELETE), same provider
  as the payment, processed only while the payment is PENDING.
- **TRUNCATE** is refused on `payment` and `payment_event`.
- **`booking_guard`** (PR-09 rules kept): bookings are created unconfirmed;
  `confirmedAt` is set once, on an active hold, by a succeeded payment of this
  booking; a confirmed booking can neither be cancelled nor change its
  confirmation.
- **`booking_seat_guard` and `seat_inventory_lock_guard`** (PR-09 rules kept):
  a confirmed booking never releases a seat, never deletes a lock, and never
  takes a new seat or lock.
- **`trip_lifecycle_guard`** (PR-06 to PR-09 rules kept): a trip with a
  confirmed booking cannot become CANCELLED.

## API

CUSTOMER endpoints (`/v1/booking`, CUSTOMER session):

| Method | Path                                                   | CSRF | Purpose                                                                                        |
| ------ | ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------- |
| GET    | `/bookings/:reference/payment-options?payerCountry=SN` | no   | PAY-HUB-1: methods of a payer country, each with `code`, `label`, `group`, `available`.        |
| POST   | `/bookings/:reference/payment-quotes`                  | yes  | PAY-HUB-1: an immutable quote, body `{ payerCountry, paymentMethod }` (intentions only).       |
| POST   | `/bookings/:reference/payments`                        | yes  | Start an attempt from a quote, body `{ quoteId, paymentMethod }` (optional `Idempotency-Key`). |
| GET    | `/bookings/:reference/payments`                        | no   | The booking's attempts, newest first.                                                          |
| POST   | `/payments/:reference/cancel`                          | yes  | Give up a PENDING attempt; the booking stays HELD.                                             |

A CUSTOMER sees only: `reference`, `status`, `amountMinor`, `currencyCode`,
`currencyMinorUnit`, `paymentMethod`, `payerCountry`, `presentment` (the
amount the payer was asked for; null for PR-10 attempts), `createdAt`,
`succeededAt`, `failedAt`, `cancelledAt`. Payment options and quotes never
name a provider, a priority or a configuration detail.
The booking views add `confirmedAt` and `payment` (the latest attempt). A
CUSTOMER never sees a provider id, failure detail, event, signature or secret.
Someone else's booking or payment answers the same 404 as an unknown one
(`BOOKING_NOT_FOUND`, `PAYMENT_NOT_FOUND`).

STAFF endpoints (`/v1/admin/payments`, STAFF session + `ops.access`):

| Method | Path          | Permission              | Purpose                                                                                                                                                                            |
| ------ | ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`           | `payment.read`          | Keyset list; filters `status`, `bookingReference`, `paymentReference`, and (PAY-HUB-1) `provider`, `method`, `payerCountry`, `currency` (presentment), `createdFrom`, `createdTo`. |
| GET    | `/:id`        | `payment.read`          | Detail with the provider event timeline (no payload, no signature).                                                                                                                |
| POST   | `/:id/cancel` | `payment.manage` + CSRF | Give up a PENDING attempt, with a 3–500 character reason.                                                                                                                          |

There is deliberately no "mark paid" endpoint: SUCCEEDED only comes from a
valid provider event. The STAFF booking detail includes `payments` only for
callers holding `payment.read`, so a profile with `booking.read` alone receives
no financial payment detail.

| Code                              | HTTP                    | When                                                                    |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `PAYMENT_NOT_FOUND`               | 404                     | unknown or foreign attempt; unknown provider attempt                    |
| `PAYMENT_PROVIDER_UNAVAILABLE`    | 503                     | `PAYMENT_PROVIDER=DISABLED`                                             |
| `PAYMENT_BOOKING_NOT_PAYABLE`     | 409                     | cancelled booking, trip not SCHEDULED or departed                       |
| `PAYMENT_BOOKING_EXPIRED`         | 409                     | the hold has expired (initiation or late success)                       |
| `PAYMENT_BOOKING_CONFIRMED`       | 409                     | the booking is already confirmed                                        |
| `PAYMENT_ALREADY_PENDING`         | 409                     | another attempt is PENDING                                              |
| `PAYMENT_ALREADY_SUCCEEDED`       | 409                     | a second success event for a succeeded attempt                          |
| `PAYMENT_INVALID_TRANSITION`      | 409                     | the attempt is no longer PENDING                                        |
| `PAYMENT_IDEMPOTENCY_KEY_INVALID` | 400                     | malformed `Idempotency-Key`                                             |
| `PAYMENT_IDEMPOTENCY_KEY_REUSED`  | 422                     | a key already used for another booking or quote                         |
| `PAYMENT_METHOD_UNAVAILABLE`      | 409                     | no active provider collects that method (never replaced by another one) |
| `PAYMENT_COUNTRY_UNSUPPORTED`     | 422                     | payer country outside FR, ES, MA, MR, SN                                |
| `PAYMENT_CURRENCY_UNSUPPORTED`    | 422                     | a currency the hub does not present                                     |
| `PAYMENT_FX_UNAVAILABLE`          | 503                     | no rate source for that conversion (staging, production)                |
| `PAYMENT_QUOTE_NOT_FOUND`         | 404                     | unknown quote, or a quote of another booking                            |
| `PAYMENT_QUOTE_EXPIRED`           | 409                     | the quote's validity has passed                                         |
| `PAYMENT_QUOTE_ALREADY_USED`      | 409                     | the quote already started an attempt                                    |
| `PAYMENT_QUOTE_MISMATCH`          | 422                     | the method sent is not the quote's                                      |
| `PAYMENT_QUOTE_LIMIT_REACHED`     | 429                     | more than 50 quotes for one booking                                     |
| `PAYMENT_WEBHOOK_INVALID`         | 400, 401, 413, 415, 422 | an event that fails a check                                             |
| `PAYMENT_WEBHOOK_REPLAY`          | 409                     | an already received provider event id                                   |
| `BOOKING_CONFIRMED`               | 409                     | PR-09 cancellation of a confirmed booking                               |
| `TRIP_HAS_CONFIRMED_BOOKINGS`     | 409                     | trip cancellation with a confirmed booking                              |

No raw Prisma or PostgreSQL error is ever returned.

## Permissions and audit

| Role                                                  | `payment.read` | `payment.manage` |
| ----------------------------------------------------- | -------------- | ---------------- |
| SUPER_ADMIN, DIRECTOR, FINANCE                        | yes            | yes              |
| OPS_MANAGER, BOOKING_AGENT, CUSTOMER_SUPPORT, AUDITOR | yes            | no               |
| DISPATCHER, COMPLIANCE_AGENT                          | no             | no               |
| DRIVER, CREW (CREW realm)                             | no             | no               |

No wildcard. Every `payment.manage` holder also holds `payment.read`.

Audit actions, each in the same transaction as its change:

- `PAYMENT_CREATED` (actor: the CUSTOMER);
- `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED` and `BOOKING_CONFIRMED` (system actor:
  `actor` NULL, the convention for non-human actors). They carry the provider
  and provider event id;
- `PAYMENT_CANCELLED` (the CUSTOMER, the STAFF member, or the STAFF member
  cancelling the trip, with `cancelledBy` and the reason).

They carry references, amounts and status changes. They never carry a webhook
secret, a signature, a checkout secret, a token, an email or a payload.

## User interfaces

- **Booking:** a HELD booking shows a **Paiement** section with **Continuer
  vers le paiement**. In local and CI it states "Environnement de test :
  paiement simulé (SANDBOX), aucun débit réel". No card, security code or IBAN
  field and no third-party frame exist. The page then shows PENDING, refreshes
  every 2 s, and switches to **Réservation confirmée** (amount paid, payment
  reference, confirmation date). It never says "Billet émis".
- **Client, Mes réservations:** HELD, CONFIRMED, EXPIRED and CANCELLED. A HELD
  booking can be paid, or its PENDING attempt cancelled. A CONFIRMED booking
  shows the amount paid, the payment reference and the confirmation date, with
  no cancellation and no refund button.
- **OPS:**
  - **Paiements** (menu with `payment.read`): list (reference, booking
    reference, status, amount, currency, created, succeeded) and detail with a
    minimal timeline;
  - `payment.manage` only adds **Annuler la tentative** for a PENDING attempt;
    there is no "force paid" control;
  - the booking detail shows its payments only with `payment.read`.

Idempotency keys stay in memory. Sessions stay in the existing HttpOnly
cookies: nothing goes to web storage or URLs.

## Database migration and validation

Migration `20261013230000_payments` adds the enums, `payment`,
`payment_event`, `booking.confirmed_at`, the constraints, triggers, indexes,
permissions and role grants. It upgrades a real PR-09 database with
`prisma migrate deploy`: historical HELD bookings keep their data, seats and
locks, stay cancellable, and no payment is created automatically. An automated
test proves this.

`prisma migrate diff` covers tables, columns, plain indexes and foreign keys.
It does not see CHECK constraints, triggers, functions or partial indexes: the
direct PostgreSQL tests and the mutation checks are the authority for those
invariants.

See [ADR-027](../adr/ADR-027-payment-provider-abstraction-booking-confirmation.md).
