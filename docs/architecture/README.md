# EURO TERANGA — Architecture

> The validated target decisions below are implemented on `main` (PR-01 to
> PR-25, then the UI and OPS series). The domain sections are kept in
> delivery order. The current gaps and the roadmap are tracked in
> [`docs/audit/2026-10-full-product-audit.md`](../audit/2026-10-full-product-audit.md).
> Pinned toolchain versions are recorded in `package.json`, `.node-version`
> and the catalog in `pnpm-workspace.yaml`.

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

FLEET-MEDIA-1 links an active MEDIA-1 main photograph and ordered gallery to
the vehicle. Fleet and bookable-trip public reads expose only safe media
presentation fields; OPS reuses the media picker under `fleet.manage` +
`media.read`, and every replacement is audited atomically.

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
Operational permits (PR-16) and trip readiness (PR-17) are separate domains.
See
[`docs/domain/compliance.md`](../domain/compliance.md),
[`docs/security/compliance.md`](../security/compliance.md) and
[ADR-009](../adr/ADR-009-versioned-regulatory-rule-engine.md).

## Baggage (PR-13)

`apps/api/src/baggage` identifies and follows a traveller's bags:

- `Baggage` belongs to one `BookingPassenger` of a confirmed booking on a
  scheduled trip. Its public reference is `ETG-…` and its QR payload is
  `ETG1:<reference>`: no PII, rendered locally, never an authorization;
- the exact measured weight is `numeric(6,3)`, exchanged as a decimal string
  and written only by STAFF with `baggage.manage`;
- an append-only `BaggageEvent` history has a gapless per-bag sequence. The
  status (lifecycle plus a separate active exception, terminal `REMOVED`) is a
  projection checked against the latest event by PostgreSQL triggers;
- every event locks the bag row; an optional `client_event_id` makes retries
  idempotent;
- `baggage.read` and `baggage.manage`; audited STAFF reads.

There is no baggage tariff, allowance or payment. Check-in, boarding,
manifests and the offline Crew scanner are later PRs. See
[`docs/domain/baggage.md`](../domain/baggage.md),
[`docs/security/baggage.md`](../security/baggage.md) and
[ADR-028](../adr/ADR-028-baggage-identity-event-history.md).

## Check-in and boarding (PR-14)

`apps/api/src/check-in` checks in and boards one `BookingPassenger` (one
person on one confirmed booking of one trip):

- `booking_passenger_seat` links the passenger to one unreleased seat already
  booked on the same booking (composite keys; frozen after check-in);
- a pure readiness function (`checkin-readiness/1`) derives six gates —
  booking, payment (PR-10), documents and compliance (current PR-12
  evaluation), seat, baggage (PR-13 active exceptions) — with stable blocker
  codes and no override;
- `passenger_check_in` is the one append-only check-in, with a minimized
  snapshot, a readiness fingerprint and an opaque `ETQ` credential; the QR is
  `ETPAX1:<credential>`, PII-free, an identifier only;
- `passenger_boarding` is the one append-only boarding per check-in: every
  scan re-derives the gates (`CHECK_IN_STALE`), replays by
  `(deviceId, clientEventId)` are idempotent, double boarding is impossible;
- `checkin.read`/`checkin.manage` and `boarding.read`/`boarding.scan`;
  audited STAFF reads.

Manifests (PR-15) are a separate domain; trip readiness and dispatch (PR-17)
and the offline Crew PWA (PR-18) are not part of it: a BOARDED passenger never means the trip may
depart. See [`docs/domain/check-in-boarding.md`](../domain/check-in-boarding.md),
[`docs/security/check-in-boarding.md`](../security/check-in-boarding.md) and
[ADR-029](../adr/ADR-029-operational-boarding-credential.md).

## Passenger manifests (PR-15)

`apps/api/src/manifests` appends immutable versions for one `SCHEDULED` trip:

- only already checked-in booking passengers are captured, with optional
  boarding facts, in deterministic natural seat order;
- the minimized `passenger-manifest/1` JSON snapshot excludes documents,
  payments, compliance evidence, QR/device data, customer e-mail and baggage;
- its canonical SHA-256 and counts are stored with an unpredictable `ETM`
  reference; the trip row lock guarantees contiguous concurrent versions;
- update/delete/truncate are rejected, and every STAFF read, generation and
  CSV export is audited;
- CSV is rendered privately from the stored snapshot, never from live tables.

A manifest is neither trip readiness nor regulatory/dispatch authorization.
See [`docs/domain/manifests.md`](../domain/manifests.md) and
[ADR-030](../adr/ADR-030-immutable-trip-passenger-manifests.md).

## Regulatory permits (PR-16)

`apps/api/src/regulatory-permits` records generic operational authorizations
without encoding corridor law or deciding that a trip may leave:

- an unpredictable `ETRP` public reference, authority/provenance, mandatory
  inclusive validity dates and one explicit scope: operator, country, vehicle,
  historical route version or trip;
- explicit PostgreSQL foreign keys and an exact-one-of scope CHECK rather than
  a free polymorphic resource id;
