# ADR-022 — Vehicle lifecycle and retirement

## Status

Accepted — 2026-10-13 (PR-05 Fleet)

## Context

Later domains depend on the vehicle registry: trips, seat maps, maintenance,
documents and tracking. They need to know whether a vehicle may be used, and
they need old references to stay valid. Deleting vehicles would break the
audit trail and future trip history. Free-form status edits would allow
impossible histories, such as a retired vehicle returning to service.

Vehicle identifiers also vary: plate formats differ per country, and a VIN
can be checked for shape but not verified without external sources.

## Decision

- A `Vehicle` has an explicit status: `PLANNED`, `ACTIVE`, `OUT_OF_SERVICE`
  or `RETIRED`. It is created as `PLANNED`.
- Allowed transitions: `PLANNED → ACTIVE | RETIRED`,
  `ACTIVE → OUT_OF_SERVICE | RETIRED`, `OUT_OF_SERVICE → ACTIVE | RETIRED`.
  `RETIRED` is terminal and freezes the row.
- The status changes only through a dedicated operation that requires a
  reason. It locks the row, re-reads and validates, updates, and writes the
  audit event in one transaction. An optional `expectedStatus` turns a
  decision made on a stale state into a conflict.
- PostgreSQL enforces the same lifecycle with a trigger, plus a CHECK tying
  `retired_at` to `RETIRED`. No writer can bypass it: not the service, not
  Prisma, not raw SQL. `DELETE` and `TRUNCATE` are refused. Retirement
  replaces deletion.
- Identification: a unique normalized internal `code`. The VIN is optional,
  unique and shape-checked only (17 characters, no I/O/Q). The plate is free
  format per country, unique together with its country, and the two are set
  together.

## Consequences

- Vehicle history is append-only in practice: a mistake in a retired
  vehicle's data cannot be corrected in place (by design). Retire carefully;
  the UI warns that it is final.
- Later domains can rely on `status` and on the existence of every vehicle
  ever referenced.
- `OUT_OF_SERVICE` is deliberately generic. Maintenance records, inspection
  validity and document expiry will be separate models that may drive this
  status later. They do not live on `Vehicle`.
- Plates are not validated per country; per-country rules can be added when
  verified sources exist.

## Alternatives considered

- **Soft-delete flag** — less explicit than a lifecycle, and it does not
  distinguish temporary unavailability from final retirement.
- **Status as free text or unconstrained enum** — allows impossible
  transitions; history would need repair.
- **Application-only enforcement** — scripts, data fixes or future services
  writing directly could break the lifecycle.
- **Global plate regex** — wrong for many countries, and misleading.
