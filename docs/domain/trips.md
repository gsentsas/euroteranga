# Trips domain

> Implemented in PR-06 for administration through the Core API and OPS.
> **NOT PRODUCTION DEPLOYED.** The repository contains no real trip, route,
> place, plate, VIN or commercial reference. Tests use references such as
> `ET-TEST-2030-0001`.

A **trip** is one planned occurrence of a historical, published route version:
"route version 3 of route X, departing on 15 January at 08:00 UTC, with
vehicle Y". It has a timetable (one planned time per waypoint) and an
optional vehicle. It does not sell seats or run on the road.

## Deferred domains

PR-06 deliberately leaves these to later pull requests:

- Passengers, payments, baggage, check-in and boarding. (Seat maps were added
  in PR-07, pricing in PR-08 and provisional booking holds in PR-09; see
  below.)
- **Crew and driver assignment.**
- **Dispatch**: operational follow-up, actual departure/arrival times,
  `IN_PROGRESS`/`COMPLETED` states, handling of vehicles that become
  unavailable after assignment.
- **Tracking/GPS**, maintenance and regulatory documents.

## Model

`Trip` (table `trip`, UUIDv7, `snake_case`, UTC `timestamptz`):

| Field                                    | Rules                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `reference`                              | Public, stable, **immutable**. Trimmed, uppercase, `[A-Z0-9][A-Z0-9_-]{2,31}`, unique. |
| `routeVersionId`                         | Exactly one route version, which **has been published**. Immutable, FK `RESTRICT`.     |
| `vehicleId`                              | Optional, FK `RESTRICT`. Changed only through the vehicle operation.                   |
| `status`                                 | `DRAFT`, `SCHEDULED`, `CANCELLED`.                                                     |
| `plannedDepartureAt`, `plannedArrivalAt` | Copied from the timetable: first departure, last arrival.                              |
| `scheduledAt`                            | NULL in DRAFT, set when SCHEDULED, kept after a cancellation.                          |
| `cancelledAt`                            | Set if and only if CANCELLED.                                                          |

`TripWaypointTiming` (table `trip_waypoint_timing`): one row per waypoint of
the route version (`routeWaypointId`, `sequence`, `plannedArrivalAt`,
`plannedDepartureAt`). The pairs (trip, sequence) and (trip, waypoint) are
unique. The waypoint must belong to the trip's route version and the sequence
must equal the waypoint's.

### Historical route versions

A trip references the route version that was published when it was planned.
Publishing a newer version retires the old one, but **existing trips stay
valid**: they keep pointing to their version and its frozen geometry. New
trips are created on a currently `PUBLISHED` version (service rule). The
database only requires that the version _has been_ published, so that
history stays consistent. A `DRAFT` route version can never be used.

## Lifecycle

| From        | Allowed to               |
| ----------- | ------------------------ |
| `DRAFT`     | `SCHEDULED`, `CANCELLED` |
| `SCHEDULED` | `CANCELLED`              |
| `CANCELLED` | none (terminal, frozen)  |

There is no `IN_PROGRESS` or `COMPLETED`: those belong to Dispatch.

- `SCHEDULED` means a valid published route, a complete and valid timetable,
  and frozen times.
- Cancellation needs a reason. It is possible from `DRAFT` or `SCHEDULED`.

## Timetable (UTC)

All times are stored and entered in **UTC**. The timezones of stops and
checkpoints are used for presentation only (OPS shows each point's local time
as a hint).

Rules for a complete timetable:

- exactly one timing per waypoint of the route version;
- **first** waypoint: departure only;
- **last** waypoint: arrival only;
- **intermediate** waypoints, checkpoints included: arrival and departure,
  with arrival ≤ departure (a zero dwell is allowed);
- each arrival is **strictly after** the previous waypoint's departure;
- the trip's planned departure and arrival equal the first departure and the
  last arrival.

The timetable is replaced **as a whole**, atomically, and only while the trip
is `DRAFT`. Users enter times only; the order comes from the immutable route
version. Once `SCHEDULED` (or `CANCELLED`), the timetable is **frozen**.

## Vehicle

- Optional: a trip can be scheduled without a vehicle.
- A dedicated operation assigns, changes or removes it. The general API never
  accepts `vehicleId` changes elsewhere.
- **Policy: the vehicle must be `ACTIVE` when assigned, also in DRAFT.** This
  is simpler and stronger than checking only at scheduling. It is checked
  again when scheduling.
- `CANCELLED` trips accept no change. Once `SCHEDULED`, a change requires a
  reason.
- **Known limitation:** the fleet lifecycle is not blocked. A vehicle assigned
  to a scheduled trip may later go `OUT_OF_SERVICE` or be `RETIRED`. That
  operational conflict will be handled by Dispatch.

## Seat map (PR-07)

A trip may carry a **historical seat map** (`seatMapVersionId`, with its
computed capacity).

