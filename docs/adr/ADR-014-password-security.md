# ADR-014 — Password security

## Status

Accepted — 2026-10-12 (PR-02 Identity & Authentication)

## Context

Passwords are the first factor for every realm. They must resist offline
cracking if the database leaks, and users must be able to use long
passphrases and password managers.

## Decision

- **Argon2id** via `@node-rs/argon2` 2.2.1 (MIT, prebuilt binaries, no install
  script). Parameters: memory 64 MiB, time cost 3, parallelism 1, 32-byte
  output, 16-byte random salt — all encoded in the PHC string, so they can be
  raised later without invalidating existing hashes.
- Benchmark on the target host class (shared, 12 vCPU, load ≈1): hash ≈91 ms,
  verify ≈92 ms (median of 7). The OWASP minimum (19 MiB, t=2, p=1) takes
  ≈18 ms there; the chosen setting is ~5× costlier for an attacker.
  Parallelism 1 keeps memory predictable under concurrency (libuv pool of 4 ⇒
  at most ~256 MiB of hashing memory at once).
- Input is normalised with Unicode **NFKC** before hashing.
- Policy (NIST SP 800-63B, OWASP): at least **15** characters (Unicode code
  points), at most 256; spaces, Unicode and symbols allowed; **no composition
  rules**, no periodic rotation. Refused locally: known long common passwords,
  keyboard/alphabet runs, highly repetitive strings, the service name
  (`euroteranga`) and the user's email or its local part. Messages explain
  what to change. No password is sent to any external service.
- Login timing: when the account or credential does not exist, a verification
  against a dummy Argon2id hash is still performed (tested: the unknown-email
  path is not trivially faster).
- Login responses are identical for unknown email, wrong password, pending,
  suspended and disabled accounts (`INVALID_CREDENTIALS`). Rate limits apply
  (ADR-016, docs/security/authentication.md); there is no permanent lockout.

## Consequences

- ~90 ms of CPU per login/registration/verification; acceptable for the
  expected volume and bounded by rate limits.
- `@node-rs/argon2` exposes `Algorithm` as a TypeScript const enum without a
  runtime value; the code uses the documented numeric value `2` (Argon2id).
- A compromised-password API (k-anonymity) could be added later; it requires
  its own ADR before adoption.

## Alternatives considered

- **`node:crypto.argon2`** (Node 24) — no dependency, but recent API and no
  PHC encoding/parsing: we would have to write and maintain it.
- **`argon2` (node-gyp)** — mature, but runs native build scripts at install.
- **bcrypt / PBKDF2 / scrypt** — weaker against GPU/ASIC attacks or with
  input-length limits (bcrypt truncates at 72 bytes).
