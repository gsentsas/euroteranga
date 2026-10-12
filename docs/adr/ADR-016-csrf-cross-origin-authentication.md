# ADR-016 — CSRF and cross-origin authentication

## Status

Accepted — 2026-10-12 (PR-02 Identity & Authentication)

## Context

Frontends and API live on different subdomains; the browser sends the
session cookie with credentialed requests. Cookie-authenticated mutations are
exposed to cross-site request forgery, and one realm's frontend must not be
able to drive another realm.

## Decision

- **CORS**: credentials allowed (`Access-Control-Allow-Credentials: true`)
  only for an explicit list of exact origins (union of
  `AUTH_CUSTOMER_ORIGINS`, `AUTH_STAFF_ORIGINS`, `AUTH_CREW_ORIGINS`,
  `API_CORS_ORIGINS`). `*` is rejected by configuration validation.
- **Origin per realm**: on every `/v1/auth/*` route, when an `Origin` header
  is present it must belong to that realm's list (403 `ORIGIN_NOT_ALLOWED`);
  a customer page cannot call the staff realm even with valid CORS.
- **JSON only**: POST bodies must be `application/json` (415 otherwise), which
  forces a CORS preflight for any cross-origin caller and rules out
  HTML-form CSRF.
- **CSRF tokens** for authenticated mutations (logout, revoke-all, password
  change, future MFA settings): `GET /v1/auth/{realm}/csrf` returns
  `v1.<exp>.<nonce>.<mac>` with
  `mac = HMAC-SHA256(AUTH_CSRF_KEY, "csrf"|"v1"|sessionId|exp|nonce)`, valid
  2 hours. The client keeps it in memory and sends `X-CSRF-Token`. The session
  id comes from the HttpOnly cookie server-side, so a token works only for its
  own session; comparison is constant-time. `SameSite=Strict` is defence in
  depth, not the only protection.
- **Proxy trust**: `X-Forwarded-For` is ignored unless `API_TRUST_PROXY`
  allows it (`none` by default, `loopback` available). The production proxy
  chain is not audited yet.

## Consequences

- Clients fetch a CSRF token before each authenticated mutation (one extra
  GET); `@euroteranga/auth-client` does it transparently.
- Rotating `AUTH_CSRF_KEY` invalidates outstanding CSRF tokens (not sessions).
- Requests without an `Origin` header (non-browser clients) are accepted on
  auth routes; they cannot carry a victim's cookies cross-site.

## Alternatives considered

- **SameSite only** — not sufficient on its own (same-site subdomains,
  browser exceptions, future requirements).
- **Stateful synchronizer tokens in the database** — an extra write per
  token for no security gain over a session-bound MAC.
- **Double-submit cookie without MAC** — weaker if a sibling subdomain can
  set cookies.
