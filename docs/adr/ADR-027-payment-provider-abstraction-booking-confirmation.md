# ADR-027 — Payment provider abstraction and booking confirmation

## Status

Accepted — 2026-10-13 (PR-10 Payments). It covers the "Payment Abstraction"
planned under ADR-008 in the master plan.

## Context

PR-09 bookings are provisional holds that expire. Turning a hold into a
confirmed booking requires taking a payment. But the payment service provider
(PSP) is not chosen, no real money may move before deployment decisions, and
card data must never enter EURO TERANGA. Provider results arrive
asynchronously, can be duplicated or replayed, and can race with hold expiry,
customer cancellation and trip cancellation. Refunds do not exist yet.

## Decision

- **Abstraction:** business services use an internal `PaymentProvider`
  interface:
  - `createPayment` is called before the database transaction;
  - `verifyWebhook` and `parseWebhook` normalize authenticated events.

  No PSP SDK is added. The only provider is **SANDBOX**: local, test-only,
  with no external call and no money. The configuration refuses it in staging
  and production (`PAYMENT_PROVIDER=DISABLED` by default).

- **One pipeline:** results only arrive as signed provider events (HMAC-SHA256
  over the raw body, timestamp within ±300 s, constant-time comparison, 8 KiB
  maximum). This is the same pipeline a real PSP will use. Neither the service
  nor STAFF can mark an attempt paid; PostgreSQL requires a processed event for
  SUCCEEDED and FAILED.
- **History:** every attempt is a `Payment` row, PENDING then one final state;
  a new try is a new row. PostgreSQL guarantees, through partial unique
  indexes, at most one PENDING and one SUCCEEDED attempt per booking, and one
  processed event per attempt.
- **Server-derived exact amount:** the amount is the booking's unit fare ×
  seats, computed in BIGINT/`BigInt`, checked by PostgreSQL against the
  booking, and returned only as a safe integer.
- **Idempotency:**
  - initiation accepts an optional `Idempotency-Key`, unique per customer;
  - provider events are unique per `(provider, providerEventId)`;
  - a replay is refused with no effect.
- **Confirmation:**
  - a success confirms the booking (`confirmedAt`) in the same transaction as
    the success, the event record and both audit events;
  - only a still active hold can be confirmed. A late success fails the
    attempt (`BOOKING_EXPIRED`) and is never applied;
  - a confirmed booking keeps its seats after `holdExpiresAt`, cannot be
    cancelled, and blocks the cancellation of its trip until refunds exist.
- **Locks:** one hierarchy, trip → payment → booking → seats → locks:
  - webhooks lock the payment, then the booking;
  - initiation takes the trip `FOR SHARE`, then the booking;
  - booking and trip cancellations lock PENDING payments before bookings, and
    cancel them in the same transaction.
- **Minimal exposure:**
  - customers see their attempts without any provider detail;
  - STAFF need `payment.read` (and `payment.manage` only to give up a PENDING
    attempt);
  - booking details include payments only with `payment.read`.
- **Partial indexes stay in SQL:** the Prisma 7.10 `partialIndexes` preview
  feature would let the schema describe partial unique indexes. Enabling it
  makes the ten partial indexes of earlier migrations appear as drift, so it is
  left to a dedicated change that declares them all. Like those, the PR-10
  partial indexes are created in the migration and proven by database tests.

## Consequences

- No customer can be charged in PR-10, and no card, security code, IBAN or
  raw provider payload is stored or returned.
- A real PSP integration must add:
  - a provider-specific strategy for asynchronous captures and compensation
    (void or refund a success that arrives after expiry, after a cancelled
    attempt, or with a mismatched amount — today these are recorded and
    refused);
  - voiding the provider-side attempt when an attempt is cancelled (an outbox,
    so that no network call happens inside a transaction);
  - acknowledging replays with a success status if the PSP requires it.
- Refunds, tickets, passengers, check-in, promotions, taxes and accounting stay
  separate future domains. CONFIRMED never implies a ticket.
- A trip with confirmed bookings cannot be cancelled before the Refund domain
  exists; operations must reschedule or wait for it.

## Alternatives considered

- **Integrate a real PSP now:** it requires provider choice, contracts, PCI
  scoping and production deployment decisions that are out of scope.
- **Have the sandbox succeed immediately in the service:** this would bypass
  the event pipeline and leave the real code path untested.
- **Store a single mutable payment status on the booking:** this loses the
  attempt history and mixes two state machines.
- **Let STAFF mark payments paid:** this creates an unverifiable path to money
  states.
- **Accept a success after expiry and re-take the seats:** the seats may
  already be sold to someone else; the decision belongs to a compensation
  workflow.
- **Cancel confirmed bookings and their trips without refunds:** this would
  keep the money of cancelled services.
- **Webhook locks booking then payment:** this conflicts with the payment-first
  order needed to process events per attempt, and would create a cycle with
  cancellations.
