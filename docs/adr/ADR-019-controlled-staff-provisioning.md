# ADR-019 — Controlled STAFF provisioning

## Status

Accepted — 2026-10-12 (PR-03 Authorization, RBAC & Audit)

## Context

PR-02 left STAFF TOTP enrollment trust-on-first-use: whoever knew the
password of a STAFF identity without TOTP could register their own
authenticator. STAFF accounts must not be self-created, and the first factor
must be bound to an explicit administrative decision.

## Decision

- No public STAFF/CREW registration. STAFF accounts are created by
  **invitation** from an administrator holding `identity.staff.provision` and
  `role.assign`, with an initial role subject to anti-escalation.
- The invitation is a single-use random token (only its SHA-256 is stored),
  delivered as `OPS_PUBLIC_URL/invitation#token=…` (fragment: never sent to
  servers or in Referer). Accepting sets the password, activates the
  identity and issues a one-time **StaffEnrollmentGrant**.
- Login of a STAFF identity without TOTP requires a valid grant; otherwise
  it fails with the generic invalid-credentials answer (and is rate limited
  and logged as `AUTH_MFA_ENROLLMENT_BLOCKED`). Enrollment re-checks the
  grant and consumes it in the same transaction that enables TOTP.
- An expired grant can be re-issued by `mfa.enrollment.authorize`, never
  when TOTP is already enabled. Existing active accounts are never
  overwritten by an invitation.

## Consequences

- MFA_TOFU_CLOSED: knowing a STAFF password no longer allows choosing the
  first factor.
- Invitations depend on mail delivery (`AUTH_MAIL_PROVIDER=smtp` in
  production) and on `OPS_PUBLIC_URL` (HTTPS required in staging/production).
- Resetting an enabled TOTP still needs a supervised procedure (not in
  PR-03).

## Alternatives considered

- **Administrator sets the password** — the administrator would know it.
- **Administrator enrolls TOTP on behalf of the user** — the administrator
  would hold the secret.
- **Keep TOFU with operational rules** — not enforceable.
