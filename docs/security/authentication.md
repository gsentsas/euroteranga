# Authentication

Identity and authentication for EURO TERANGA (PR-02). Authorization (roles,
permissions, audit, STAFF provisioning) is described in
[authorization.md](authorization.md) (PR-03). Decisions are recorded in
ADR-012 to ADR-016. This document contains no secret value.

## Realms

| Realm    | Who                  | Self-registration | Second factor     | Session (absolute / idle) | Cookie (production)          |
| -------- | -------------------- | ----------------- | ----------------- | ------------------------- | ---------------------------- |
| CUSTOMER | Customers            | Yes               | No (not yet)      | 30 days / 7 days          | `__Host-et_customer_session` |
| STAFF    | Back-office staff    | No (provisioned)  | **TOTP required** | 12 h / 60 min             | `__Host-et_staff_session`    |
| CREW     | Drivers and on-board | No (provisioned)  | No (decision)     | 7 days / 24 h             | `__Host-et_crew_session`     |

A realm is an authentication space, not a role. The same email can exist in
several realms as unrelated identities (`UNIQUE(realm, normalized_email)`).
Sessions, cookies, allowed origins and lifetimes are separate per realm and
checked server-side.

**Email normalisation**: trim, Unicode NFC, lowercase. No provider-specific
rewriting (Gmail dots and `+tags` are kept).

## Endpoints

| Method | Path                                    | Session | CSRF | Notes                                                    |
| ------ | --------------------------------------- | ------- | ---- | -------------------------------------------------------- |
| POST   | `/v1/auth/customer/register`            | —       | —    | 202, generic response                                    |
| POST   | `/v1/auth/customer/verify-email`        | —       | —    | token + registration password                            |
| POST   | `/v1/auth/customer/resend-verification` | —       | —    | 202, generic response                                    |
| POST   | `/v1/auth/customer/password/forgot`     | —       | —    | 202, generic response                                    |
| POST   | `/v1/auth/customer/password/reset`      | —       | —    | revokes every session; no auto-login                     |
| POST   | `/v1/auth/{realm}/login`                | —       | —    | staff → challenge cookie, never a session                |
| GET    | `/v1/auth/{realm}/me`                   | yes     | —    | id, realm, email, emailVerified                          |
| GET    | `/v1/auth/{realm}/session`              | yes     | —    | createdAt, idle/absolute expiry                          |
| GET    | `/v1/auth/{realm}/csrf`                 | yes     | —    | session-bound token                                      |
| POST   | `/v1/auth/{realm}/logout`               | opt.    | yes  | idempotent                                               |
| POST   | `/v1/auth/{realm}/sessions/revoke-all`  | yes     | yes  | own sessions only                                        |
| POST   | `/v1/auth/{realm}/password/change`      | yes     | yes  | rotates the session                                      |
| POST   | `/v1/auth/staff/mfa/enrollment/start`   | —       | —    | requires the enrollment challenge cookie                 |
| POST   | `/v1/auth/staff/mfa/enrollment/confirm` | —       | —    | enables TOTP, returns recovery codes once, opens session |
| POST   | `/v1/auth/staff/mfa/verify`             | —       | —    | TOTP or recovery code on the login challenge             |

All `/v1/auth` responses carry `Cache-Control: no-store`. POST bodies must be
JSON. The OpenAPI document marks passwords, tokens and codes as write-only.

## Passwords

- Argon2id, 64 MiB, t=3, p=1 (PHC string; ~90 ms on the target host class).
- Policy: ≥ 15 characters (code points), ≤ 256, passphrases and Unicode
  welcome, no composition rules, no rotation. Refused: known long common
  passwords, keyboard/alphabet runs, repetitive strings, `euroteranga`, the
  user's email or its local part.
- Unknown accounts still cost one Argon2 verification (dummy hash).

## Registration and email verification

1. `register` always answers 202 with the same message. New address → identity
   `PENDING_VERIFICATION` + verification token (24 h). Pending address → a new
   token supersedes the previous one. Active address → a private "account
   exists" notice. Suspended/disabled → nothing.
2. The token (256 bits, CSPRNG) is mailed as
   `<CLIENT_PUBLIC_URL>/verification-email#token=…` — in the URL **fragment**,
   never sent to servers or Referer headers. Only `SHA-256(token)` is stored.
3. `verify-email` requires the token **and** the registration password; the
   token is consumed and the identity activated in one transaction. Concurrent
   submissions: exactly one succeeds.
4. At most one usable token per identity (partial unique index).

## Password reset

- `forgot` answers 202 identically for any address; only ACTIVE customers get
  a link (`#token=…`, 30 min, single use, hash stored). A new request
  supersedes the previous link.
- `reset` checks the policy before consuming the token, then in one
  transaction: consume token, replace password, increment `auth_version`,
  revoke every session. The user signs in again; a notice mail is sent.
- STAFF and CREW have no public reset flow (administrative process; not
  implemented yet).

## Sessions

