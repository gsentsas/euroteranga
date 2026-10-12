# ADR-017 — Server-side RBAC

## Status

Accepted — 2026-10-12 (PR-03 Authorization, RBAC & Audit)

## Context

PR-02 authenticates three realms but every authenticated STAFF identity could
reach anything a STAFF route exposed. The back-office will host bookings,
dispatch, finance and compliance; access must follow job roles and be
revocable at once.

## Decision

- Role-based access control evaluated **only by the Core API**, from the
  database, on every request. The OPS frontend displays according to
  `GET /v1/admin/access/me` but is never trusted.
- Fixed permission keys and roles seeded by migration. Roles carry a realm
  (STAFF/CREW) and a `privileged` flag. No wildcard permission. The database
  catalogue is the single source of truth.
- `AuthorizationGuard` is deny-by-default and merges class and method
  requirements. `ops.access` is required by the whole admin surface.
- Anti-escalation (an actor can only grant/revoke roles whose permissions it
  holds). `privileged.manage` is required for privileged roles and their
  holders. No self-modification. The last usable privileged admin is
  protected. Privileged changes are serialized with a transaction-scoped
  advisory lock.
- Realm consistency enforced twice: service check and database trigger.

## Consequences

- One extra indexed query per admin request; acceptable for back-office
  volume, and revocation takes effect immediately.
- Adding a permission or role requires a migration and a review.
- Business modules declare permissions per route with `@RequirePermissions`.

## Alternatives considered

- **Permissions embedded in the session** — stale until the session ends; a
  revoked role would keep working.
- **Frontend-only gating (Refine access control)** — not a protection.
- **ABAC / policy engine** — premature; the role model covers current needs
  and remains compatible with resource-level checks later.
