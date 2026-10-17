# Operational border crossings (PR-20)

PR-20 records operational evidence that a trip reached and passed a route waypoint whose
checkpoint type is `BORDER`. This domain deliberately does **not** model customs clearance, visa
status, immigration approval or legal authority to cross a border.

## State machine

For each `(trip, route waypoint)` the append-only sequence is exactly:

`PENDING -> ARRIVED -> CONTROL_STARTED -> CONTROL_COMPLETED -> DEPARTED`.

Only persisted events exist in the database; `PENDING` is a projection used by the APIs/UI.
`occurredAt` cannot move backwards and cannot be more than five minutes in the future. The trip
must be `IN_PROGRESS`, and the waypoint must belong to the trip's published route version and
resolve to a `BORDER` checkpoint.

## Idempotence and immutability

Every client mutation carries a `clientEventId`. `(tripId, clientEventId)` is unique and a SHA-256
fingerprint binds the id to the semantic payload. An exact replay returns the original event with
`created=false`; reusing the id for different content is a conflict. PostgreSQL triggers reject
UPDATE, DELETE and TRUNCATE and serialize transitions per trip/waypoint with an advisory lock.

## Provenance

STAFF events store the authenticated staff identity. Crew events additionally store the active
`crew_trip_assignment` and enrolled `crew_device`; PostgreSQL rechecks that both belong to the
recording identity and remain valid at insert time.

## API and permissions

- `GET /v1/admin/borders/trips/:tripId` — `border.read`
- `POST /v1/admin/borders/trips/:tripId/events` — `border.manage` + CSRF
- `POST /v1/crew/trips/:tripReference/borders/events` — `crew.border.report` + CSRF
- the shared Crew offline sync accepts `BORDER_EVENT` only under `crew.border.report`

OPS shows current state, the only valid next transition and the immutable history. Crew derives
the same next transition from the authoritative cached snapshot plus unsynchronized local events.

## Offline browser storage

PR-20 reuses the PR-18 durable Crew event queue. IndexedDB schema version 2 repairs legacy v1
installations that are missing one or more required stores without requiring users to clear site
data manually.
