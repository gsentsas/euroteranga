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
| `booking.read`             | Reading customer holds, journeys, seats and prices (PR-09) |
| `booking.manage`           | Cancelling active customer holds with a reason             |
| `payment.read`             | Reading payment attempts and provider events (PR-10)       |
| `payment.manage`           | Cancelling a PENDING attempt (never marking one paid)      |
| `passenger.document.read`  | Reading passenger-document metadata and accepted bytes     |
| `compliance.read`          | Reading passenger compliance evaluations and reviews       |
| `compliance.review`        | Evaluating a booking passenger, reasoned human review      |
| `compliance.rule.read`     | Reading regulatory rules, versions and provenance          |
| `compliance.rule.manage`   | Drafting, verifying, publishing and retiring rule versions |
| `baggage.read`             | Reading baggage, its QR payload and event history (PR-13)  |
| `baggage.manage`           | Registering baggage, recording weight and baggage events   |
| `checkin.read`             | Reading check-in readiness, seat assignments and check-ins |
| `checkin.manage`           | Assigning booked seats and checking in ready passengers    |
| `boarding.read`            | Resolving a boarding QR and reading the boarding state     |
| `boarding.scan`            | Boarding a checked-in passenger by QR scan                 |
| `manifest.read`            | Reading immutable passenger manifest history/snapshots     |
| `manifest.generate`        | Generating a new immutable manifest version                |
| `manifest.export`          | Exporting a stored manifest snapshot as private CSV        |
| `permit.read`              | Reading operational permits and intrinsic validity         |
| `permit.manage`            | Creating, editing, activating and revoking permits         |

### Role matrix

| Role                                | Realm | Privileged | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPER_ADMIN`                       | STAFF | yes        | all forty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DIRECTOR`                          | STAFF | no         | all except `privileged.manage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OPS_MANAGER`                       | STAFF | no         | `ops.access`, `identity.read`, `role.read`, `network.read`, `network.manage`, `fleet.read`, `fleet.manage`, `trip.read`, `trip.manage`, `seatmap.read`, `seatmap.manage`, `pricing.read`, `pricing.manage`, `booking.read`, `booking.manage`, `payment.read`, `passenger.document.read`, `compliance.read`, `baggage.read`, `baggage.manage`, `checkin.read`, `checkin.manage`, `boarding.read`, `boarding.scan`, `manifest.read`, `manifest.generate`, `manifest.export`, `permit.read`, `permit.manage` |
| `DISPATCHER`                        | STAFF | no         | `ops.access`, `network.read`, `fleet.read`, `trip.read`, `trip.manage`, `seatmap.read`, `pricing.read`, `baggage.read`, `baggage.manage`, `checkin.read`, `checkin.manage`, `boarding.read`, `boarding.scan`, `manifest.read`, `manifest.generate`, `manifest.export`, `permit.read` (no booking or permit-management permission)                                                                                                                                                                         |
| `AUDITOR`                           | STAFF | no         | `ops.access`, `identity.read`, `role.read`, `audit.read`, `network.read`, `fleet.read`, `trip.read`, `seatmap.read`, `pricing.read`, `payment.read`, `compliance.rule.read`, `permit.read`                                                                                                                                                                                                                                                                                                                |
| `COMPLIANCE_AGENT`                  | STAFF | no         | `ops.access`, `network.read`, `fleet.read`, `trip.read`, `seatmap.read`, `passenger.document.read`, `compliance.read`, `compliance.review`, `compliance.rule.read`, `permit.read` (no pricing, payment or permit-management permission)                                                                                                                                                                                                                                                                   |
| `BOOKING_AGENT`, `CUSTOMER_SUPPORT` | STAFF | no         | `ops.access`, `network.read`, `trip.read`, `seatmap.read`, `pricing.read`, `booking.read`, `booking.manage`, `payment.read`, `baggage.read`, `checkin.read`; `BOOKING_AGENT` also `baggage.manage`, `checkin.manage` (no fleet or boarding permission by default)                                                                                                                                                                                                                                         |
| `FINANCE`                           | STAFF | no         | `ops.access`, `pricing.read`, `payment.read`, `payment.manage` (no network, fleet, trip, seat-map or booking permission by default)                                                                                                                                                                                                                                                                                                                                                                       |
| `DRIVER`, `CREW`                    | CREW  | no         | none yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
- Booking adds `BOOKING_HELD`, `BOOKING_CANCELLED` and
  `BOOKING_CANCELLED_BY_TRIP`. Each event shares the business transaction; an
  audit failure rolls back the hold/cancellation and inventory changes.
