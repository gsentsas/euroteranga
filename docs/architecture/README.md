# EURO TERANGA — Target Architecture

> These are target architectural decisions.
> Implementation starts in PR-01 Foundation.
>
> PR-01 implements the technical foundation only (see below). No business
> feature is implemented yet. Pinned toolchain versions are recorded in
> `package.json`, `.node-version` and the catalog in `pnpm-workspace.yaml`.

## Vision

EURO TERANGA operates international road passenger transport between Europe
and Africa. The first product, **EURO TERANGA COACH**, serves the Paris ↔ Dakar
corridor (France → Spain → Morocco → Mauritania → Senegal).

The core primitives (country, city, stop, route, trip, passenger, vehicle) are
designed to remain generic so that future domains (cargo, travel, mobility) can
reuse them. Routes, regulatory rules and corridors are data, never hard-coded.

## Overview

```
Web / Booking / Client / Tracking
            ↓
          Core API
            ↓
        PostgreSQL
            ↓
 OPS / Crew / Workers / Storage
```

## Validated target decisions

| Area           | Decision                             |
| -------------- | ------------------------------------ |
| Style          | Modular Monolith                     |
| Frontend       | Next.js / React / TypeScript         |
| Back-office    | Refine Community                     |
| Backend        | NestJS / TypeScript / REST / OpenAPI |
| Database       | PostgreSQL                           |
| Files          | S3-compatible object storage         |
| Infrastructure | Plesk target environment             |

## Core principles

- **Single business authority: the API.** Frontends never access the database
  directly. Every request goes through authentication, authorization,
  validation, domain services and transactions, with auditing of sensitive
  actions.
- **Database-enforced invariants.** Critical rules (for example, a seat cannot
  be allocated twice) are guaranteed by PostgreSQL constraints, not only by
  application code.
- **Server-side computation.** Prices, readiness and compliance are computed by
  the server; the browser never decides them.
- **Private by default.** Sensitive files live in private object storage, never
  in a public web root.
- **No microservices at launch.** Modules are separated inside one deployable
  backend; extraction is considered only when a proven need exists.

## Foundation (PR-01)

```
apps/
  web, booking, client, tracking, crew   Next.js (App Router) skeletons
  ops                                    Next.js + Refine Community skeleton
  api                                    NestJS Core API: config, database, health
packages/
  config     Zod-validated environment (API and NEXT_PUBLIC_*), Next.js defaults
  logger     Structured JSON logger with redaction
  database   Prisma 7 schema (no models yet), migrations, client factory
  ui         Text brand mark, foundation page shell, design tokens
tests/browser   Playwright tests for the six frontends
infrastructure/dev   PostgreSQL for local development only
```

Request path in the API:

```
request → X-Request-Id (accepted or generated) → Helmet headers → CORS allow-list
        → controller → service → Prisma (PostgreSQL)
errors  → { code, message, requestId } (fixed public messages, details only in redacted logs)
```

## Identity & authentication (PR-02)

`apps/api/src/auth` (AuthModule): realms CUSTOMER / STAFF / CREW, Argon2id
passwords, opaque sessions in host-only HttpOnly cookies (only SHA-256 stored),
session-bound CSRF tokens, staff TOTP with recovery codes, PostgreSQL-backed
rate limits, security event logging. Frontends use `@euroteranga/auth-client`
and never store authentication secrets in the browser.
See [`docs/security/authentication.md`](../security/authentication.md).

## Authorization, RBAC & audit (PR-03)

`apps/api/src/authorization` (AuthorizationModule): permissions and roles
seeded in PostgreSQL (single source of truth), a deny-by-default
`AuthorizationGuard` evaluated from the database on every request,
anti-escalation and last-privileged-admin rules serialized by an advisory
lock, an append-only audit trail written in the same transaction as each
privileged change, STAFF provisioning by invitation with a one-time MFA
enrollment grant, and a CLI-only SUPER_ADMIN bootstrap. The OPS app shows
`/admin/utilisateurs`, `/admin/roles` and `/admin/audit` according to
`GET /v1/admin/access/me`, but the API remains the authority.
See [`docs/security/authorization.md`](../security/authorization.md).