- 256-bit opaque token in an HttpOnly cookie; database stores
  `SHA-256(token)` only.
- Production cookie: `__Host-` prefix, `Secure`, `HttpOnly`,
  `SameSite=Strict`, `Path=/`, no `Domain` (host-only to the API host). The
  flags depend on `APP_ENV` only.
- Valid when: not revoked, within idle and absolute expiry, identity ACTIVE and
  of the route's realm, `auth_version` unchanged. Database errors fail closed.
- `last_seen_at` / idle expiry refreshed at most every 5 minutes.
- Password change revokes all sessions and issues a new one to the caller.

## Staff MFA

- Password correct → `MFA_REQUIRED` (TOTP enabled) or, only with a valid
  enrollment grant, `MFA_ENROLLMENT_REQUIRED` + challenge cookie (5 min,
  single use, 5 attempts). No session yet. Without TOTP and without a grant,
  the answer is the generic 401 (see [authorization.md](authorization.md)).
- TOTP RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step); replay blocked by the stored
  last accepted step.
- Secret: 160 bits, AES-256-GCM encrypted (`AUTH_TOTP_ENCRYPTION_KEY`, identity
  id as AAD).
- 10 recovery codes (80 bits each) shown once, stored as SHA-256, single use;
  each use is logged.
- UI messages stay generic: "Code invalide ou expiré."

## CSRF and origins

- CORS with credentials for exact origins only; `*` refused at startup.
- `Origin` (when present) must belong to the route's realm.
- Authenticated mutations require `X-CSRF-Token`:
  `v1.<exp>.<nonce>.HMAC-SHA256(AUTH_CSRF_KEY, csrf|v1|sessionId|exp|nonce)`,
  2 h, bound to the session, compared in constant time; kept in memory only.

### Booking and Client (PR-09)

The Booking app and Client account app are two exact CUSTOMER origins
(`http://localhost:3001` and `http://localhost:3002` locally/CI). Both use the
same existing CUSTOMER realm and HttpOnly session cookie. There is no booking
token and no new authentication mechanism.

Public search and availability need no session. Hold creation/list/detail/
cancellation require the CUSTOMER session; the two mutations additionally
fetch a session-bound CSRF token immediately before the request. Customer
identity is taken only from that session. The Booking sign-in component keeps
the in-progress trip/seat selection in React memory and never writes a token
or selection to localStorage, sessionStorage, IndexedDB or a URL.

### Payments (PR-10)

- **CUSTOMER payment actions** use the same CUSTOMER session and session-bound
  CSRF token: starting an attempt, and cancelling an attempt. Starting an
  attempt may also send an `Idempotency-Key` header, which CORS now allows
  next to `Content-Type`, `X-CSRF-Token` and `X-Request-Id`. The key is a
  random value kept in page memory for one payment intent: neither a secret nor
  a credential, never written to web storage or a URL.
- **The provider webhook** (`POST /v1/payments/webhooks/sandbox`) is the only
  route without a session or CSRF token. It is server-to-server and
  authenticated by an HMAC-SHA256 signature of the provider over the raw body,
  compared in constant time, with a timestamp within ±300 s and an 8 KiB
  limit. Replays are refused by the unique provider event id. For this, the API
  keeps the raw bytes of JSON bodies (`rawBody`). A CUSTOMER cookie or CSRF
  token is never a substitute for the signature.
- **Payment trust boundary:** an isolated `UPDATE` of `Payment` cannot mark it
  paid; the transactional pipeline requires `PaymentEvent` plus booking
  confirmation. Provider authenticity is verified at the webhook boundary by
  the API. PostgreSQL enforces structural and transactional invariants, but it
  does not cryptographically authenticate the PSP; full SQL access to these
  tables is in the trusted computing base.
- **Oversized bodies:** a body above the global 32 KiB JSON limit is answered
  `413 PAYLOAD_TOO_LARGE`; it used to surface as an internal error.

## Rate limiting

PostgreSQL fixed windows (`auth_rate_limit_bucket`), keyed by
`HMAC(AUTH_HMAC_KEY, action, signal)` — no raw email or IP stored. Defined in
`apps/api/src/auth/rate-limit/rate-limit.rules.ts`.

| Action                 | Limit                        | Key                                        |
| ---------------------- | ---------------------------- | ------------------------------------------ |
| Login failures         | 5 / 15 min                   | realm + email                              |
| Login attempts         | 30 / 15 min                  | client address                             |
| Registration           | 10 / hour (+5/h per email)   | client address                             |
| Reset requests         | 5 / hour (+20/h per address) | email                                      |
| Verification resend    | 5 / hour (+20/h per address) | email                                      |
| Token submissions      | 30 / 15 min                  | client address                             |
| MFA verification       | 30 / 15 min                  | client address (+5 attempts per challenge) |
| Wrong current password | 5 / 15 min                   | identity                                   |

