# Pricing domain

> Implemented in PR-08 for administration through the Core API and OPS.
> **NOT PRODUCTION DEPLOYED.** The repository contains no real fare, route or
> trip. Tests use codes such as `ROUTE_TEST_EUR` and synthetic amounts.

A **fare table** gives the **base fare** of a journey between two stops of a
route version, as an exact integer amount in the minor unit of one explicit
currency. Its versions are published, historical and immutable. A trip
carries its **historical pricing**: the fare-table version chosen while it was
DRAFT, frozen by scheduling. PR-08 sells nothing.

## Deferred domains

Not in PR-08, and not anticipated: booking, seat reservation, availability,
holds, passengers (PR-09 and later), per-seat prices, seat classes and seat
supplements, child/student/senior fares, round trips, promotions, coupons and
discounts, yield or dynamic pricing, detailed taxes, commissions, payments,
refunds and tickets. A resolved fare is **not a quote or a booking**.

## Model

| Object             | Role                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `FareTable`        | Stable identity: normalized unique `code`, `name`, `routeId`, `currencyCode`, `currencyMinorUnit`, `active`. |
| `FareTableVersion` | Numbered price list for one **published route version**: `DRAFT` → `PUBLISHED` → `RETIRED`.                  |
| `FareEntry`        | One base fare: origin and destination route waypoints of that route version, `amountMinor`.                  |

- `routeId`, `currencyCode` and `currencyMinorUnit` are **immutable**. A fare
  table update changes `name` and `active` only. Changing currency means a
  new fare table.
- At most one DRAFT and one PUBLISHED version per fare table (partial unique
  indexes). Versions are numbered `max + 1`.
- A version prices exactly one route version, which must belong to the fare
  table's route and have been published.
- `Trip.fareTableVersionId` (nullable, FK `RESTRICT`) is the trip's
  historical pricing.

## Money

- **No float or double anywhere.** `amountMinor` is a PostgreSQL `INTEGER`
  (1 to 2 147 483 647) in the currency's minor unit: `12550` with minor unit
  `2` is 125.50 EUR; `15000` with minor unit `0` is 15 000 XOF.
- `currencyCode` is exactly three uppercase letters (`^[A-Z]{3}$`).
  `currencyMinorUnit` is 0 to 3. There is deliberately **no hard-coded ISO
  4217 list**: the operator states the currency and its minor unit
  explicitly when creating the table.
- The API returns `amountMinor`, `currencyCode` and `currencyMinorUnit`
  together. Clients never compute prices.
- `@euroteranga/auth-client` ships tested helpers:
  - `formatMoney(amountMinor, currencyCode, minorUnit)` builds an exact
    decimal string with `BigInt`, then formats it with `Intl.NumberFormat`
    (`12550, 'EUR', 2` → `125,50 EUR`; `15000, 'XOF', 0` → `15 000 XOF`);
  - `parseMoneyToMinor(input, minorUnit)` converts operator input to minor
    units **without rounding**: more decimals than the minor unit, zero,
    negative or out-of-range amounts are refused (`null`). `toFixed` is never
    the calculation authority.

## Fare matrix

Each fare is explicit for one origin/destination pair:

- both waypoints belong to the version's route version;
- both are **stops** (no fare to or from a checkpoint);
- the origin allows boarding, the destination allows alighting;
- the origin comes **before** the destination (`sequence`);
- one fare per pair and version; `amountMinor > 0`.

The matrix may be **partial**. A missing pair has no fare: there is no
fallback, interpolation, symmetry or per-kilometre derivation.

The complete matrix of a DRAFT is replaced **as a whole**, atomically
(`POST …/fares`): validation of every fare, deletion of the old ones,
insertion of the new ones and audit in one transaction.

## Lifecycle and immutability

- A version is created as `DRAFT`.
- Publication requires an **active** fare table, a route version still of
  the fare table's route and published, and **at least one fare**. In one
  transaction:
  1. lock the fare table, then the version;
  2. re-read and re-validate the DRAFT and every fare;
  3. retire the current PUBLISHED version, if any;
  4. publish the draft;
  5. write the audit events. An audit failure rolls everything back.
- `PUBLISHED` and `RETIRED` versions are historical: their fares can never
  change, and they cannot be deleted. A price change means a **new
  version**.
- Deactivating a fare table blocks new publications and new trip
  assignments. It does not alter versions already used.

PostgreSQL enforces this for every writer (migration
`20261013180000_pricing`):

- CHECKs: `fare_table_code_normalized`, `fare_table_name_normalized`,
  `fare_table_currency_code_format`, `fare_table_currency_minor_unit_range`,
  `fare_table_version_number_positive`,
  `fare_table_version_status_timestamps`, `fare_entry_amount_positive`,
  `fare_entry_distinct_waypoints`;
- partial unique indexes `fare_table_version_one_draft_per_fare_table` and
  `fare_table_version_one_published_per_fare_table`;
