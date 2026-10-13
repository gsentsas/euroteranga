# Seat maps domain

> Implemented in PR-07 for administration through the Core API and OPS.
> **NOT PRODUCTION DEPLOYED.** The repository contains no real layout,
> vehicle, route or trip. Tests use codes such as `COACH_TEST_A`.

A **seat map** describes the physical layout of a vehicle: where seats,
aisles, doors, the driver, toilets and stairs are. Its versions are published,
historical and immutable. A vehicle carries its **current** seat map; a trip
carries its **historical** seat map. PR-07 sells no seat.

## Deferred domains

Pricing was added in PR-08 and provisional booking holds use historical seat
maps in PR-09. Still deferred: fare classes, passengers, tickets, payments,
baggage, check-in, boarding, crew, reduced-mobility rules, documents and
maintenance. There is deliberately **no seat class** (VIP, business,
premium…). PR-09 assigns a held seat to a booking, not to a passenger, and
sells nothing.

## Model

| Object           | Role                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `SeatMap`        | Stable identity: normalized unique `code` (e.g. `COACH_TEST_A`), `name`, `active`.                    |
| `SeatMapVersion` | Numbered layout: `DRAFT` → `PUBLISHED` → `RETIRED`. At most one DRAFT and one PUBLISHED per seat map. |
| `SeatMapCell`    | One physical position of a version: `deck`, `row`, `column`, `kind`, `seatLabel`.                     |

Cells:

- **coordinates** are 1-based, with anti-abuse bounds: deck 1–4, row 1–100,
  column 1–20. A position is unique within a version. An absent coordinate is
  an empty area: there is no `EMPTY` kind.
- **kind** is physical only: `SEAT`, `AISLE`, `DRIVER`, `DOOR`, `TOILET`,
  `STAIRS`, `OTHER`.
- **seatLabel** is required for `SEAT` and forbidden otherwise. It is trimmed,
  uppercase, 1–8 characters from `[A-Z0-9-]`, and unique within a version.
  There is no worldwide numbering convention (`1A`, `02` and `12C` are all
  valid).

**Capacity = number of `SEAT` cells.** It is always computed (`seatCount`
in the API) and never stored, so it cannot diverge from the layout.

## Lifecycle and immutability

- A version is created as `DRAFT`. Its layout is replaced **as a whole**,
  atomically.
- Publication requires an **active** seat map and **at least one seat**. In
  one transaction:
  1. lock the seat map, then the version;
  2. re-read and re-validate the DRAFT;
  3. retire the current PUBLISHED version, if any;
  4. publish the draft;
  5. write the audit events.
- `PUBLISHED` and `RETIRED` versions are historical: their cells can never
  change. A physical change means a **new version**.
- Deactivating a seat map blocks new publications and new assignments. It
  does not alter versions already used.

PostgreSQL enforces this for every writer (migration
`20261013150000_seat_maps`):

- CHECKs on codes, timestamps, coordinates and labels;
- partial unique indexes: one DRAFT and one PUBLISHED per seat map;
- `seat_map_version_history_guard`:
  - versions created as DRAFT, with immutable identity;
  - DRAFT → PUBLISHED requires an active parent and at least one SEAT;
  - PUBLISHED → RETIRED only; RETIRED frozen;
  - no deletion of history;
- `seat_map_cell_draft_only`: cell writes only while the version is DRAFT,
  with the version locked `FOR UPDATE`;
- `TRUNCATE` refused on versions and cells.

## Vehicle: current seat map

`Vehicle.seatMapVersionId` is the layout currently configured on the
vehicle. It is changed only through `POST /v1/admin/fleet/vehicles/:id/seat-map`
(`fleet.manage` + `seatmap.read` + CSRF, optional `expectedSeatMapVersionId`).
The general vehicle update rejects it.

- A **new** assignment needs a currently `PUBLISHED` version of an active seat
  map. Retired vehicles stay frozen.
- The database (`vehicle_seat_map_guard`) refuses a version that was never
  published.
