# ADR-018 — Privileged audit trail

## Status

Accepted — 2026-10-12 (PR-03 Authorization, RBAC & Audit)

## Context

Role changes, suspensions, session revocations and STAFF provisioning must be
attributable and tamper-evident. Security logs (PR-02) are operational. They
are not a durable, queryable record tied to the change itself.

## Decision

- `audit_event` table, **append-only**: database triggers reject `UPDATE`,
  `DELETE` and `TRUNCATE`. Referenced actors cannot be deleted
  (`ON DELETE RESTRICT`).
- `AuditService.record(input, tx)` requires the transaction of the change:
  no privileged mutation commits without its audit event, and no audit event
  survives a rolled-back change.
- Each event stores actor id and realm (null actor for CLI/system events),
  action, resource type and id, before/after, reason, metadata and the
  request id (AsyncLocalStorage). JSON fields go through the log redaction:
  no token, password, TOTP secret or recovery code.
- Read access with `audit.read` through a paginated admin endpoint.

## Consequences

- Audit rows can only be removed by a superuser operation outside the
  application, which is itself visible at the database level.
- Retention and archiving policy remain to be defined (personal data in
  emails of actors); no purge exists.

## Alternatives considered

- **Logs only** — not transactional, not reliably queryable, may be sampled.
- **Separate audit database or external service** — loses atomicity with the
  change; reconsider for long-term archiving.