- It is chosen or removed while the trip is **DRAFT** through
  `POST /:id/seat-map` (`trip.manage` + `seatmap.read`, optional
  `expectedSeatMapVersionId`).
- It is frozen by scheduling and kept after cancellation.
- It is optional for scheduling, so PR-06 trips stay valid.
- A version retired later stays valid on the trip.
- **Compatibility:** a trip carrying a seat map only accepts a vehicle
  configured with exactly that version. This is checked when the seat map or
  the vehicle of the trip changes and when scheduling
  (`TRIP_SEAT_MAP_INCOMPATIBLE`), in the service and in PostgreSQL. Nothing
  is assigned implicitly: OPS offers an explicit _Utiliser le plan du
  véhicule_ action.
- **Limitation:** a vehicle reconfigured after scheduling leaves the trip on
  its historical layout. Dispatch will handle the mismatch.

See [seat-maps.md](seat-maps.md).

## Pricing (PR-08)

A trip may carry a **historical pricing** (`fareTableVersionId`): the
fare-table version whose base fares apply to its journeys.

- It is chosen or removed while the trip is **DRAFT** through
  `POST /:id/fare-table` (`trip.manage` + `pricing.read` + CSRF, optional
  `expectedFareTableVersionId`). Trip creation never sets it.
- A new assignment needs a currently PUBLISHED version of an active fare
  table pricing **exactly** the trip's route version
  (`TRIP_FARE_TABLE_INCOMPATIBLE` otherwise).
- It is frozen by scheduling and kept after cancellation.
- It is optional for scheduling, so PR-06/PR-07 trips stay valid.
- A version retired later, or a fare table deactivated later, stays valid on
  the trip.
- `GET /:id/fare?originRouteWaypointId&destinationRouteWaypointId`
  (`trip.read` + `pricing.read`) resolves one base fare on the server:
  `TRIP_PRICING_NOT_CONFIGURED`, `FARE_WAYPOINT_INVALID` and
  `FARE_NOT_CONFIGURED` otherwise, with no fallback.
- Trip responses carry the full fare-table summary for `pricing.read`
  holders only. With `trip.read` alone: `id`, `version`, `fareTable.code`,
  `fareTable.currencyCode` and `entryCount`.
- The migration `20261013180000_pricing` extends `trip_lifecycle_guard`
  (`CREATE OR REPLACE`) and keeps every PR-06 and PR-07 rule.

See [pricing.md](pricing.md).

## Booking holds (PR-09)

Only a `SCHEDULED`, future trip with both a historical seat map and historical
pricing is publicly bookable. Search returns an exact origin/destination
route-waypoint pair; availability and hold creation revalidate that pair on
the server.

Cancelling a trip locks and cancels every active hold of that trip, releases
its segment inventory and writes `BOOKING_CANCELLED_BY_TRIP` audit events in
the same transaction as `TRIP_CANCELLED`. A concurrent hold creation is
serialized by the trip lock: it either commits before and is included in the
cascade, or sees the cancelled trip and fails. No active booking survives a
cancelled trip.

Trip history itself remains independent of the booking list. See
[bookings.md](bookings.md).

## Enforcement in PostgreSQL

The migration `20261013120000_trips_timetable` enforces the rules for every
writer, including direct Prisma or SQL access:

- CHECKs: normalized reference, `scheduled_at`/`cancelled_at` consistent with
  the status, trip times both set or both empty with arrival after departure,
  timing sequence > 0, at least one time per timing, arrival ≤ departure at a
  waypoint.
- `trip_lifecycle_guard`:
  - insert as `DRAFT` on a version that has been published;
  - immutable id, reference, route version and creation date;
  - the transition matrix; `CANCELLED` frozen;
  - planned times and `scheduled_at` frozen outside `DRAFT`;
  - the full timetable validated by `trip_timetable_error()` on
    `DRAFT → SCHEDULED`;
  - an `ACTIVE` vehicle (locked `FOR SHARE`) on assignment and on scheduling;
  - `DELETE` refused.
- `trip_waypoint_timing_guard`: writes allowed only while the trip is
  `DRAFT`, with the trip row locked `FOR UPDATE`, so timing writes and
  scheduling are serialized. The waypoint must belong to the trip's version,
  with the same sequence.
- `TRUNCATE` refused on both tables.

Trigger errors are a second barrier: the API validates first and returns
stable public errors.

## Concurrency

Lock order for every trip mutation: **trip row `FOR UPDATE`, then vehicle row
`FOR SHARE`**, then, for seat maps (PR-07), seat map and version `FOR SHARE`,
and, for pricing (PR-08), fare table and version `FOR SHARE`. Fleet status
changes lock only the vehicle row and fare-table publication never locks a
trip, so no deadlock
cycle is possible. Consequences, all tested on PostgreSQL:

- two timetable replacements are serialized; the result is one complete
  submission, never a mix;
- scheduling vs. replacement: one wins, and the scheduled timetable is
  exactly the one in force;
