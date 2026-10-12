# ADR-015 — Staff multi-factor authentication

## Status

Accepted — 2026-10-12 (PR-02 Identity & Authentication)

## Context

Staff accounts will carry the highest privileges (operations, compliance,
finance). Roles do not exist yet (PR-03), so the MFA policy cannot depend on
them.

## Decision

- **Every STAFF identity must pass a second factor**; a correct password alone
  never yields a STAFF session.
- Factor: **TOTP** (RFC 6238; SHA-1, 6 digits, 30 s), compatible with standard
  authenticator apps, via `otpauth` 9.5.2 (MIT). Accepted window: current step
  ±1 (±30 s drift).
- **Replay protection**: the highest accepted time step is stored per
  credential (`last_accepted_step`) and only moves forward through a
  conditional update; a code, or any code of an earlier step, is accepted at
  most once, even under concurrency.
- **Secret storage**: the TOTP secret (160 bits) must be recoverable, so it is
  encrypted — not hashed — with **AES-256-GCM** (random 96-bit nonce, 128-bit
  tag, identity id as additional authenticated data). Key:
  `AUTH_TOTP_ENCRYPTION_KEY` (32 bytes) outside the database, with a stored
  `key_version`.
- **Challenge**: after a correct password the API sets a short-lived HttpOnly
  challenge cookie (`__Host-et_staff_mfa` in production) for an
  `auth_challenge` row: single use, 5-minute TTL, at most 5 attempts (counted
  atomically); afterwards the challenge is unusable.
- First login without TOTP → `MFA_ENROLLMENT_REQUIRED`: the enrollment
  challenge allows generating a secret (otpauth URI + base32 key), confirming a
  first code, then the API enables TOTP, issues **10 recovery codes** (80 bits
  each, shown once, stored as SHA-256, single use) and creates the session.
- Later logins → `MFA_REQUIRED` → TOTP or one recovery code → session.
- CREW: MFA not required in PR-02 (shared devices on board, constrained
  connectivity); the model supports enabling it later. CUSTOMER: no MFA yet.

## Consequences

- First-login enrollment is trust-on-first-use: the password alone allows
  enrolling a new authenticator for a STAFF identity that has none yet.
  Administrator-initiated enrollment (PR-03) will close this gap.

- Losing the phone and all recovery codes requires an administrative MFA
  reset, which belongs to PR-03 or a dedicated security mission.
- Key rotation for `AUTH_TOTP_ENCRYPTION_KEY` is not implemented yet: only the
  current `key_version` can decrypt. Rotation needs re-encryption tooling.

## Alternatives considered

- **SMS OTP** — SIM-swap and interception risks, cost, coverage on the
  corridor.
- **WebAuthn / passkeys** — stronger; planned later, the challenge model
  accommodates additional factors.
- **Email codes** — the mailbox is often the weakest link of the account.
