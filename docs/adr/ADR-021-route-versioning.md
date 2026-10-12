# ADR-021 — Versioned routes and immutable published geometry

## Status

Accepted — 2026-10-12 (PR-04 Network)

## Context

A commercial route has a long-lived identity, while its ordered stops and
passage points can change. Trips created later must be able to refer to the
geometry that was valid when they were planned. Editing the live list in place
would silently rewrite history, and keeping routes in application code would
make operational changes require a release.

Publication also has multiple effects: validating the new order, retiring any
previous publication, publishing the draft and recording who did it. A partial
result would leave the network ambiguous.

## Decision

- `Route` is the stable commercial object. Ordered geography belongs to a
  numbered `RouteVersion`, never directly to `Route` and never to hard-coded
  application configuration.
- A route can have at most one active `DRAFT` and one active `PUBLISHED`
  version. PostgreSQL partial unique indexes enforce both rules.
- Draft waypoints are replaced as one ordered collection. The server assigns
  contiguous sequence numbers; clients do not issue independent positional
  writes.
- Publication locks the stable route and runs in one transaction. It validates
  the draft, retires the previous publication, publishes the draft and appends
  the audit event. Any failure, including audit failure, rolls everything back.
- `PUBLISHED` and `RETIRED` geometry is immutable. PostgreSQL triggers reject
  direct waypoint insert, update or delete operations for those versions, so
  the guarantee does not depend only on the service layer.
- Historical relationships use restrictive deletion. Administration uses
  active/inactive state rather than physical deletion.
- A waypoint references exactly one `Stop` or `Checkpoint`. Checkpoints never
  allow passenger boarding or alighting.

## Consequences

- Operational changes require a new draft and publication, producing an
  attributable history instead of an in-place edit.
- Concurrent publication attempts serialize on the route; only one valid
  outcome commits.
- Later trips can reference a route version without their itinerary changing
  when a new version is published.
- Correcting an error in a published geometry means publishing a corrected new
  version. The erroneous version remains retained for auditability.
- Database triggers and partial indexes add migration complexity and require
  direct-database tests in addition to service tests.
- PR-04 records geography only. Durations, schedules, fares, vehicles,
  regulatory rules and real corridor data remain separate concerns.

## Alternatives considered

- **Mutable waypoint list on `Route`** — simple initially, but destroys
  historical meaning and makes concurrent edits unsafe.
- **Copy route rows for every change** — mixes stable commercial identity with
  version state and makes references and uniqueness harder to reason about.
- **Application-only immutability** — a script or direct Prisma write could
  rewrite published history.
- **Effective-date ranges without explicit publication** — useful for some
  catalogues, but does not model an operator-reviewed atomic publication and
  its audit event as clearly.
- **Hard-coded corridors** — requires code deployment for data changes and
  cannot support multiple verified route variants safely.
