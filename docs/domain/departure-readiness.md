# Departure readiness and dispatch

> Implemented in PR-17. No real regulatory requirement is seeded and nothing in this domain is a legal opinion.

## Boundaries

Whole-trip readiness is distinct from the domains it consumes:

- PR-14 passenger check-in/boarding remains passenger-level;
- PR-15 passenger manifests remain immutable snapshots;
- PR-16 permits remain generic records with intrinsic validity;
- PR-17 alone composes those operational facts into departure readiness and dispatch authorization;
- PR-18 owns Crew offline/device behavior.

**PERMIT_VALID != TRIP_READY. BOARDED != TRIP_READY. MANIFEST_CURRENT != TRIP_READY.**

## Readiness

Engine: `departure-readiness/1`.

The ordered gates are `TRIP`, `VEHICLE`, `PASSENGERS`, `MANIFEST`, `PERMITS`. The API returns `READY` only when every gate passes. Blocker codes are stable and the UI only translates them; it never recomputes a gate.

Confirmed travellers must all be checked in, boarded and still eligible under PR-14. A zero-passenger scheduled trip is not rejected merely for being empty because no minimum-passenger policy exists.

The manifest gate rebuilds the PR-15 canonical snapshot and compares SHA-256 content hashes. Timestamp ordering is not used as proof of freshness.

## Explicit permit policy

A scheduled trip must have a published `DeparturePermitPolicy`. Missing configuration blocks. Publishing an empty list explicitly means zero required operational permits for that policy version.

Requirements are synthetic, data-driven `permitType` values plus a referential scope. PR-17 does not seed or guess any real legal requirement. Matching permits are checked with PR-16 lifecycle and inclusive validity dates using the database current date.

## Authorization and lifecycle

`POST /v1/admin/departure/trips/:tripReference/authorize` creates or reuses an immutable authorization only for the current READY fingerprint.

Actual trip lifecycle:

```text
SCHEDULED -> IN_PROGRESS -> COMPLETED
```

Departure revalidates all facts and the authorization fingerprint. Completion is allowed only from `IN_PROGRESS`. Actual departure/arrival clocks are owned by PostgreSQL.

## API

All routes require STAFF + `ops.access`.

| Method | Route                                                    | Permission                   |
| ------ | -------------------------------------------------------- | ---------------------------- |
| GET    | `/v1/admin/departure/trips/:tripReference/readiness`     | `departure.read`             |
| POST   | `/v1/admin/departure/trips/:tripReference/permit-policy` | `departure.manage` + CSRF    |
| POST   | `/v1/admin/departure/trips/:tripReference/authorize`     | `departure.authorize` + CSRF |
| POST   | `/v1/admin/departure/trips/:tripReference/depart`        | `departure.manage` + CSRF    |
| POST   | `/v1/admin/departure/trips/:tripReference/complete`      | `departure.manage` + CSRF    |

Readiness snapshots and generic audit metadata contain references, states, counts, blocker codes and hashes only; they exclude passenger PII and secrets.

## Exclusions

PR-17 does not implement Crew/driver assignment, offline synchronization, device enrollment, GPS/tracking, refunds, a real permit-requirement catalogue, or production regulatory data.
