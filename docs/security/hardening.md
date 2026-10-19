# Security hardening (PR-24)

PR-24 closes the pre-pilot transport and retention gaps that were still
explicitly documented after authentication, RBAC, private uploads, payments and
operational reporting were implemented.

## Frontend Content Security Policy

All six Next.js frontends receive the same CSP from
`@euroteranga/config`.

The policy:

- defaults every resource type to `'self'`;
- allows scripts only from the application itself, plus the inline bootstrap
  currently required by Next.js;
- allows `unsafe-eval` only in the local development profile for HMR;
- restricts `connect-src` to the frontend origin and the exact configured Core
  API origin;
- blocks plugin/object content and all frames;
- prevents the application from being embedded with `frame-ancestors 'none'`;
- constrains `base-uri` and `form-action` to the application origin;
- allows only local/data/blob font and worker resources, and images from the
  application, `data:`/`blob:` and the exact Core API origin (MEDIA-1: the
  website images are served by the API). There is never a wildcard source;
- adds `upgrade-insecure-requests` in staging and production.

Staging/production browser builds reject an HTTP
`NEXT_PUBLIC_API_BASE_URL` or `NEXT_PUBLIC_CLIENT_URL`.

The CSP deliberately does **not** add HSTS. HSTS belongs on the TLS-terminating
reverse proxy and must only be enabled after every relevant subdomain is
HTTPS-only.

## Reverse proxy trust

The Core API ignores forwarded client addresses by default. PR-24 makes the
supported deployed topology explicit:

- local/CI may use `API_TRUST_PROXY=none` or `loopback`;
- staging/production must use `API_TRUST_PROXY=loopback`;
- the only trusted reverse proxy is therefore a loopback peer on the same host;
- a client cannot make the API trust an arbitrary
  `X-Forwarded-For` header when connecting directly.

The API should remain unreachable from the public network except through the
TLS reverse proxy/firewall rule.

## Request IDs before body parsing

The request-id middleware now runs before the 32 KiB JSON parser. Malformed or
oversized JSON therefore receives the same safe `X-Request-Id` correlation
header and request context as routed requests.

The parser still uses Nest's `rawBody` support, so payment webhook signature
verification continues to receive the exact request bytes.

## Temporary authentication retention

The operator command:

```bash
pnpm build
pnpm auth:purge-expired
```

deletes only temporary authentication artifacts beyond their documented
retention window:

- verification and reset tokens: 7 days after expiry;
- MFA challenges: 1 day after expiry;
- rate-limit buckets: after expiry;
- sessions: 90 days after idle/absolute expiry or revocation;
- staff invitations: 7 days after expiry;
- staff MFA enrollment grants: 7 days after expiry.

The purge is transactional and idempotent. Its output contains only counts and
the purge timestamp. It does not delete identities, MFA credentials, audit
events or security events.

Production deployment should schedule the command daily.

## Verification

PR-24 includes:

- configuration unit coverage for deployed HTTPS, proxy trust and CSP
  directives;
- authentication integration coverage proving malformed JSON still receives a
  request id and never logs the raw secret-bearing body;
- isolated PostgreSQL coverage proving expired artifacts are deleted, fresh
  artifacts remain, and a second purge is a no-op;
- the existing full lint, typecheck, PostgreSQL, build, security and browser
  gates.