- lifecycle `DRAFT → ACTIVE → REVOKED`, optimistic revisions, terminal
  revocation and database guards against ambiguous transitions, deletion or
  truncation;
- a pure server-side validity function returning `DRAFT`, `NOT_YET_VALID`,
  `VALID`, `EXPIRED` or `REVOKED` for an explicit database calendar date;
- `permit.read` / `permit.manage`, audited reads and transactional mutation
  events; OPS exposes **Autorisations réglementaires** without a departure
  approval control.

No real permit type, authority reference, legal requirement or corridor rule
is seeded, and PR-16 stores no document file. **PERMIT_VALID != TRIP_READY.
PR-17 owns departure readiness / dispatch authorization.** PassengerManifest
is not a permit, PassengerCompliance is not an operational permit, and
technical document acceptance is not regulatory validity. See
[`docs/domain/regulatory-permits.md`](../domain/regulatory-permits.md) and
[ADR-031](../adr/ADR-031-regulatory-permit-lifecycle.md).

Health probes: `/health` (basic), `/health/live` (process alive),
`/health/ready` (PostgreSQL answers `SELECT 1` within 2 s, otherwise 503).

## Public website content (CMS-1)

`apps/api/src/content` manages the public website as structured content (see
[`docs/domain/content.md`](../domain/content.md) and
[ADR-034](../adr/ADR-034-first-party-structured-cms.md)):

- `ContentEntry` holds pages and two singletons (settings, navigation);
  `ContentRevision` holds the `DRAFT`, `PUBLISHED` and `SUPERSEDED`
  revisions, with immutable history in PostgreSQL;
- `@euroteranga/content` defines the closed set of blocks, links and rich
  text, shared by the API, OPS and the website. There is no HTML and no
  price field;
- the permissions are `content.read`, `content.manage` and `seo.manage`,
  with the `CONTENT_EDITOR` role;
- public reads under `/v1/content` return published content only.

## Decisions

Recorded in [`docs/adr/`](../adr/README.md): modular monolith (ADR-001),
PostgreSQL and Prisma (ADR-002), NestJS (ADR-003), Refine (ADR-004), the Plesk
deployment target (ADR-010, implemented by OPS-1 as systemd services), monorepo tooling (ADR-011),
authentication (ADR-012 to ADR-016), authorization (ADR-017 to ADR-020),
route versioning (ADR-021), vehicle lifecycle (ADR-022), trip lifecycle
(ADR-023), seat-map versioning (ADR-024) and versioned fare tables with
historical trip pricing (ADR-025), segment inventory/customer holds
(ADR-026), and the payment provider abstraction with booking confirmation
(ADR-027), plus private object storage/scanning/quarantine (ADR-005), the
versioned regulatory rule engine (ADR-009), baggage identity with its
append-only event history (ADR-028) and the operational boarding credential
with its check-in readiness snapshot (ADR-029), plus immutable trip passenger
manifests (ADR-030) and the generic regulatory-permit lifecycle with intrinsic
validity (ADR-031), plus operational trip finance without a general ledger
(ADR-033).

Delivered since: departure readiness and dispatch (PR-17, ADR-032), the Crew
offline PWA (PR-18, ADR-007), tracking (PR-19), borders (PR-20), incidents
(PR-21), operational finance (PR-22, ADR-033), reporting (PR-23), security
hardening (PR-24), the pilot-acceptance gate (PR-25), the Plesk/systemd pilot
deployment (OPS-1, see
[`docs/runbooks/pilot-deployment.md`](../runbooks/pilot-deployment.md)) and the
private ClamAV scanner stack (OPS-3A, see
[`docs/runbooks/private-document-scanner.md`](../runbooks/private-document-scanner.md)).

Still open:

- production provisioning of private object storage and the malware scanner;
- the choice and integration of a real payment provider, including
  provider-side refund execution;
- a data-driven catalogue of operational permit requirements;
- the content management system, public media and SEO configuration.

### PR-17 — departure readiness and dispatch

PR-17 composes current trip, vehicle, passenger, manifest and explicit permit-policy facts with the deterministic `departure-readiness/1` engine. Missing permit policy blocks readiness; a published empty policy is the only explicit zero-requirement state. A READY result is fingerprinted, explicit STAFF authorization binds that fingerprint, and actual departure revalidates it before `SCHEDULED -> IN_PROGRESS -> COMPLETED`. PostgreSQL owns actual clocks and append-only authorization/policy history. No real legal requirement is seeded; PR-18 still owns Crew offline/device behavior. See [departure-readiness.md](../domain/departure-readiness.md) and ADR-032.

### PR-22 — operational finance

PR-22 derives ticket revenue from existing SUCCEEDED payments, adds immutable
additional trip revenue and expenses, bounded refunds with matching credit
memos, expense payouts, private scanned receipts and CSV/XLSX operational
exports. Contribution is calculated per currency with no implicit FX. A
confirmed booking becomes cancellable only after full refund. This is not a
general ledger, statutory invoicing or FEC implementation. See
[finance.md](../domain/finance.md) and ADR-033.
