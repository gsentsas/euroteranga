# ADR-023 — Trip lifecycle and immutable scheduled timetable

## Status

Accepted — 2026-10-13 (PR-06 Trips)

## Context

Seats, bookings, crew and dispatch will all hang off trips. They need a trip
whose geometry and times do not change under them, and which stays valid
when the network evolves. Without database protection, a direct write could
reschedule a sold trip, attach it to an unpublished route, or leave a
timetable half-replaced.

## Decision

- A `Trip` references exactly one route version that **has been published**.
  The reference is immutable, and so is the route version. Retiring the
  route version later does not invalidate the trip. New trips are created on
  the currently published version.
- Lifecycle: `DRAFT → SCHEDULED | CANCELLED`, `SCHEDULED → CANCELLED`.
  `CANCELLED` is terminal and frozen. Cancellation requires a reason. There
  are no operational states (`IN_PROGRESS`, `COMPLETED`); those belong to
  Dispatch.
- The timetable has one UTC timing per route waypoint. It is replaced
  atomically as a whole and only in `DRAFT`. The first waypoint has a
  departure only, the last an arrival only, intermediates both, and the order
  is strictly chronological.
- `DRAFT → SCHEDULED` freezes the timetable and the planned times.
  PostgreSQL validates the complete timetable at that transition with
  `trip_timetable_error()`, independently of the service.
- The vehicle is optional and changed by a dedicated operation. It must be
  `ACTIVE` when assigned (also in DRAFT) and when scheduling. A change on a
  scheduled trip requires a reason. The fleet lifecycle is not blocked by
  assignments.
- Lock order: trip `FOR UPDATE`, then vehicle `FOR SHARE`. Timing writes lock
  the trip row in their trigger, which serializes them with scheduling.
- No physical deletion: trips are cancelled; `DELETE` and `TRUNCATE` are
  refused.

## Consequences

- Later domains can rely on a scheduled trip's times and geometry never
  changing. A correction means cancelling and creating a new trip, which is
  auditable.
- A scheduled trip may reference a vehicle that later became unavailable.
  This is accepted and documented, and Dispatch will detect and resolve it.
  Blocking fleet changes would couple domains and hide real breakdowns.
- Times are UTC-only in storage. Local-time presentation depends on the
  stops' timezones, which are free text validated elsewhere.
- Triggers add complexity and are invisible to Prisma drift detection. They
  are covered by direct database tests and mutation checks.

## Alternatives considered

- **Times stored in local time with a timezone** — ambiguous around DST
  changes, and harder to compare across borders.
- **Editable scheduled timetable** — would silently move sold trips. A
  correction should be an explicit cancellation and a new trip.
- **Copying the route geometry into the trip** — duplicates data that is
  already immutable once published.
- **Blocking vehicle status changes while assigned** — wrong ownership:
  availability belongs to Fleet, conflict resolution to Dispatch.