- scheduling vs. cancellation: the final state is `CANCELLED`, with
  `scheduledAt` set only if scheduling committed first;
- two vehicle assignments decided on the same state (`expectedVehicleId`):
  one applies, the other gets 409;
- an assignment racing a fleet status change is serialized: either the
  vehicle was still `ACTIVE`, or the assignment is refused.

## Administration API

All endpoints are below `/v1/admin/trips`. They require a STAFF session and
`ops.access`. Reads also require `trip.read`; mutations require
`trip.manage` and a session-bound CSRF token.

| Method | Path             | Purpose                                                                                         |
| ------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/`              | Keyset pagination; filters `status`, `routeId`, `routeVersionId`, `departureFrom`/`departureTo` |
| GET    | `/:id`           | Trip with route geometry, timetable, vehicle summary and history                                |
| POST   | `/`              | Create a DRAFT trip (`reference`, `routeVersionId`, optional `vehicleId`)                       |
| POST   | `/:id/timetable` | Replace the complete DRAFT timetable                                                            |
| POST   | `/:id/schedule`  | `DRAFT → SCHEDULED`                                                                             |
| POST   | `/:id/cancel`    | Cancel with `reason` (optional `expectedStatus`)                                                |
| POST   | `/:id/vehicle`   | `vehicleId` (null removes), optional `expectedVehicleId`, `reason` once SCHEDULED               |

There is no delete endpoint. Instants are ISO 8601 **with an explicit
offset**. Errors:

| Code                                                             | HTTP | When                                              |
| ---------------------------------------------------------------- | ---- | ------------------------------------------------- |
| `VALIDATION_FAILED`                                              | 400  | invalid input (e.g. an instant without offset)    |
| `TRIP_NOT_FOUND`, `ROUTE_VERSION_NOT_FOUND`, `VEHICLE_NOT_FOUND` | 404  | unknown id                                        |
| `TRIP_REFERENCE_CONFLICT`                                        | 409  | duplicate reference                               |
| `TRIP_NOT_DRAFT`                                                 | 409  | timetable change or scheduling outside DRAFT      |
| `TRIP_CANCELLED`                                                 | 409  | any change to a cancelled trip                    |
| `TRIP_STATUS_CONFLICT`                                           | 409  | `expectedStatus` differs                          |
| `TRIP_VEHICLE_CONFLICT`                                          | 409  | `expectedVehicleId` differs                       |
| `TRIP_ROUTE_VERSION_NOT_PUBLISHED`                               | 422  | route version never published                     |
| `TRIP_ROUTE_VERSION_RETIRED`                                     | 422  | creation on a retired version                     |
| `TRIP_TIMETABLE_INVALID`                                         | 422  | timetable rule broken (precise message)           |
| `TRIP_VEHICLE_UNAVAILABLE`                                       | 422  | vehicle not `ACTIVE`                              |
| `TRIP_REASON_REQUIRED`                                           | 422  | vehicle change on a scheduled trip without reason |

## History

`GET /:id` returns the last 50 business events, read from the audit trail:
action, date, reason, status change and vehicle change. They deliberately
expose **no actor identity** to `trip.read` holders; the full audit stays
behind `audit.read`. The trip detail includes a minimal vehicle summary
(code, status, model) even for holders without `fleet.read`, as part of the
trip itself.

## Permissions

| Role                                                       | `trip.read` | `trip.manage` |
| ---------------------------------------------------------- | ----------- | ------------- |
| SUPER_ADMIN, DIRECTOR, OPS_MANAGER, DISPATCHER             | yes         | yes           |
| BOOKING_AGENT, COMPLIANCE_AGENT, CUSTOMER_SUPPORT, AUDITOR | yes         | no            |
| FINANCE                                                    | no          | no            |
| DRIVER, CREW (CREW realm)                                  | no          | no            |

Every `trip.manage` holder also holds `network.read` and `fleet.read`, which
it needs to choose a route version and a vehicle. A database test checks
this.

## Audit

The domain reuses the PR-03 append-only audit trail, in the same transaction
as each change: `TRIP_CREATED`, `TRIP_TIMETABLE_REPLACED` (before/after
timings), `TRIP_SCHEDULED`, `TRIP_CANCELLED` (reason in `metadata`),
`TRIP_VEHICLE_CHANGED` (before/after vehicle). The request id is kept. If the
audit insert fails, the mutation rolls back.

## Tests and drift detection

- Unit: every timetable rule; input normalization.
- Direct database tests (Prisma and raw SQL) for every CHECK and trigger,
  each covered by a mutation check.
- HTTP integration: permissions, CSRF, lifecycle, timetable, vehicle, audit
  and rollback, concurrency, filters, absence of a delete endpoint.
- Browser tests with synthetic seeded data.

`prisma migrate diff` covers what Prisma models (tables, columns, indexes,
foreign keys). It does **not** see CHECK constraints, triggers or functions;
those are proven by the database tests and their mutation checks.