- Payments (PR-10) add `PAYMENT_CREATED` (the CUSTOMER), `PAYMENT_CANCELLED`
  (CUSTOMER, STAFF or trip cascade), and `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`
  and `BOOKING_CONFIRMED`. The last three have a system actor (null): they
  come from a signed provider event and carry its id, never a signature or a
  secret. An audit failure rolls back the whole event processing.
- Passenger documents (PR-11) add `PASSENGER_CREATED`,
  `BOOKING_PASSENGER_ATTACHED`, `PASSENGER_DOCUMENT_UPLOADED`,
  `PASSENGER_DOCUMENT_ACCEPTED` and `PASSENGER_DOCUMENT_REJECTED`. Sensitive
  reads add `PASSENGER_DOCUMENT_ACCESSED` before the data is returned: `LIST`
  (one event per STAFF page, with the references shown and the filters),
  `METADATA` (detail) or `CONTENT` (download), with stable references only;
  no bytes, original filename, object key, digest or scanner output is
  audited.
- Compliance (PR-12) adds `COMPLIANCE_RULE_CREATED`,
  `COMPLIANCE_RULE_VERSION_CREATED`, `COMPLIANCE_RULE_VERSION_UPDATED`,
  `COMPLIANCE_RULE_VERIFIED`, `COMPLIANCE_RULE_PUBLISHED`,
  `COMPLIANCE_RULE_RETIRED`, `COMPLIANCE_EVALUATED` and `COMPLIANCE_REVIEWED`.
  STAFF reads add `COMPLIANCE_ACCESSED` (`LIST` per queue page, `DETAIL`)
  before the data is returned. Events carry references, digests, results and
  decisions; never names, birth dates, file data or the internal review
  reason.
- Regulatory permits (PR-16) add `REGULATORY_PERMIT_CREATED`,
  `REGULATORY_PERMIT_UPDATED`, `REGULATORY_PERMIT_ACTIVATED` and
  `REGULATORY_PERMIT_REVOKED`. STAFF list/detail reads add
  `REGULATORY_PERMIT_ACCESSED` before return. Mutation snapshots contain only
  the public permit reference, type, title, issuing authority, jurisdiction,
  scope, lifecycle/validity, dates and revision; never notes, source URLs,
  authority references, actor ids or internal resource ids. Revocation stores
  its mandatory reason as bounded event metadata.
- `before`, `after` and `metadata` go through the same redaction as logs:
  tokens, passwords, TOTP secrets and recovery codes are never written.
- Read through `GET /v1/admin/audit` (`audit.read`), newest first, keyset
  pagination.

## Admin API

All under `/v1/admin`, STAFF session, `ops.access` plus:

