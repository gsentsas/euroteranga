# Authorization, RBAC and audit

Authorization for EURO TERANGA (PR-03). It builds on the authentication of
PR-02 ([authentication.md](authentication.md)). Decisions are recorded in
ADR-017 to ADR-020. This document contains no secret value.

> **An authenticated STAFF session is not an authorized administrator.** A
> correct password is never enough to choose a first TOTP factor. A hidden
> button is not an authorization. No privileged change happens without a
> transactional audit event.

## Model

- **Permissions** are fixed keys (`ops.access`, `identity.read`, …) seeded by
  migration. There is no wildcard and no implicit permission.
- **Roles** belong to one realm (STAFF or CREW) and carry a `privileged`
  flag. Only STAFF roles may be privileged (database CHECK).
- **Role assignments** link an identity to a role, with who/when/why for the
  grant and for the revocation. A database trigger refuses an assignment
  whose role realm differs from the identity realm. A partial unique index
  allows only one active assignment per (identity, role).
- The database catalogue is the **single source of truth**. The code holds
  the permission keys as constants but no role→permission mapping.

### Permission catalogue

| Permission                 | Allows                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `ops.access`               | Using the OPS back-office at all (required by every route) |
| `identity.read`            | Listing STAFF/CREW identities and their access             |
| `identity.status.manage`   | Suspending, reactivating, disabling an identity            |
| `session.revoke.any`       | Closing every session of another identity                  |
| `role.read`                | Reading the role catalogue                                 |
| `role.assign`              | Granting and revoking roles (subject to anti-escalation)   |
| `identity.staff.provision` | Inviting STAFF members                                     |
| `mfa.enrollment.authorize` | Authorizing a first TOTP enrollment again                  |
| `audit.read`               | Reading the audit trail                                    |
| `privileged.manage`        | Acting on privileged roles and on their holders            |
| `network.read`             | Reading countries, stops, checkpoints and routes (PR-04)   |
| `network.manage`           | Managing them, drafting and publishing route versions      |
| `fleet.read`               | Reading the vehicle registry and status history (PR-05)    |
| `fleet.manage`             | Registering vehicles, editing them, changing their status  |
| `trip.read`                | Reading trips, their timetable and vehicle (PR-06)         |
| `trip.manage`              | Creating, timing, scheduling, cancelling trips; vehicles   |
| `seatmap.read`             | Reading seat maps, versions, cells and capacity (PR-07)    |
| `seatmap.manage`           | Creating seat maps, editing drafts, publishing versions    |
| `pricing.read`             | Reading fare tables, versions and fares (PR-08)            |
| `pricing.manage`           | Creating fare tables, editing drafts, publishing versions  |

### Role matrix

| Role                                | Realm | Privileged | Permissions                                                                                                                                                                                                |
| ----------------------------------- | ----- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPER_ADMIN`                       | STAFF | yes        | all twenty                                                                                                                                                                                                 |
| `DIRECTOR`                          | STAFF | no         | all except `privileged.manage`                                                                                                                                                                             |
| `OPS_MANAGER`                       | STAFF | no         | `ops.access`, `identity.read`, `role.read`, `network.read`, `network.manage`, `fleet.read`, `fleet.manage`, `trip.read`, `trip.manage`, `seatmap.read`, `seatmap.manage`, `pricing.read`, `pricing.manage` |
| `DISPATCHER`                        | STAFF | no         | `ops.access`, `network.read`, `fleet.read`, `trip.read`, `trip.manage`, `seatmap.read`, `pricing.read`                                                                                                     |
| `AUDITOR`                           | STAFF | no         | `ops.access`, `identity.read`, `role.read`, `audit.read`, `network.read`, `fleet.read`, `trip.read`, `seatmap.read`, `pricing.read`                                                                        |
| `COMPLIANCE_AGENT`                  | STAFF | no         | `ops.access`, `network.read`, `fleet.read`, `trip.read`, `seatmap.read` (no pricing permission)                                                                                                            |
| `BOOKING_AGENT`, `CUSTOMER_SUPPORT` | STAFF | no         | `ops.access`, `network.read`, `trip.read`, `seatmap.read`, `pricing.read` (no fleet permission by default)                                                                                                 |
| `FINANCE`                           | STAFF | no         | `ops.access`, `pricing.read` (no network, fleet, trip or seat-map permission by default)                                                                                                                   |
| `DRIVER`, `CREW`                    | CREW  | no         | none yet                                                                                                                                                                                                   |

A STAFF identity without any role, or with roles lacking `ops.access`, can
sign in (password + TOTP) but gets **Accès refusé** in OPS and 403 from every
admin route.

## Enforcement

- `AuthorizationGuard` is **deny by default**: a route guarded without any
  declared permission is refused (403). Class and method requirements are
  **merged**; both apply.
- Permissions are read from the database on **every request**: a revoked
  role or a suspended account loses access on the next call, without waiting
  for a session to expire.
- Every admin mutation also requires a valid CSRF token and a matching
  STAFF origin (ADR-016). Path identifiers are validated as UUIDv7.
- The OPS interface reads `GET /v1/admin/access/me` to choose what to show.
  This is display only; the API re-authorizes each call.

## Invariants of privileged changes

All checks run inside one transaction that first takes the advisory lock
`pg_advisory_xact_lock(0x45545f52424143)`, so concurrent grants, revocations
and status changes are serialized:

1. **Anti-escalation**: to grant or revoke a role, the actor must hold every
   permission of that role.
2. **Privileged roles and their holders** need `privileged.manage`: a
   DIRECTOR can neither grant `SUPER_ADMIN` nor suspend a SUPER_ADMIN.
3. **No self-modification**: nobody grants or revokes their own roles or
   changes their own status (403 `SELF_MODIFICATION_FORBIDDEN`). Closing
   one's own sessions stays possible, as with the self-service revoke-all.
4. **Last privileged admin**: a change that would leave no _usable_
   privileged administrator (ACTIVE, TOTP enabled, privileged role) is
   refused with 409 `LAST_PRIVILEGED_ADMIN`.
5. **Realm**: a role of another realm is refused (400 `ROLE_REALM_MISMATCH`,
   and the database trigger as a second barrier).

## Identity status

Allowed transitions: `ACTIVE → SUSPENDED | DISABLED`,
`SUSPENDED → ACTIVE | DISABLED`. `DISABLED` is final. Leaving `ACTIVE`
revokes every session (`ADMIN_ACTION`) and increments `auth_version` in the
same transaction; reactivation creates no session.

## STAFF provisioning and MFA enrollment (TOFU closed)

There is **no public STAFF or CREW registration** and no bootstrap endpoint.

1. An administrator with `identity.staff.provision` and `role.assign` invites an
   address with an initial STAFF role (anti-escalation applies). The API
   creates a PENDING identity, stores only the SHA-256 of a random token and
   sends `OPS_PUBLIC_URL/invitation#token=…` (3 days by default,
   `AUTH_STAFF_INVITATION_TTL_SECONDS`). Inviting an existing active account
   is refused (409 `STAFF_ALREADY_EXISTS`); it is never overwritten.
