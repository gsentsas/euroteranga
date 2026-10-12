# Network domain

> Implemented in PR-04 for administration through the Core API and OPS.
> **NOT PRODUCTION DEPLOYED.** The repository contains no real corridor,
> border, port or regulatory data.

The network domain describes reusable geography and the ordered composition of
commercial routes. Routes are data, never application code. This domain does
not schedule a service: trips, timings, vehicles, seats, prices, bookings,
passengers, baggage, dispatch and tracking remain outside PR-04.

## Model

- **Country** is the country catalogue (`iso2`, `iso3`, display name and active
  state). ISO codes are normalized to uppercase and unique.
- **Stop** is a place where boarding or alighting may be allowed. It belongs to
  a country and carries a normalized unique code, locality, coordinates,
  timezone and active state.
- **Checkpoint** is a passage point, not a passenger stop. Its type is
  `BORDER`, `FERRY_TERMINAL`, `PORT` or `TECHNICAL`. It deliberately carries no
  customs or regulatory rule.
- **Route** is the stable commercial identity (code, name and active state).
  Its geography is held only by versions.
- **RouteVersion** is a numbered snapshot in `DRAFT`, `PUBLISHED` or `RETIRED`
  state.
- **RouteWaypoint** gives one position in a version. It references exactly one
  stop or checkpoint. Passenger boarding/alighting flags apply only to stops.

Internal identifiers are UUIDv7. PostgreSQL names use `snake_case`, timestamps
are UTC `timestamptz`, and references that preserve route history use
`ON DELETE RESTRICT`.

## Database invariants

PostgreSQL enforces the rules that must also survive direct database access:

- ISO2 and ISO3 uniqueness and length;
- latitude in `[-90, 90]` and longitude in `[-180, 180]`;
- unique normalized stop, checkpoint and route codes;
- positive waypoint sequences, unique within a version;
- exactly one of `stop_id` and `checkpoint_id` per waypoint;
- no boarding or alighting at a checkpoint;
- at most one active draft and one active published version per route;
- published and retired waypoints cannot be inserted, updated or deleted;
- published history cannot be physically deleted through its protected
  relationships.

These constraints complement service validation; they do not replace input
validation or authorization.

## Draft and publication lifecycle

Only a `DRAFT` can have its complete waypoint order replaced. OPS sends the
whole ordered list in one request; the server derives contiguous sequences
`1..N`. The interface uses accessible **Monter** and **Descendre** controls and
does not require drag-and-drop.

Before publication, the Core API verifies that:

1. the version is still a draft;
2. it contains at least two waypoints and at least two stops;
3. sequences are contiguous;
4. the first and last waypoints are stops; and
5. every referenced country, stop and checkpoint is active.

Publication is one database transaction. It locks the stable route, retires
the previous published version when present, publishes the draft and writes
the audit event. An audit failure rolls back the complete operation. Database
triggers then protect the published or retired geometry even if code bypasses
the domain service. See
[ADR-021](../adr/ADR-021-route-versioning.md).

## Administration API

All endpoints are below `/v1/admin/network`. They require a STAFF session and
`ops.access`. Reads additionally require `network.read`; mutations require
`network.manage` and a valid session-bound CSRF token.

| Resource       | Read                                          | Mutate                                                                                      |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Countries      | `GET /countries`                              | `POST /countries`, `POST /countries/:id`                                                    |
| Stops          | `GET /stops`                                  | `POST /stops`, `POST /stops/:id`                                                            |
| Checkpoints    | `GET /checkpoints`                            | `POST /checkpoints`, `POST /checkpoints/:id`                                                |
| Routes         | `GET /routes`, `GET /routes/:id`              | `POST /routes`, `POST /routes/:id`                                                          |
| Route versions | included in route detail                      | `POST /routes/:id/versions`, `POST /routes/:id/versions/:versionId/publish`                 |
| Waypoints      | included in route-version detail, in sequence | `POST /routes/:id/versions/:versionId/waypoints` (atomic replacement of the complete draft) |

List endpoints use bounded keyset pagination and return `items` plus
`nextCursor`. Inputs and query strings are validated with Zod. Prisma and
PostgreSQL errors are mapped to fixed public errors.

## Permissions

There is no wildcard grant. The PR-04 migration grants permissions explicitly:

| Role             | `network.read` | `network.manage` |
| ---------------- | -------------- | ---------------- |
| SUPER_ADMIN      | yes            | yes              |
| DIRECTOR         | yes            | yes              |
| OPS_MANAGER      | yes            | yes              |
| DISPATCHER       | yes            | no               |
| BOOKING_AGENT    | yes            | no               |
| COMPLIANCE_AGENT | yes            | no               |
| CUSTOMER_SUPPORT | yes            | no               |
| AUDITOR          | yes            | no               |
| FINANCE          | no             | no               |
| DRIVER / CREW    | no             | no               |

OPS uses the caller's access snapshot to hide navigation and mutation
controls. This is only presentation: the API checks the current database
permissions on every request and returns 403 when a caller bypasses the UI.

## Audit

Administrative mutations reuse the append-only audit trail from PR-03 in the
same transaction as the change. Actions include country, stop, checkpoint and
route creation/update, version creation, atomic waypoint replacement,
publication and retirement. The request id is retained and before/after data
passes through the existing redaction mechanism.

## Data policy and limitations

Tests use synthetic names and coordinates only. No migration seeds a real
Paris–Dakar route or asserts border, ferry, port, stop or legal facts. Those
data require a separate documented verification and loading process.

Deactivation is supported; the HTTP API offers no physical delete. Changing a
country or place after a route publication does not rewrite its historical
waypoint order. Time estimates and regulatory-rule versioning are explicitly
deferred.
