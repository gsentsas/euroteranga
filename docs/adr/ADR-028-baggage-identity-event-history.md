# ADR-028 — Baggage identity, exact weight and append-only event history

- Status: Accepted
- Date: 2026-10-14 (PR-13 Baggage)

## Context

Travellers carry bags that operators must identify and weigh, then follow
through loading, transit and delivery. Several needs shape the design:

- **Labels:** a bag needs a label that scanners can read, without exposing the
  traveller.
- **Exact weight:** a weight recorded at the counter is an operational fact
  that later pricing or disputes may rely on, so it must stay exact.
- **Concurrent writers:** several operators, and later offline devices
  (PR-18), may record events on the same bag at the same time or retry them.
- **Incidents:** a missing or damaged bag must not erase where it was in its
  journey.

No baggage tariff or allowance has been decided yet.

## Decision

1. **Bag owned by a booking passenger.** `Baggage` references the composite
   `BookingPassenger(booking_id, passenger_id)`. The server derives it from
   public references and ownership. PostgreSQL refuses a bag on an
   unconfirmed, cancelled or non-scheduled journey, or on a pair whose
   booking customer is not the passenger owner.
2. **Opaque reference and versioned QR.**
   - The reference is `ETG-` followed by 12 CSPRNG characters.
   - The QR payload is `ETG1:<reference>`, with no PII, rendered locally as
     SVG.
   - The payload identifies the bag and never authorizes anything: every scan
     is authenticated, permission-checked and audited.
3. **Exact decimal weight.** `numeric(6,3)` kilograms, bounded by CHECKs, and
   exchanged as decimal strings. Only STAFF holding `baggage.manage` write it.
4. **Event sourcing light.**
   - `BaggageEvent` is append-only, with a gapless per-bag sequence.
   - `Baggage` keeps a projection of the latest event (lifecycle, exception,
     weight) for queries.
   - Triggers refuse an event that breaks the transition matrix, and a
     projection that differs from the latest event. A deferred constraint
     trigger proves at commit that each bag has its initial event and a
     matching projection.
5. **Lifecycle separate from exceptions.**
   - **Lifecycle:** linear, `REGISTERED → … → DELIVERED`.
   - **Exception:** at most one active, it blocks progress and is cleared
     by `EXCEPTION_RESOLVED`.
   - **Removal:** `REMOVED` is terminal and never a deletion.
6. **Serialized writes and idempotent retries.**
   - Every event locks the bag row first, in the API and in the trigger.
   - An optional `client_event_id`, unique per bag, plus a payload
     fingerprint make retries return the original event. Reusing the id with
     a different payload is a conflict.
7. **No pricing in PR-13.** The allowance and charge columns exist but stay
   `NULL`, and a trigger refuses any change until a pricing decision exists.
8. **Separate permissions.** `baggage.read` and `baggage.manage`, implied by no
   other permission and granted only to roles that handle travellers.

## Consequences

Positive:

- every status is explainable by its event history, and incidents never
  overwrite the lifecycle position;
- duplicate scans and network retries are harmless, which prepares the offline
  Crew scanner (PR-18);
- the QR can be printed and read by anyone without revealing the traveller;
- weights stay exact from input to storage to display.

Trade-offs:

- each event costs a row lock and two writes (event and projection);
- the transition matrix is implemented twice: a pure TypeScript function for
  clear API errors, and a PostgreSQL trigger as the authority. Mutation tests
  cover both;
- `client_event_id` is scoped per bag, not per device;
- allowance and charge columns are reserved without a policy.

## Alternatives considered

- **Mutable status column with a separate free-form log:** rejected. The log
  and the status drift, and history can be rewritten.
- **Deriving the status from events on every read (no projection):** rejected
  for PR-13. Filtering and listing need an indexed status. The projection is
  checked against the latest event instead.
- **QR containing a signed URL or traveller data:** rejected. It turns a label
  into a credential or a PII leak. A versioned opaque identifier is enough
  when every action is authenticated.
- **Floating-point or gram-integer weight in JSON numbers:** rejected. Floats
  lose precision, and integers change the business unit used at the counter.
  A decimal string with a fixed scale is explicit.
- **A separate `baggage.scan` permission:** not needed. A scan is an event
  with a QR lookup and the same authority.
- **Introducing a baggage allowance or excess fee now:** out of scope. No
  tariff has been decided, and finance belongs to PR-22.
