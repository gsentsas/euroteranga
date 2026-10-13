# ADR-026 — Segment-based seat inventory and customer booking holds

## Status

Accepted — 2026-10-13 (PR-09 Booking)

## Context

A seat may serve different customers on non-overlapping portions of one trip.
Whole-trip occupancy wastes that capacity; a count-only model cannot identify
the contested seat; an application-only check loses concurrent races. A first
booking release also needs an honest state before payment and ticketing exist.

## Decision

- PR-09 creates authenticated CUSTOMER **holds**, not sales or tickets. Their
  status is derived as HELD, EXPIRED or CANCELLED from cancellation and the
  database clock.
- Inventory is represented by one `SeatInventoryLock` per selected seat and
  route segment. A journey occupies `[originSequence, destinationSequence)`.
- PostgreSQL uniquely constrains `(trip, seatMapCell, segmentSequence)`. The
  service pre-check improves the response, but the unique key decides races.
- `BookingSeat` is historical and retained; operational locks are removed on
  cancellation or cleanup after expiry.
- Creation, every selected seat, every segment lock and `BOOKING_HELD` audit
  event are one transaction. Multi-seat creation is atomic.
- The server derives identity, labels, availability, fare and currency. It
  snapshots the trip's historical fare entry and exact integer unit amount.
- CUSTOMER reads and cancellations are always owner-scoped. Foreign and
  unknown references are indistinguishable.
- Cancelling a trip cancels its active holds and releases inventory in the
  same transaction and audit chain.
- `booking.read` controls STAFF reads; `booking.manage` controls reasoned
  cancellation. Hiding UI controls is not authorization.

## Consequences

- Overlapping journeys cannot hold the same physical seat even under real
  PostgreSQL concurrency; adjacent journeys can reuse it.
- Expiry is correct without a scheduler because active queries use database
  time. Lazy transactional cleanup bounds stale operational rows.
- Historical seat and fare versions make every hold explainable after later
  catalogue changes.
- The number of lock rows is seats × travelled segments. This is accepted for
  the first corridor and measured by integration tests; a different inventory
  representation would require evidence and a new ADR.
- Payment, confirmation, passenger manifests and tickets remain separate
  future state machines; no PR-09 label implies completion or purchase.

## Alternatives considered

- **One lock per seat for the whole trip** — safe but prevents valid adjacent
  reuse and understates capacity.
- **Available-seat counters per segment** — cannot guarantee the same physical
  seat across all segments or render an authoritative seat map.
- **Check then insert without a database unique key** — concurrent requests
  can both pass the check and overbook.
- **Serializable transactions alone** — broad, harder to reason about, and
  still does not express the invariant as directly as the unique key.
- **Delete expired/cancelled bookings** — destroys customer and audit history.
- **Store a mutable status column** — can drift from expiry time; derived
  status has one authority.
- **Guest booking in PR-09** — would add identity, abuse and recovery decisions
  before they are required.