- **Retiring the version later does not break the vehicle**: it keeps the
  version until someone assigns another one.

## Trip: historical seat map

`Trip.seatMapVersionId` is the layout of that trip, independent of the
vehicle's future configuration. It is changed only through
`POST /v1/admin/trips/:id/seat-map` (`trip.manage` + `seatmap.read` + CSRF,
optional `expectedSeatMapVersionId`), and **only while the trip is DRAFT**.
Scheduling freezes it; cancellation keeps it.

- A seat map is **not required** to schedule a trip. PR-06 trips stay valid,
  and some services may sell no seats. PR-09 public booking therefore exposes
  only trips that do carry a historical seat map.
- A version retired later stays valid on historical trips. The trip detail
  shows its historical capacity.
- **No silent assignment.** OPS offers an explicit button, _Utiliser le plan
  du véhicule_. Nothing changes the trip's or the vehicle's seat map
  implicitly.

### Compatibility rule

The specification describes compatibility from two sides, assigning a seat
map to a trip and assigning a vehicle to a trip. They disagree when the
vehicle has no seat map. PR-07 resolves this with **one symmetric, strict
rule**:

> A trip that carries a seat map can only have a vehicle configured with
> **exactly** that version. A vehicle without a seat map does not match.

It is checked, in the service and in PostgreSQL (`trip_lifecycle_guard`),
whenever the trip's seat map changes, the trip's vehicle changes, or the trip
is scheduled. Errors: `TRIP_SEAT_MAP_INCOMPATIBLE` (422), and the DB trigger
as a second barrier. The rule does not depend on the order in which the
vehicle and the seat map are assigned.

**Known limitation:** Fleet is not blocked. A vehicle assigned to a scheduled
trip may later be configured with another seat map (or go out of service).
The trip keeps its historical layout. That operational incompatibility will
be handled by Dispatch, like a vehicle becoming unavailable after
scheduling.

## Booking availability (PR-09)

Availability always renders `Trip.seatMapVersionId`, never the vehicle's
current layout. Only cells of kind `SEAT` can be selected; their labels,
coordinates and physical kinds come from that immutable version. Segment
locks refer to those same historical cell ids.

`BookingSeat` retains its seat-map cell reference and physical coordinates
after cancellation or expiry. Operational inventory locks can be deleted
without losing the historical seat shown on the booking. A later vehicle or
catalogue change cannot rewrite an existing booking. See
[bookings.md](bookings.md).

## Lock hierarchy

No cycle is possible; checked empirically by the concurrency tests:

| Operation                                     | Locks, in order                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Trip mutations                                | trip `FOR UPDATE` → vehicle `FOR SHARE` → seat_map `FOR SHARE` → version `FOR SHARE` |
| Vehicle seat-map assignment                   | vehicle `FOR UPDATE` → seat_map `FOR SHARE` → version `FOR SHARE`                    |
| Fleet status change                           | vehicle `FOR UPDATE`                                                                 |
| Draft creation, cell replacement, publication | seat_map `FOR UPDATE` → version `FOR UPDATE`                                         |
| Direct cell writes (trigger)                  | version `FOR UPDATE`                                                                 |

Assignments lock the seat map before the version: the same order as
publication. This lets them check "active" consistently.

## Administration API

All endpoints are below `/v1/admin/seat-maps`. They require a STAFF session
and `ops.access`. Reads also require `seatmap.read`; mutations require
`seatmap.manage` and CSRF.