Responses: 429 `TOO_MANY_REQUESTS` with `Retry-After`, identical whether the
account exists. No permanent lockout. The client address is the TCP peer
unless `API_TRUST_PROXY=loopback`. PR-24 requires that exact loopback-proxy
topology in staging and production; deployed instances fail startup when proxy
trust is left disabled. Client-supplied forwarding headers are ignored unless
the TCP peer is the trusted loopback reverse proxy.

## Security logging

Structured events (`security_event`): `AUTH_LOGIN_SUCCESS`,
`AUTH_LOGIN_FAILURE`, `AUTH_LOGOUT`, `AUTH_PASSWORD_CHANGED`,
`AUTH_PASSWORD_RESET`, `AUTH_PASSWORD_RESET_REQUESTED`,
`AUTH_REGISTRATION_REQUESTED`, `AUTH_EMAIL_VERIFIED`,
`AUTH_EMAIL_VERIFICATION_FAILED`, `AUTH_MFA_CHALLENGE_ISSUED`,
`AUTH_MFA_ENROLLED`, `AUTH_MFA_SUCCESS`, `AUTH_MFA_FAILURE`,
`AUTH_MFA_RECOVERY_CODE_USED`, `AUTH_SESSION_REVOKED`, `AUTH_RATE_LIMITED`,
`AUTH_MAIL_DELIVERY_FAILED`.

Emails and IPs appear only as keyed pseudonyms (`subject_ref`, `ip_ref`).
Never logged: passwords, tokens, TOTP codes or secrets, recovery codes,
cookies, `Authorization` headers (the logger also redacts these by key and
pattern).

## Mail

`AuthMailProvider` (SMTP via nodemailer, or `disabled` locally/CI; production
requires SMTP with TLS). Delivery is asynchronous: response timing and status
never depend on whether a mail is sent, and an SMTP outage never rolls back the
database. A lost mail is recoverable by the user (resend verification, request
a new reset link); failures are logged without content. No outbox in PR-02:
the recovery path above is the documented strategy.

## Secrets

| Variable                         | Purpose                              | Format                                                   |
| -------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `AUTH_CSRF_KEY`                  | CSRF token MAC                       | base64, ≥ 32 bytes                                       |
| `AUTH_HMAC_KEY`                  | rate-limit keys, log pseudonyms      | base64, ≥ 32 bytes                                       |
| `AUTH_TOTP_ENCRYPTION_KEY`       | TOTP secret encryption (AES-256-GCM) | base64, exactly 32 bytes                                 |
| `SMTP_PASSWORD`                  | SMTP authentication                  | optional                                                 |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | SANDBOX webhook HMAC (PR-10)         | base64, ≥ 32 bytes; only with `PAYMENT_PROVIDER=SANDBOX` |

Startup fails if a key is missing, badly encoded, too short, reused for two
purposes, or — in staging/production — equal to the public example value.
`PAYMENT_PROVIDER=SANDBOX` itself is refused in staging and production, so the
published development value of the SANDBOX webhook key can never protect a
deployed environment.
Generate with `openssl rand -base64 32`. Rotation impact: see
[`docs/runbooks/authentication-incident.md`](../runbooks/authentication-incident.md).

## Retention of temporary authentication data

PR-24 implements an idempotent operator purge:

```bash
pnpm build
pnpm auth:purge-expired
```

It uses one retention snapshot and deletes only temporary authentication
artifacts. Security/audit events and durable identity/MFA credentials are not
deleted by this command.

| Data                              | Retention after expiry/revocation | Indexed time field |
| --------------------------------- | -------------------------------- | ------------------ |
| Verification / reset tokens       | 7 days                           | `expires_at`       |
| MFA challenges                    | 1 day                            | `expires_at`       |
| Rate-limit buckets                | immediately after expiry         | `expires_at`       |
| Revoked / expired sessions        | 90 days                          | session expiry/revocation fields |
| Staff invitations                 | 7 days                           | `expires_at`       |
| Staff MFA enrollment grants       | 7 days                           | `expires_at`       |

Production should schedule the CLI daily in the platform scheduler. Running it
again with the same database state is a no-op.

## Known limitations

- ~~Staff TOTP enrollment is trust-on-first-use~~ — **closed in PR-03**: a
  STAFF identity without TOTP can enroll only with a one-time enrollment
  grant issued by an accepted invitation, the bootstrap CLI or an
  administrator holding `mfa.enrollment.authorize` (ADR-019). Without a
  grant, login answers the generic 401 and logs
  `AUTH_MFA_ENROLLMENT_BLOCKED`.
- Suspension and session revocation are available in OPS (PR-03); an
  administrative reset of an **enabled** TOTP is not.
- Requests rejected by the JSON body parser (malformed JSON) carry no request
  id: the parser runs before the request-id middleware.
- The "forgot password" path for an existing account performs a few database
  writes that an unknown address does not; mail is asynchronous and rate
  limits apply, but timing is not strictly constant.
- TOTP key rotation tooling not implemented.
- The purge CLI exists, but the production scheduler still has to invoke it; no customer MFA or passkeys yet.
- Not deployed; production TLS and cookie behaviour behind the real proxy not
  validated.
