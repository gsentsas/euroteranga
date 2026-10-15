# ADR-030 — Immutable trip passenger manifests

- Status: Accepted
- Date: 2026-10-15 (PR-15 Manifests)

## Context

Operations need a reproducible list of the passengers checked in for one
concrete trip. Reading live booking, passenger and boarding tables whenever a
list is requested would silently rewrite history: a later boarding, profile
correction or seat change could alter what operators believe was exported.

A manifest also carries operational PII. Copying every related record would
leak payment, document, compliance and QR secrets, while treating the list as
a departure decision would overlap the future permits and trip-readiness
domains.

## Decision

1. **The subject is a Trip.** A version contains only `BookingPassenger` rows
   of that trip that already have a `PassengerCheckIn`. Boarding is an
   optional fact in each passenger entry.
2. **Every explicit generation appends a version.** Versions start at 1 and
   are contiguous per trip. PostgreSQL locks the trip row, checks that it is
   still `SCHEDULED`, verifies an ACTIVE STAFF generator and rejects update,
   delete and truncate.
3. **The stored snapshot is canonical and minimized.** It contains the trip
   times and vehicle identity plus passenger name, date of birth, nationality,
   journey endpoints, seat, check-in and optional boarding. It contains no
   customer email, payment, baggage, passenger-document reference/number/file,
   compliance evidence/reason, readiness data, QR credential, device id,
   client event id or actor identity.
4. **Integrity is explicit.** `passenger-manifest/1` is serialized as canonical
   JSON and fingerprinted with SHA-256. The snapshot, schema version and hash
   are stored together.
5. **Exports are projections of history.** CSV is rendered on demand only from
   the stored JSON snapshot. It is RFC 4180 UTF-8, neutralizes spreadsheet
   formulas and is served privately with no public file URL.
6. **Access is least privilege and audited.** Only SUPER_ADMIN, DIRECTOR,
   OPS_MANAGER and DISPATCHER receive `manifest.read`, `manifest.generate` and
   `manifest.export`. History reads, detail reads, generations and exports are
   audit events without passenger PII in metadata.

An empty checked-in set is a valid historical fact and produces a version
with zero passengers. A later explicit generation is still a new version,
even when its content hash is identical.

## Consequences

Positive:

- an old version and its CSV never change when live operational facts change;
- concurrency cannot create duplicate or skipped versions;
- consumers can verify content deterministically with the stored SHA-256;
- the snapshot exposes only the PII needed by manifest operators.

Trade-offs:

- names and dates of birth are intentionally duplicated as historical PII and
  therefore require strict retention/access controls;
- every generation stores another JSON snapshot, including an unchanged one;
- JSONB does not preserve key order, so verification must use canonical JSON,
  not raw database text.

## Boundary

A passenger manifest is not:

- trip readiness or dispatch authorization (PR-17);
- regulatory clearance or a border permit (PR-16);
- passenger-document validation or a compliance decision (PR-11/PR-12);
- an offline Crew payload, device queue or synchronization protocol (PR-18).

It records operational facts; it never grants permission to travel or depart.

## Alternatives considered

- **Live SQL view:** rejected because historical versions and reproducible
  exports would change with live data.
- **Mutable “current manifest”:** rejected because it erases who saw/exported
  which facts and makes concurrency ambiguous.
- **One idempotent version per content hash:** rejected because each explicit
  operator action must remain a separate audited historical generation.
- **PDF or stored CSV objects:** rejected. Presentation files introduce object
  retention and public-link risks; PR-15 keeps one canonical database fact and
  renders CSV privately on demand.
- **Readiness/approval status on a manifest:** rejected as a responsibility of
  the permits and trip-readiness roadmap items.
