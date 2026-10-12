# ADR-013 — Session authentication

## Status

Accepted — 2026-10-12 (PR-02 Identity & Authentication)

## Context

Browser applications on `client.`, `ops.` and `crew.euroteranga.com` call the
API on `api.euroteranga.com`. Requirements: revocation, visible sessions,
global invalidation after a password change or reset, realm separation, and no
authentication secret readable by JavaScript.

## Decision

- **Opaque server-side sessions**, not JWT. A session token is 32 bytes from
  the CSPRNG (base64url). The database stores only `SHA-256(token)` (unique
  index), never the token.
- The token travels only in an **HttpOnly cookie** set by the API:
  - staging/production: `__Host-et_<realm>_session`, `Secure`, `HttpOnly`,
    `SameSite=Strict`, `Path=/`, **no `Domain`** (host-only to the API host,
    never shared with other subdomains);
  - local/CI over plain HTTP: `et_<realm>_session` without `Secure`. The mode
    is derived from `APP_ENV` only; no variable can weaken production flags.
- Validity: not revoked, before the idle and absolute expiries, identity
  `ACTIVE`, identity realm equal to the route realm, and
  `session.auth_version == identity.auth_version`. Any database error fails
  closed (the request errors; it is never treated as authenticated).
- Lifetimes per realm (configurable): customer 30 days absolute / 7 days idle;
  staff 12 h / 60 min; crew 7 days / 24 h. The idle expiry slides, but
  `last_seen_at` is written at most every 5 minutes.
- `auth_version` on the identity is incremented on password change, password
  reset and "log out everywhere"; every older session becomes invalid at once.
- Password change: all sessions (including the current one) are revoked and a
  new session is issued to the caller in the same transaction.
- Logout revokes the session and expires the cookie; it is idempotent.
- Staff sign-in creates no session before the second factor (ADR-015).

## Consequences

- One indexed lookup (`token_hash`) per authenticated request, joined with
  three identity columns.
- Revocation is immediate and auditable (`revoked_at`, `revocation_reason`).
- Cookies require the API and the frontends to be same-site (subdomains of
  `euroteranga.com`); cross-site embedding is not supported.

## Alternatives considered

- **JWT (stateless)** — revocation requires a denylist, i.e. server state
  anyway; tokens in JavaScript-readable storage are exposed to XSS.
- **Session id in localStorage + Authorization header** — readable by any
  injected script.
- **Cookie on `.euroteranga.com`** — every subdomain (including future
  marketing or documentation sites) would receive the session.