## Network and versioned routes (PR-04)

`apps/api/src/network` (NetworkModule) is the first business domain. Countries,
stops and checkpoints form the geographic catalogue. A stable route owns
numbered versions whose ordered waypoints reference exactly one stop or
checkpoint. Draft orders can be replaced atomically; publication retires the
previous version and writes the audit event in the same transaction.

The database enforces coordinate, uniqueness and exact-one-of constraints and
protects published/retired geometry against direct writes. OPS exposes the
network according to `network.read` and `network.manage`, while the Core API
remains the sole authority. No real corridor is seeded. See
[`docs/domain/network.md`](../domain/network.md) and
[ADR-021](../adr/ADR-021-route-versioning.md).

## Fleet core (PR-05)

`apps/api/src/fleet` (FleetModule) holds the vehicle registry: a stable
internal code, an optional shape-checked VIN, an optional plate tied to a
PR-04 country, and a lifecycle `PLANNED → ACTIVE ⇄ OUT_OF_SERVICE → RETIRED`.
Status changes go through one transactional operation with a reason, a row
lock and an audit event. PostgreSQL enforces the transition matrix, the
terminal `RETIRED` state and the absence of deletion for every writer. OPS
exposes **Flotte** according to `fleet.read` and `fleet.manage`. Trips, seat
maps, maintenance, documents and tracking are deferred. See
[`docs/domain/fleet.md`](../domain/fleet.md) and
[ADR-022](../adr/ADR-022-vehicle-lifecycle.md).

## Trips (PR-06)

`apps/api/src/trips` (TripModule): a trip is one planned occurrence of a
published, historical route version. It has a UTC timetable with one timing
per waypoint, and an optional `ACTIVE` vehicle. Lifecycle:
`DRAFT → SCHEDULED | CANCELLED`, `SCHEDULED → CANCELLED`.

- The timetable is replaced atomically while DRAFT and frozen once scheduled.
- PostgreSQL validates the complete timetable at scheduling, freezes it
  afterwards, and refuses deletion, for every writer.
- Mutations lock the trip, then the vehicle (`FOR SHARE`).
- A vehicle that becomes unavailable after assignment is left to the future
  Dispatch domain.
- OPS exposes **Voyages** according to `trip.read` and `trip.manage`.
- Seat maps and pricing were added in PR-07/PR-08; booking holds in PR-09.
  Crew and dispatch remain deferred.

See [`docs/domain/trips.md`](../domain/trips.md) and
[ADR-023](../adr/ADR-023-trip-lifecycle.md).

## Seat maps (PR-07)

`apps/api/src/seat-maps` (SeatMapModule):

- versioned physical layouts: a seat map, its numbered versions
  `DRAFT → PUBLISHED → RETIRED`, and cells (deck/row/column, physical kind,
  label for seats);
- capacity is the computed count of seats;
- published versions are immutable; a change is a new version.

