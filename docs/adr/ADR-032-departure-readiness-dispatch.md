# ADR-032 — Departure readiness and dispatch authorization

- **Status:** Accepted
- **Scope:** PR-17

## Context

A scheduled trip is not automatically allowed to depart. PR-14 proves passenger-level check-in and boarding facts, PR-15 stores immutable passenger manifests, and PR-16 stores generic operational permits with intrinsic validity. None of those facts is, by itself, a departure authorization.

PR-06 intentionally deferred actual departure/arrival, `IN_PROGRESS` / `COMPLETED`, vehicle availability after scheduling, and dispatch.

## Decision

PR-17 introduces a deterministic server-side engine, `departure-readiness/1`, with five ordered gates: **TRIP**, **VEHICLE**, **PASSENGERS**, **MANIFEST**, and **PERMITS**.

A trip is READY only when:

1. it is `SCHEDULED`;
2. an assigned vehicle is currently `ACTIVE` and remains compatible with the trip seat-map snapshot;
3. every traveller on a confirmed, non-cancelled booking is checked in, boarded, and still passes the current PR-14 readiness derivation;
4. the latest PR-15 manifest hash equals a fresh canonical snapshot of the current check-in/boarding population;
5. a published, versioned permit policy exists and every explicit synthetic requirement has a matching PR-16 permit that is `ACTIVE` and intrinsically `VALID` on the database calendar date.

Missing permit policy is a blocker. A published policy with zero requirements is an explicit statement that the trip currently requires no operational permits. The application never infers real permit types, authorities, corridors, or legal obligations.

Readiness produces a minimized canonical snapshot and SHA-256 fingerprint. It excludes passenger names, dates of birth, document numbers/files, payment data, QR credentials, raw compliance facts and actor identifiers.

## Departure authorization

Authorization is an explicit STAFF action. The API locks the trip, re-evaluates readiness, requires READY, and creates an immutable append-only `DepartureAuthorization` bound to that exact readiness fingerprint. A matching current authorization may be returned idempotently.

Authorization is not departure. Actual departure locks and re-evaluates again, requires the latest authorization to match the current fingerprint, then records `SCHEDULED -> IN_PROGRESS` with a database-owned actual departure time. Completion records `IN_PROGRESS -> COMPLETED` with a database-owned actual arrival time.

PostgreSQL protects transition order, append-only authorization/policy history, authoritative clocks, active STAFF actors, contiguous versions, vehicle availability/seat-map compatibility at departure, and immutability after departure.

## Permit policy

`DeparturePermitPolicy` is trip-scoped and versioned. Published versions are immutable. Requirements are generic `permitType + scopeType` facts; `COUNTRY` also references an actual country. Other scopes resolve to the current trip operator, vehicle, route version, or trip. No production legal catalogue is seeded.

## Authorization

Dedicated permissions are `departure.read`, `departure.authorize`, and `departure.manage`. SUPER_ADMIN, DIRECTOR, OPS_MANAGER and DISPATCHER receive all three; AUDITOR receives read only; other default roles receive none. Mutations require CSRF.

## Consequences

- `PERMIT_VALID != TRIP_READY`.
- passenger `BOARDED != TRIP_READY`.
- a current manifest is evidence, not authorization.
- stale facts invalidate an earlier departure authorization.
- `CANCELLED` remains terminal; `IN_PROGRESS` and `COMPLETED` cannot be cancelled or operationally edited.
- PR-18 remains responsible for Crew offline PWA, device enrollment and synchronization.
