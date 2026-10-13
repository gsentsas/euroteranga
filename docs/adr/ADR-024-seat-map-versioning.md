# ADR-024 — Seat-map versioning and historical trip layout

## Status

Accepted — 2026-10-13 (PR-07 Seat maps)

## Context

Pricing and booking will sell seats on trips. They need a seat layout that
does not change after sale. Vehicles are reconfigured over their life. If a
trip followed its vehicle's current layout, a reconfiguration would silently
move sold seats. A capacity typed by hand would drift from the actual layout.

## Decision

- `SeatMap` (stable identity), `SeatMapVersion` (numbered layout) and
  `SeatMapCell` (physical position) are separate. Versions follow
  `DRAFT → PUBLISHED → RETIRED`, with at most one DRAFT and one PUBLISHED
  per seat map. Publication retires the previous version in the same
  transaction.
- Published and retired versions are immutable, enforced by PostgreSQL
  triggers for every writer. Physical changes require a new version.
- Cells have physical kinds only, no seat class. Labels exist for seats only.
  **Capacity is the count of SEAT cells**, always computed.
- A **vehicle** carries its _current_ seat map. A **trip** carries its
  _historical_ seat map, chosen while DRAFT and frozen by scheduling. Both
  reference published versions (database rule); new assignments use the
  currently published version of an active seat map (service rule).
- Compatibility is one symmetric, strict rule. A trip carrying a seat map only
  accepts a vehicle configured with exactly that version. It is checked when
  either side changes and when scheduling, in the service and in the
  database. Nothing is assigned implicitly.
- A seat map is optional for scheduling, so PR-06 trips stay valid.
- Lock hierarchy: trip → vehicle → seat map → version; catalogue writes
  take seat map → version.

## Consequences

- Sold seats will refer to an immutable layout. Booking can rely on
  `trip.seatMapVersionId` and its cells.
- A vehicle reconfigured after a trip was scheduled leaves the trip on its
  historical layout. The resulting operational mismatch is accepted and
  documented, for Dispatch to resolve. Blocking Fleet would couple domains
  and hide real changes.
- The strict rule may require configuring a vehicle's seat map before
  assigning it to a trip that already has one. This is intended: an
  unconfigured vehicle cannot be shown to carry the sold layout.
- Triggers are invisible to Prisma drift detection. They are covered by
  direct database tests and mutation checks.

## Alternatives considered

- **Seat layout stored on the vehicle only** — reconfiguration would rewrite
  the history of past and sold trips.
- **Copying cells into each trip** — duplicates an already immutable
  published version.
- **Stored capacity field** — can diverge from the cells.
- **Automatic copy of the vehicle's seat map to the trip** — hides a business
  decision. An explicit action ("Utiliser le plan du véhicule") keeps it
  visible and audited.
- **Compatibility only when both are set** — makes the outcome depend on the
  order of operations.