- `fare_table_identity_guard`: route, currency and minor unit immutable;
- `fare_table_version_history_guard`:
  - versions created as DRAFT, on a published route version of the fare
    table's route, with immutable identity;
  - DRAFT → PUBLISHED requires an active fare table and at least one fare;
  - PUBLISHED → RETIRED only; RETIRED frozen; no deletion of history;
- `fare_entry_guard`: fare writes only while the version is DRAFT (version
  locked `FOR UPDATE`), plus the matrix rules above (membership, stops,
  boarding, alighting, order);
- `TRUNCATE` refused on versions and fares;
- foreign keys `RESTRICT` towards routes, route versions, waypoints and
  trips.

## Trip: historical pricing

`Trip.fareTableVersionId` is changed only through
`POST /v1/admin/trips/:id/fare-table`
(`trip.manage` + `pricing.read` + CSRF), body
`{ fareTableVersionId: uuid | null, expectedFareTableVersionId?: uuid | null }`,
and **only while the trip is DRAFT**. Scheduling freezes it; cancellation
keeps it.

- A **new** assignment needs a currently `PUBLISHED` version of an **active**
  fare table whose `routeVersionId` is **exactly** the trip's route version.
- `expectedFareTableVersionId` refuses a decision taken on a stale screen
  (`TRIP_FARE_TABLE_CONFLICT`).
- **No implicit pricing.** Trip creation never sets it, and nothing copies
  a fare table automatically.
- Pricing is **optional for scheduling**, so PR-06/PR-07 trips stay valid.
- A version retired later, or a fare table deactivated later, stays valid
  on historical trips: they keep resolving their fares.
- PostgreSQL (`trip_lifecycle_guard`, extended by `CREATE OR REPLACE` with
  every PR-06/PR-07 rule kept) refuses a pricing change outside DRAFT, a
  version never published and a version of another route version.
- The trip view exposes the **identity** of its fare-table version (code,
  version, currency, number of priced pairs) to `trip.read` holders. Amounts
  are only available with `pricing.read`.

## Fare resolution

`GET /v1/admin/trips/:id/fare?originRouteWaypointId=…&destinationRouteWaypointId=…`
(`trip.read` + `pricing.read`) resolves one base fare on the server, from
the trip's own fare-table version:

| Result                        | HTTP | When                                                             |
| ----------------------------- | ---- | ---------------------------------------------------------------- |
| fare                          | 200  | `amountMinor`, `currencyCode`, `currencyMinorUnit` and every id  |
| `TRIP_NOT_FOUND`              | 404  | unknown trip                                                     |
| `TRIP_PRICING_NOT_CONFIGURED` | 422  | the trip has no fare-table version                               |
| `FARE_WAYPOINT_INVALID`       | 422  | not stops of the trip's route version, boarding/alighting, order |
| `FARE_NOT_CONFIGURED`         | 404  | a valid pair with no fare in that version (no fallback)          |

## Lock hierarchy

No cycle is possible; checked empirically by the concurrency tests:

| Operation                                     | Locks, in order                                                  |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Trip pricing assignment                       | trip `FOR UPDATE` → fare_table `FOR SHARE` → version `FOR SHARE` |
| Draft creation, fare replacement, publication | fare_table `FOR UPDATE` → version `FOR UPDATE`                   |
| Direct fare writes (trigger)                  | version `FOR UPDATE`                                             |

Publication never locks trips. An assignment racing the supersession of its
version either sees it still PUBLISHED (and is serialized before the
retirement) or is refused with `FARE_TABLE_VERSION_RETIRED`.

## Administration API

All endpoints are below `/v1/admin/pricing`. They require a STAFF session
and `ops.access`. Reads also require `pricing.read`; mutations require
`pricing.manage` and CSRF.