A vehicle carries its current seat map, through a dedicated Fleet operation.
A trip carries its historical seat map, chosen while DRAFT and frozen at
scheduling. A strict compatibility rule (the trip's vehicle must carry
exactly the trip's seat map) is checked when either side changes and at
scheduling, in the service and in PostgreSQL.

- Lock hierarchy: trip → vehicle → seat map → version.
- OPS exposes **Plans de sièges** according to `seatmap.read` and
  `seatmap.manage`, and seat-map panels on vehicles and trips.
- Booking uses the trip's historical layout from PR-09 onward.

See [`docs/domain/seat-maps.md`](../domain/seat-maps.md) and
[ADR-024](../adr/ADR-024-seat-map-versioning.md).

## Pricing (PR-08)

`apps/api/src/pricing` (PricingModule):

- versioned base fare tables: a fare table (one route, one immutable
  currency and minor unit), its numbered versions
  `DRAFT → PUBLISHED → RETIRED`, each pricing one published route version,
  and explicit fares between two stops;
- money is an exact integer in minor units (`amountMinor`); no float, no
  hard-coded currency list;
- published versions are immutable; a price change is a new version.

A trip carries its historical pricing (`fareTableVersionId`), chosen while
DRAFT among published versions pricing exactly its route version, and frozen
at scheduling. Fares are resolved on the server.

- Lock hierarchy: trip → fare table → version; publication never locks trips.
- OPS exposes **Tarification** according to `pricing.read` and
  `pricing.manage`, and a pricing panel on trips.
- Booking holds use the trip's historical base fare from PR-09 onward.
  Discounts, taxes and payments remain deferred.

See [`docs/domain/pricing.md`](../domain/pricing.md) and
[ADR-025](../adr/ADR-025-versioned-fare-tables-historical-trip-pricing.md).

## Booking holds and segment seat inventory (PR-09)

`apps/api/src/bookings` (BookingModule) provides public stop lookup, journey
search and historical seat availability; authenticated CUSTOMER hold
creation/list/detail/cancellation; and permissioned STAFF administration.

- A journey occupies the half-open route interval
  `[originSequence, destinationSequence)`.
- One PostgreSQL `SeatInventoryLock` per seat and segment, with a unique
  `(trip, seat, segment)` key, is the concurrent overbooking authority.
- `BookingSeat` preserves history; operational locks are released on
  cancellation or transactional cleanup after expiry.
- Identity, seat labels, fare and currency come from the server. Each booking
  snapshots the trip's historical fare in integer minor units.
- Creation, all seats/segments and audit are atomic. Trip cancellation also
  cancels active holds and releases their inventory atomically.
- Booking and Client expose the CUSTOMER flow; OPS exposes **Réservations**
  with `booking.read` / `booking.manage`.

In PR-09 this is a provisional hold only; PR-10 adds payment and
confirmation. Ticketing, passengers and check-in remain deferred. See
[`docs/domain/bookings.md`](../domain/bookings.md) and
[ADR-026](../adr/ADR-026-segment-inventory-booking-holds.md).

## Payments and booking confirmation (PR-10)

`apps/api/src/payments` (PaymentModule) provides:

- CUSTOMER payment attempts for HELD bookings, idempotent per customer key;
- the provider webhook pipeline;
- permissioned STAFF reading.

How it works:

- **Provider abstraction:** business services use an internal
  `PaymentProvider` interface (`createPayment`, `verifyWebhook`,
  `parseWebhook`). The only provider is **SANDBOX**: local, test-only, with no
  external call and no real money, refused in staging and production
  (`PAYMENT_PROVIDER=DISABLED` by default). No PSP SDK, no card data.
- **Initiation order:** a short transaction reserves the PENDING Payment and
  audit first; `createPayment` then runs without a database lock, using the
  committed Payment reference as its idempotency key; a final short
  transaction attaches the provider id. A failed provider call leaves the
  reservation recoverable with the same client idempotency key.
- **Amounts:** the server derives them from the booking (fare × seats, BIGINT /
  `BigInt`); PostgreSQL checks them against the booking.
- **Results:** they arrive only as signed, idempotent provider events
  (`PaymentEvent`). A success atomically sets `Payment` SUCCEEDED and
  `Booking.confirmedAt`, with audit; it applies only to a still active hold.
- **Confirmed bookings:**
  - they keep their seats after the hold expiry;
  - they cannot be cancelled (no refund yet);
  - they block the cancellation of their trip (`TRIP_HAS_CONFIRMED_BOOKINGS`).
- **Lock hierarchy:** trip → payment → booking → seats → locks.
- **Interfaces:** Booking and Client let the customer pay in a clearly
  labelled test environment. OPS exposes **Paiements** with `payment.read`;
  `payment.manage` only gives up PENDING attempts, never "marks paid".

Refunds, ticketing, passengers and real PSP integration remain deferred. See
[`docs/domain/payments.md`](../domain/payments.md) and
[ADR-027](../adr/ADR-027-payment-provider-abstraction-booking-confirmation.md).

## Passengers and private documents (PR-11)

`apps/api/src/passenger-documents` separates the person travelling from the
authenticated CUSTOMER/booker and provides a fail-closed private file
pipeline:

- `Passenger` is owned by one CUSTOMER; `BookingPassenger` attaches that
  person to an owned confirmed booking and serializes the seat-capacity rule
  in PostgreSQL;
- `PassengerDocument` holds immutable metadata only. Binary bytes live behind
  `ObjectStorageProvider`; generated opaque keys and the original filename are
  unrelated;
- the streamed upload validates multipart shape, size, filename/extension,
  MIME and magic bytes, computes SHA-256, writes to private storage, then
  scans the stored stream through `MalwareScanner`;
- logical lifecycle is `QUARANTINED → ACCEPTED | REJECTED`. Failure of storage,
  integrity or scanner never accepts a file, and no storage/scanner call holds
  a database transaction;
- CUSTOMER access is owner-scoped. OPS is read-only under
  `passenger.document.read`; all metadata/detail and content reads stay behind
  the API and sensitive reads are audited;
- downloads stream from private storage with attachment, `nosniff` and
  `private, no-store` headers. No public or signed URL exists in PR-11.

LOCAL storage and the deterministic TEST scanner are local/CI only and are
refused in deployed environments. S3 and ClamAV adapters exist, but PR-11
provisions neither in production; incomplete configuration fails safely.
**TECHNICALLY_ACCEPTED != REGULATORY_VALID. PR-12 owns Compliance** (below). See
[`docs/domain/passenger-documents.md`](../domain/passenger-documents.md),
[`docs/security/passenger-documents.md`](../security/passenger-documents.md)
and
[ADR-005](../adr/ADR-005-private-object-storage-quarantine.md).

## Regulatory compliance (PR-12)

`apps/api/src/compliance` decides whether one passenger, on one booked
journey, meets the regulatory rules that authorized STAFF entered from
official sources, verified and published:

- `ComplianceRule` / `ComplianceRuleVersion`: `DRAFT → PUBLISHED → RETIRED`,
  provenance and verification pinned to a definition digest, inclusive
  effective dates compared with the planned travel date; published versions
  are immutable (PostgreSQL triggers);
- a closed JSON rule language (v1) and a pure deterministic engine
  (`compliance-engine/1`) over server-derived facts (booking → trip → route
  waypoints → countries; passenger nationality and age; technically ACCEPTED
  documents);
- append-only `ComplianceEvaluation` per booking passenger with facts and
  rules fingerprints; staleness is recomputed, never stored;
- append-only `ComplianceReview` (reason mandatory) on the latest current
  evaluation, as a linear chain;
- `compliance.read`, `compliance.review`, `compliance.rule.read`,
  `compliance.rule.manage`; audited STAFF reads.

**CODE_IS_NOT_LEGAL_AUTHORITY. NO_MATCHING_RULE != COMPLIANT.
TECHNICALLY_ACCEPTED != REGULATORY_VALID.** No regulatory rule is shipped.
Permits (PR-16) and trip readiness (PR-17) are separate future domains. See
[`docs/domain/compliance.md`](../domain/compliance.md),
[`docs/security/compliance.md`](../security/compliance.md) and
[ADR-009](../adr/ADR-009-versioned-regulatory-rule-engine.md).

Health probes: `/health` (basic), `/health/live` (process alive),
`/health/ready` (PostgreSQL answers `SELECT 1` within 2 s, otherwise 503).

## Decisions

Recorded in [`docs/adr/`](../adr/README.md): modular monolith (ADR-001),
PostgreSQL and Prisma (ADR-002), NestJS (ADR-003), Refine (ADR-004), Plesk
deployment target — not yet decided (ADR-010), monorepo tooling (ADR-011),
authentication (ADR-012 to ADR-016), authorization (ADR-017 to ADR-020),
route versioning (ADR-021), vehicle lifecycle (ADR-022), trip lifecycle
(ADR-023), seat-map versioning (ADR-024) and versioned fare tables with
historical trip pricing (ADR-025), segment inventory/customer holds
(ADR-026), and the payment provider abstraction with booking confirmation
(ADR-027), plus private object storage/scanning/quarantine (ADR-005) and the
versioned regulatory rule engine (ADR-009).

Still open: production object-storage and malware-scanner provisioning,
offline crew synchronisation, the choice and integration of a real payment
provider (with refunds), regulatory rule versioning, and the production
deployment model.