| Method | Path                                                                  | Permission(s)                             |
| ------ | --------------------------------------------------------------------- | ----------------------------------------- |
| GET    | `/access/me`                                                          | session only (own access)                 |
| GET    | `/roles`                                                              | `role.read`                               |
| GET    | `/identities?realm=staff\|crew&cursor&limit`                          | `identity.read`                           |
| GET    | `/identities/:id/access`                                              | `identity.read`, `role.read`              |
| POST   | `/identities/:id/roles`                                               | `role.assign` (+ CSRF)                    |
| POST   | `/identities/:id/roles/revoke`                                        | `role.assign` (+ CSRF)                    |
| POST   | `/identities/:id/status`                                              | `identity.status.manage` (+ CSRF)         |
| POST   | `/identities/:id/sessions/revoke-all`                                 | `session.revoke.any` (+ CSRF)             |
| POST   | `/staff/invitations`                                                  | `identity.staff.provision`, `role.assign` |
| POST   | `/staff/:id/mfa/enrollment-authorization`                             | `mfa.enrollment.authorize`                |
| GET    | `/audit?cursor&limit`                                                 | `audit.read`                              |
| GET    | `/bookings?cursor&limit&status&tripId&reference`                      | `booking.read`                            |
| GET    | `/bookings/:id`                                                       | `booking.read`                            |
| POST   | `/bookings/:id/cancel`                                                | `booking.manage` (+ CSRF, reason)         |
| GET    | `/payments?cursor&limit&status&bookingReference&paymentReference`     | `payment.read`                            |
| GET    | `/payments/:id`                                                       | `payment.read`                            |
| POST   | `/payments/:id/cancel`                                                | `payment.manage` (+ CSRF, reason)         |
| GET    | `/passenger-documents`                                                | `passenger.document.read` (+ page audit)  |
| GET    | `/passenger-documents/:reference`                                     | `passenger.document.read` (+ read audit)  |
| GET    | `/passenger-documents/:reference/download`                            | `passenger.document.read` (+ read audit)  |
| GET    | `/compliance/rules`, `/compliance/rules/:reference`                   | `compliance.rule.read`                    |
| POST   | `/compliance/rules`, `/compliance/rules/:reference/versions`          | `compliance.rule.manage` (+ CSRF)         |
| POST   | `/compliance/rules/:reference/versions/:n` (draft edit)               | `compliance.rule.manage` (+ CSRF)         |
| POST   | `/compliance/rules/:reference/versions/:n/verify\|publish\|retire`    | `compliance.rule.manage` (+ CSRF)         |
| GET    | `/compliance/booking-passengers`                                      | `compliance.read` (+ page audit)          |
| GET    | `/compliance/evaluations/:reference`                                  | `compliance.read` (+ read audit)          |
| POST   | `/compliance/evaluations`                                             | `compliance.review` (+ CSRF)              |
| POST   | `/compliance/evaluations/:reference/reviews`                          | `compliance.review` (+ CSRF, reason)      |
| GET    | `/baggage`, `/baggage/:reference`, `/baggage/:reference/qr`           | `baggage.read` (+ read audit)             |
| POST   | `/baggage/resolve-qr`                                                 | `baggage.read` (+ CSRF, read audit)       |
| POST   | `/baggage`, `/baggage/scan`                                           | `baggage.manage` (+ CSRF)                 |
| POST   | `/baggage/:reference/weight`, `/baggage/:reference/events`            | `baggage.manage` (+ CSRF)                 |
| GET    | `/check-in/booking-passengers`, `/check-in/bookings/:b/passengers/:p` | `checkin.read` (+ read audit)             |
| GET    | `/check-in/check-ins/:reference/qr`                                   | `checkin.read` (+ read audit)             |
| POST   | `/check-in/bookings/:b/passengers/:p/seat\|check-in`                  | `checkin.manage` (+ CSRF)                 |
| POST   | `/boarding/resolve`                                                   | `boarding.read` (+ CSRF, read audit)      |
| POST   | `/boarding/scan`                                                      | `boarding.read`, `boarding.scan` (+ CSRF) |
| GET    | `/manifests?tripReference=…`, `/manifests/:reference`                 | `manifest.read` (+ read audit)            |
| POST   | `/manifests/trips/:tripReference`                                     | `manifest.generate` (+ CSRF, audit)       |
| GET    | `/manifests/:reference/export.csv`                                    | `manifest.export` (+ export audit)        |
| GET    | `/regulatory-permits`, `/regulatory-permits/:reference`               | `permit.read` (+ read audit)              |
| POST   | `/regulatory-permits`, `/regulatory-permits/:reference`               | `permit.manage` (+ CSRF, audit)           |
| POST   | `/regulatory-permits/:reference/activate`                             | `permit.manage` (+ CSRF, audit)           |
| POST   | `/regulatory-permits/:reference/revoke`                               | `permit.manage` (+ CSRF, reason, audit)   |

The booking detail (`GET /bookings/:id`) includes the booking's payment
attempts only for callers holding `payment.read`: `booking.read` alone gives no
financial payment detail. No route can mark an attempt paid: SUCCEEDED only
comes from a provider event (see [payments.md](../domain/payments.md)).
Passenger-document routes are read-only; technical `ACCEPTED` is not a staff
approval or regulatory decision (see
[passenger-documents.md](passenger-documents.md)).
Regulatory-permit validity is computed by the server from lifecycle and
inclusive dates. **PERMIT_VALID != TRIP_READY. PR-17 owns departure readiness /
dispatch authorization.** There is no permit document endpoint: PR-16 stores
no file (see [regulatory-permits.md](../domain/regulatory-permits.md)).

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
- Departure readiness/dispatch, refund and accounting permissions arrive with
  their domains. `permit.read` does not authorize dispatch, and
  `permit.manage` does not approve departure.
- PR-11 exposes technical document read access only. PR-12 owns passenger
  compliance, while PR-16 operational permits have no file/document
  permission. Technical document acceptance is not regulatory validity.
- PR-16 has no data-driven permit-requirement catalogue and does not decide
  which permits a trip needs. PR-17 owns departure readiness / dispatch
  authorization.
- `AUDITOR`, `FINANCE` and `COMPLIANCE_AGENT` have no check-in or boarding
  permission (PR-14). CREW and DRIVER cannot board until the PR-18 Crew
  application adds a CREW route and device enrollment.
- `AUDITOR`, `FINANCE` and `COMPLIANCE_AGENT` have no baggage permission:
  baggage views name the passenger (PR-13). Auditors follow baggage changes
  through the audit trail.
- Not deployed; nothing has been validated against production.