| Method | Path                               | Purpose                                                                |
| ------ | ---------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/`                                | Keyset pagination, `active` filter, version summaries with `seatCount` |
| GET    | `/:id`                             | Versions with cells, `seatCount`, vehicle and trip usage               |
| POST   | `/`                                | Create a seat map                                                      |
| POST   | `/:id`                             | Update code, name, active                                              |
| POST   | `/:id/versions`                    | Create the next DRAFT                                                  |
| POST   | `/:id/versions/:versionId/cells`   | Replace the complete DRAFT layout                                      |
| POST   | `/:id/versions/:versionId/publish` | Publish (retiring the previous version)                                |

There is no delete endpoint. Errors:

| Code                                                  | HTTP | When                                                        |
| ----------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `VALIDATION_FAILED`                                   | 400  | bounds, unknown kind, unexpected fields                     |
| `SEAT_MAP_NOT_FOUND`, `SEAT_MAP_VERSION_NOT_FOUND`    | 404  | unknown id or a version of another seat map                 |
| `SEAT_MAP_CODE_CONFLICT`                              | 409  | duplicate code                                              |
| `SEAT_MAP_DRAFT_ALREADY_EXISTS`                       | 409  | a second draft                                              |
| `SEAT_MAP_VERSION_NOT_DRAFT`                          | 409  | editing or publishing a published/retired version           |
| `SEAT_MAP_CELLS_INVALID`                              | 422  | duplicated position or label, label rules (precise message) |
| `SEAT_MAP_VERSION_NOT_PUBLISHABLE`                    | 422  | no seat, inactive seat map                                  |
| `SEAT_MAP_VERSION_NOT_PUBLISHED`                      | 422  | assigning a DRAFT version                                   |
| `SEAT_MAP_VERSION_RETIRED`                            | 422  | newly assigning a retired version                           |
| `SEAT_MAP_INACTIVE`                                   | 422  | newly assigning a version of an inactive seat map           |
| `VEHICLE_SEAT_MAP_CONFLICT`, `TRIP_SEAT_MAP_CONFLICT` | 409  | stale expected seat map                                     |
| `TRIP_SEAT_MAP_INCOMPATIBLE`                          | 422  | vehicle and trip seat maps differ                           |

## Permissions

| Role                                                                   | `seatmap.read` | `seatmap.manage` |
| ---------------------------------------------------------------------- | -------------- | ---------------- |
| SUPER_ADMIN, DIRECTOR, OPS_MANAGER                                     | yes            | yes              |
| DISPATCHER, BOOKING_AGENT, COMPLIANCE_AGENT, CUSTOMER_SUPPORT, AUDITOR | yes            | no               |
| FINANCE                                                                | no             | no               |
| DRIVER, CREW (CREW realm)                                              | no             | no               |

Every `fleet.manage` and `trip.manage` holder also holds `seatmap.read`, which
a database test checks. Assigning a published version does not require
`seatmap.manage`: it is not catalogue editing. A synthetic role with
`fleet.manage` or `trip.manage` but no `seatmap.read` gets 403.

## Audit

The domain reuses the PR-03 audit trail, in the same transaction as each
change:

- `SEAT_MAP_CREATED`, `SEAT_MAP_UPDATED`, `SEAT_MAP_VERSION_CREATED`;
- `SEAT_MAP_CELLS_REPLACED` (before/after layout and capacity);
- `SEAT_MAP_VERSION_PUBLISHED`, `SEAT_MAP_VERSION_RETIRED`;
- `VEHICLE_SEAT_MAP_CHANGED`, `TRIP_SEAT_MAP_CHANGED` (before/after).

The request id is kept. Trip history shows seat-map changes without an
actor; the full audit stays behind `audit.read`.

## Tests and drift detection

- Unit: layout rules and input bounds.
- Direct database tests (Prisma and raw SQL) for every CHECK, index and
  trigger, including the vehicle and trip rules, each covered by a mutation
  check.
- HTTP integration covers:
  - permissions and CSRF;
  - catalogue, layout, publication and supersession;
  - assignments and compatibility;
  - audit and rollback;
  - concurrency (drafts, publications, replacements, publication vs
    replacement, assignments, assignment vs scheduling, vehicle change vs
    assignment, assignment vs supersession);
  - historical validity after retirement.
- Browser tests with synthetic seeded data.

`prisma migrate diff` covers tables, columns, indexes and foreign keys. It
does **not** see CHECK constraints, triggers or functions; those are proven
by the database tests and mutation checks.
