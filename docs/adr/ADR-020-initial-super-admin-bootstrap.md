# ADR-020 — Initial SUPER_ADMIN bootstrap

## Status

Accepted — 2026-10-12 (PR-03 Authorization, RBAC & Audit)

## Context

Invitations need an administrator, so the first one must come from outside
the HTTP API. A bootstrap endpoint would be a permanent attack surface, and
a seeded default account a shared secret.

## Decision

- **CLI only**: `pnpm auth:bootstrap-super-admin -- --email <address>
--delivery mail|print`, run by an operator with database access. There is
  no HTTP bootstrap endpoint and no default account.
- Refused when a usable SUPER_ADMIN (ACTIVE, TOTP enabled) exists. It is also
  refused while an unfinished bootstrap exists for another address, or when
  the identity is suspended or disabled.
- For a new address: PENDING STAFF identity + `SUPER_ADMIN` + invitation.
  Rerunning for the same pending address regenerates the invitation; the
  previous link stops working. An existing ACTIVE STAFF identity gets the
  role (and an enrollment grant if it has no TOTP). No password and no
  session are ever created.
- `--delivery mail` uses the configured SMTP provider. `--delivery print`
  writes the link once to stdout, for a secured terminal, with warnings on
  stderr. The token is never logged or stored in clear.
- One transaction, under the privileged-change lock, with a
  `SUPER_ADMIN_BOOTSTRAPPED` audit event (no actor, source `bootstrap-cli`).
- Exit codes of the script: 0 success, 2 refused, 1 error (a pnpm wrapper
  reports every failure as 1; the refusal reason is printed on stderr).

## Consequences

- Recovery after losing every privileged administrator is possible only
  through this CLI. It works once no usable SUPER_ADMIN remains, and requires
  server access.
- The procedure is documented in `docs/runbooks/bootstrap-super-admin.md`.

## Alternatives considered

- **Bootstrap endpoint protected by a static token** — a long-lived secret
  and an exposed route.
- **Migration-seeded admin** — credentials in the repository or the
  deployment pipeline.