2. The invitee opens the link. The OPS page reads the token from the fragment,
   removes it from the address bar, and keeps it in memory only. The invitee
   chooses a password. Accepting is single-use and concurrency-safe. It
   activates the account and issues a **one-time enrollment grant** (1 day,
   `AUTH_STAFF_ENROLLMENT_GRANT_TTL_SECONDS`).
3. At first sign-in, password + valid grant leads to TOTP enrollment. Without
   a grant, a STAFF identity without TOTP gets the generic 401: **knowing the
   password is not enough to register an authenticator**. The grant is
   consumed in the enrollment transaction. Any concurrent loss of
   authorization rolls the whole enrollment back.
4. If the grant expired before enrollment, an administrator with
   `mfa.enrollment.authorize` can issue a new one. This is refused when TOTP
   is already enabled (409 `MFA_ALREADY_ENABLED`).

## Audit trail

- Table `audit_event`. A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`
  (**append-only**). Actor rows cannot be deleted while referenced.
- `AuditService.record` requires the caller's transaction: the event commits
  or rolls back with the change it describes.
- Recorded: `ROLE_GRANTED`, `ROLE_REVOKED`, `IDENTITY_STATUS_CHANGED`,
  `SESSIONS_REVOKED_BY_ADMIN`, `STAFF_INVITED`, `STAFF_INVITATION_ACCEPTED`,
  `STAFF_MFA_ENROLLMENT_AUTHORIZED`, `SUPER_ADMIN_BOOTSTRAPPED`. Each carries
  the actor (null for system/CLI events), actor realm, resource,
  before/after, reason and the request id.
- `before`, `after` and `metadata` go through the same redaction as logs:
  tokens, passwords, TOTP secrets and recovery codes are never written.
- Read through `GET /v1/admin/audit` (`audit.read`), newest first, keyset
  pagination.

## Admin API

All under `/v1/admin`, STAFF session, `ops.access` plus:

| Method | Path                                         | Permission(s)                             |
| ------ | -------------------------------------------- | ----------------------------------------- |
| GET    | `/access/me`                                 | session only (own access)                 |
| GET    | `/roles`                                     | `role.read`                               |
| GET    | `/identities?realm=staff\|crew&cursor&limit` | `identity.read`                           |
| GET    | `/identities/:id/access`                     | `identity.read`, `role.read`              |
| POST   | `/identities/:id/roles`                      | `role.assign` (+ CSRF)                    |
| POST   | `/identities/:id/roles/revoke`               | `role.assign` (+ CSRF)                    |
| POST   | `/identities/:id/status`                     | `identity.status.manage` (+ CSRF)         |
| POST   | `/identities/:id/sessions/revoke-all`        | `session.revoke.any` (+ CSRF)             |
| POST   | `/staff/invitations`                         | `identity.staff.provision`, `role.assign` |
| POST   | `/staff/:id/mfa/enrollment-authorization`    | `mfa.enrollment.authorize`                |
| GET    | `/audit?cursor&limit`                        | `audit.read`                              |

Public: `POST /v1/auth/staff/invitation/accept` (rate limited per IP).

## Initial SUPER_ADMIN

CLI only: `pnpm auth:bootstrap-super-admin -- --email … --delivery mail|print`.
See ADR-020 and [the runbook](../runbooks/bootstrap-super-admin.md).

## Known limitations

- No administrative reset of an **enabled** TOTP (lost authenticator without
  recovery codes): a supervised database procedure is still required
  ([authentication incident runbook](../runbooks/authentication-incident.md)).
- No STAFF/CREW password reset flow; no CREW provisioning UI yet.
- Roles and permissions are managed by migrations, not editable at runtime.
- Business permissions (bookings, dispatch, finance…) arrive with their PRs.
- Not deployed; nothing has been validated against production.