| Method | Path                                           | Purpose                                                              |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/fare-tables`                                 | Keyset pagination, `active` and `routeId` filters, version summaries |
| GET    | `/fare-tables/:id`                             | Versions with route waypoints, fares, `entryCount`, trip usage       |
| POST   | `/fare-tables`                                 | Create a fare table                                                  |
| POST   | `/fare-tables/:id`                             | Update name and active only                                          |
| POST   | `/fare-tables/:id/versions`                    | Create the next DRAFT for `{ routeVersionId }`                       |
| POST   | `/fare-tables/:id/versions/:versionId/fares`   | Replace the complete DRAFT matrix                                    |
| POST   | `/fare-tables/:id/versions/:versionId/publish` | Publish (retiring the previous version)                              |

There is no delete endpoint. Errors never expose Prisma or PostgreSQL:

| Code                                                   | HTTP | When                                                    |
| ------------------------------------------------------ | ---- | ------------------------------------------------------- |
| `VALIDATION_FAILED`                                    | 400  | bad currency format, non-integer amount, unknown fields |
| `FARE_TABLE_NOT_FOUND`, `FARE_TABLE_VERSION_NOT_FOUND` | 404  | unknown id or a version of another fare table           |
| `ROUTE_NOT_FOUND`, `ROUTE_VERSION_NOT_FOUND`           | 404  | unknown route or route version                          |
| `FARE_TABLE_CODE_CONFLICT`                             | 409  | duplicate code                                          |
| `FARE_TABLE_DRAFT_ALREADY_EXISTS`                      | 409  | a second draft                                          |
| `FARE_TABLE_VERSION_NOT_DRAFT`                         | 409  | editing or publishing a published/retired version       |
| `FARE_TABLE_ROUTE_MISMATCH`                            | 422  | route version of another route                          |
| `FARE_TABLE_ROUTE_VERSION_NOT_PUBLISHED`               | 422  | route version never published                           |
| `FARE_ENTRIES_INVALID`                                 | 422  | matrix rules (precise message)                          |
| `FARE_TABLE_VERSION_NOT_PUBLISHABLE`                   | 422  | no fare, inactive fare table                            |
| `FARE_TABLE_VERSION_NOT_PUBLISHED`                     | 422  | assigning a DRAFT version to a trip                     |
| `FARE_TABLE_VERSION_RETIRED`                           | 422  | newly assigning a retired version                       |
| `FARE_TABLE_INACTIVE`                                  | 422  | newly assigning a version of an inactive fare table     |
| `TRIP_FARE_TABLE_CONFLICT`                             | 409  | stale `expectedFareTableVersionId`                      |
| `TRIP_FARE_TABLE_INCOMPATIBLE`                         | 422  | version pricing another route version                   |
| `TRIP_NOT_DRAFT`, `TRIP_CANCELLED`                     | 409  | pricing change after scheduling or cancellation         |

## Permissions

| Role                                                          | `pricing.read` | `pricing.manage` |
| ------------------------------------------------------------- | -------------- | ---------------- |
| SUPER_ADMIN, DIRECTOR, OPS_MANAGER                            | yes            | yes              |
| DISPATCHER, BOOKING_AGENT, CUSTOMER_SUPPORT, FINANCE, AUDITOR | yes            | no               |
| COMPLIANCE_AGENT                                              | no             | no               |
| DRIVER, CREW (CREW realm)                                     | no             | no               |

Every `trip.manage` holder also holds `pricing.read`, and every
`pricing.manage` holder holds `network.read`; database tests check both.
Assigning a published version to a trip does not require `pricing.manage`.
A synthetic role with `trip.manage` but no `pricing.read` gets 403.

## Audit

The domain reuses the PR-03 audit trail, in the same transaction as each
change:

- `FARE_TABLE_CREATED`, `FARE_TABLE_UPDATED`, `FARE_TABLE_VERSION_CREATED`;
- `FARE_ENTRIES_REPLACED` (before/after matrix and count);
- `FARE_TABLE_VERSION_PUBLISHED`, `FARE_TABLE_VERSION_RETIRED`;
- `TRIP_FARE_TABLE_CHANGED` (before/after, e.g. `ROUTE_TEST_EUR v1 (EUR)`).

The request id is kept. Trip history shows pricing changes without an actor;
the full audit stays behind `audit.read`.

## OPS

- **Tarification** (`/pricing`, menu shown with `pricing.read`): catalogue
  (route, currency, published version, state), fare-table creation (route,
  currency code, minor unit), versions, DRAFT creation on a published route
  version, fare editor, publication, read-only published and retired fares.
  Mutation controls need `pricing.manage`.
- The fare editor offers stops only: origins allowing boarding, then
  destinations allowing alighting and coming after the origin. Amounts are
  converted strictly with `parseMoneyToMinor`. Publication is disabled while
  the matrix is unsaved or empty. The API re-validates everything.
- Trip detail, **Tarification** panel (`pricing.read`): table code, version,
  currency and number of priced pairs; for a DRAFT trip and
  `trip.manage` + `pricing.read`, choice among compatible PUBLISHED versions
  or removal, with the expected value; read-only once scheduled or
  cancelled; fare preview through the resolution endpoint.

## Tests and drift detection

- Unit: matrix rules, DTO normalization and bounds, money helpers.
- Direct database tests (Prisma and raw SQL) for every CHECK, index and
  trigger, including the trip rules. Each protection is covered by a
  mutation check.
- HTTP integration covers:
  - permissions and CSRF;
  - catalogue, versions, atomic fare replacement, publication and
    supersession;
  - trip assignment, compatibility, freezing and historical validity;
  - fare resolution and its errors;
  - audit with request id, and rollback when the audit insert fails;
  - concurrency (drafts, publications, replacements, publication vs
    replacement, trip assignments, assignment vs scheduling, assignment vs
    supersession).
- Upgrade: a PR-07 database with a SCHEDULED trip is migrated by
  `prisma migrate deploy`; the trip stays valid without pricing, can be
  cancelled, and its PR-07 history is byte-identical.
- Browser tests with synthetic seeded data.

`prisma migrate diff` covers tables, columns, indexes and foreign keys. It
does **not** see CHECK constraints, triggers or functions; those are proven
by the database tests and mutation checks.
