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
unless `API_TRUST_PROXY=loopback`; the production proxy chain is not audited
yet.

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

| Variable                   | Purpose                              | Format                   |
| -------------------------- | ------------------------------------ | ------------------------ |
| `AUTH_CSRF_KEY`            | CSRF token MAC                       | base64, ≥ 32 bytes       |
| `AUTH_HMAC_KEY`            | rate-limit keys, log pseudonyms      | base64, ≥ 32 bytes       |
| `AUTH_TOTP_ENCRYPTION_KEY` | TOTP secret encryption (AES-256-GCM) | base64, exactly 32 bytes |
| `SMTP_PASSWORD`            | SMTP authentication                  | optional                 |

Startup fails if a key is missing, badly encoded, too short, reused for two
purposes, or — in staging/production — equal to the public example value.
Generate with `openssl rand -base64 32`. Rotation impact: see
[`docs/runbooks/authentication-incident.md`](../runbooks/authentication-incident.md).

## Retention of temporary data (purge not implemented yet)

| Data                        | Proposed retention          | Index for purge       |
| --------------------------- | --------------------------- | --------------------- |
| Verification / reset tokens | delete 7 days after expiry  | `expires_at`          |
| Challenges                  | delete 1 day after expiry   | `expires_at`          |
| Rate-limit buckets          | delete after `expires_at`   | `expires_at`          |
| Revoked / expired sessions  | delete 90 days after expiry | `absolute_expires_at` |

A scheduled purge job will be added with the worker infrastructure.

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
- Production proxy chain and real client IP not verified.
- No purge job yet; no customer MFA; no passkeys.
- Not deployed; production TLS and cookie behaviour behind the real proxy not
  validated.
