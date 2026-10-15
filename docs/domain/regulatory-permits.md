# Regulatory permits (PR-16)

> Implemented in PR-16. **Not production deployed.** The repository ships no
> real permit type, permit number, legal requirement or corridor rule.
>
> **PERMIT_VALID != TRIP_READY. PR-17 owns departure readiness / dispatch
> authorization.**

PR-16 records generic operational authorizations and their intrinsic
validity. It gives authorized STAFF an audited OPS catalogue that future
readiness logic can read. It does not decide which permits a trip requires,
whether the catalogue is complete, or whether a trip may leave.

The boundaries are explicit:

- **PassengerManifest != permit:** PR-15 stores immutable passenger snapshots.
- **PassengerCompliance != operational permit:** PR-12 evaluates passenger
  obligations; PR-16 records authorizations applying to the operator or an
  operational resource.
- **Technical document acceptance != regulatory validity:** PR-11's
  technically accepted bytes neither create nor activate a permit.
- `VALID` never means “departure authorized”.

## Model

`RegulatoryPermit` is one mutable draft followed by an immutable operational
record:

| Field                                    | Meaning                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `reference`                              | Public immutable `ETRP-…` reference: 12 CSPRNG Crockford Base32 characters (60 bits). `ETP-…` remains the payment namespace.    |
| `permitType`                             | Bounded uppercase data code. It is not a hard-coded legal enum or a statement that the type is required.                        |
| `title`                                  | Human-readable label.                                                                                                           |
| `issuingAuthority`, `authorityReference` | Required issuing authority and optional official reference.                                                                     |
| `jurisdictionCountry`                    | Optional country whose authority/law issued the permit; independent of scope.                                                   |
| `validFrom`, `validUntil`                | Required inclusive calendar-date interval.                                                                                      |
| `status`                                 | Stored lifecycle: `DRAFT`, `ACTIVE` or `REVOKED`. Expiration is not stored here.                                                |
| `scopeType` and target FK                | Exactly one operator/resource subject, described below.                                                                         |
| `sourceUrl`, `sourceCheckedOn`           | Optional minimized provenance. URLs must be HTTPS without credentials; a check date cannot be in the future.                    |
| `notes`                                  | Optional bounded internal notes; never copied into the audit snapshot.                                                          |
| `revision`                               | Positive optimistic-concurrency version, incremented once per mutation.                                                         |
| actor/timestamp fields                   | Creator, latest updater, activator and revoker are referentially constrained identities that must be ACTIVE STAFF when written. |

The reference is deliberately `ETRP-` rather than the mission's proposed
`ETP-`: PR-10 already assigns `ETP-` references to payments. Clients use
public references and business codes; API views do not expose PostgreSQL
UUIDs.

There is no file or proof object in PR-16. A permit may be recorded from an
official reference and provenance without copying a document. Consequently,
there is no `permit.document.read`, public storage path, permanent signed URL
or document byte in PostgreSQL.

## Scope and jurisdiction

Every permit has exactly one scope:

| Scope           | Target and semantics                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `OPERATOR`      | The one current EURO TERANGA operator. It has no target FK because the repository has no multi-operator model.     |
| `COUNTRY`       | One existing `Country`. This is the resource covered, not necessarily the issuing jurisdiction.                    |
| `VEHICLE`       | One existing `Vehicle`.                                                                                            |
| `ROUTE_VERSION` | One existing historical `RouteVersion`, resolved by route code and version. It does not migrate to later geometry. |
| `TRIP`          | One existing `Trip`, resolved by its public reference.                                                             |

An exact-one-of CHECK pairs `scopeType` with the corresponding nullable FK;
all targets use `ON DELETE RESTRICT`. A free polymorphic resource id is never
accepted. One permit cannot silently apply to several resources, and PR-16
does not infer that a country or route-version permit applies to a particular
trip. Future PR-17 policy may compose these explicit facts.

There is no corridor scope because the current model has no referentially
constrained corridor entity. A country scope covers one country; a
route-version scope covers one concrete historical itinerary.

## Lifecycle and revisions

```text
DRAFT -> ACTIVE -> REVOKED
```

- Creation always produces revision 1 in `DRAFT` and records the creator as
  the initial updater.
- Only `DRAFT` content can be edited. An edit locks the row and requires the
  caller's `expectedRevision`.
- Activation locks the row, requires the current revision and changes only
  lifecycle/actor facts. It cannot edit permit content.
- Revocation locks an `ACTIVE` row, requires the current revision and a
  trimmed 10–500 character reason. It is terminal.
- Every successful edit or transition increments `revision` by exactly one.
- There is no reactivation, rollback to draft, destructive delete or
  truncate.

The optimistic revision makes stale API writes deterministic. A row lock then
serializes concurrent edits, double activation, activation versus revocation
and other transitions; exactly the first compatible mutation can commit.

PostgreSQL independently enforces initial state/revision, transition order,
unchanged content during transitions, lifecycle timestamps, active STAFF
actors, chronological timestamps and terminal revocation. Direct SQL cannot
bypass those rules.

## Intrinsic validity

Lifecycle and calendar validity are deliberately separate. The pure
`derivePermitValidity` function receives the permit facts and an explicit
`evaluatedOn` ISO calendar date:

| Result          | Rule                                                                |
| --------------- | ------------------------------------------------------------------- |
| `DRAFT`         | Lifecycle is `DRAFT`, regardless of dates.                          |
| `REVOKED`       | Lifecycle is `REVOKED`, regardless of dates.                        |
| `NOT_YET_VALID` | Lifecycle is `ACTIVE` and `evaluatedOn < validFrom`.                |
| `VALID`         | Lifecycle is `ACTIVE` and `validFrom <= evaluatedOn <= validUntil`. |
| `EXPIRED`       | Lifecycle is `ACTIVE` and `evaluatedOn > validUntil`.               |

The API reads `CURRENT_DATE` from PostgreSQL inside the transaction and
returns it as `evaluatedOn`. Tests inject boundary dates; the browser neither
uses its clock nor recomputes the result.

`validUntil` is mandatory in PR-16. No data-driven type catalogue exists that
could safely declare an open-ended type, so a null end date is refused rather
than interpreted as permanent authority.

Again: **PERMIT_VALID != TRIP_READY. PR-17 owns departure readiness / dispatch
authorization.** Intrinsic `VALID` says nothing about applicability,
completeness, passengers, vehicle availability, manifest state, crew,
check-in, boarding or dispatch.

## Provenance and logical duplicates

Provenance is intentionally small: issuing authority, optional authority
reference, optional jurisdiction, optional HTTPS source and optional date on
which that source was checked. `sourceCheckedOn` uses the database calendar
and cannot be future-dated.

When an authority reference is present, PostgreSQL rejects an exact logical
duplicate across:

- permit type;
- case-insensitive issuing authority and authority reference;
- jurisdiction;
- scope type and every explicit scope target.

Nullable tuple parts use `NULLS NOT DISTINCT`. The constraint applies across
all lifecycle states, so revocation preserves that official identity. Without
an authority reference, the system has no sound external identity to compare
and does not guess: similar records may coexist.

No applicability or requirement rule is encoded in TypeScript or seeded in
PostgreSQL. All test fixtures use synthetic types, authorities and references.

## API

All routes are STAFF-only under `/v1/admin/regulatory-permits` and require
`ops.access` plus the permission shown:

| Method | Route                                              | Permission and behavior                                                     |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/v1/admin/regulatory-permits`                     | `permit.read`; keyset page, server-derived validity, audited before return. |
| `GET`  | `/v1/admin/regulatory-permits/:reference`          | `permit.read`; detail plus mutation history, audited before return.         |
| `POST` | `/v1/admin/regulatory-permits`                     | `permit.manage` + CSRF; create a revision-1 draft.                          |
| `POST` | `/v1/admin/regulatory-permits/:reference`          | `permit.manage` + CSRF; edit a draft with `expectedRevision`.               |
| `POST` | `/v1/admin/regulatory-permits/:reference/activate` | `permit.manage` + CSRF; `DRAFT -> ACTIVE`.                                  |
| `POST` | `/v1/admin/regulatory-permits/:reference/revoke`   | `permit.manage` + CSRF; `ACTIVE -> REVOKED`, revision and reason required.  |

The bounded list defaults to 25 and accepts at most 100 rows. Its cursor is a
public permit reference. Filters cover lifecycle status, derived validity,
scope type, permit type, country (jurisdiction or country scope), vehicle,
route/version, trip and exact permit reference. Ordering is deterministic by
descending UUIDv7 identity, without exposing that identity.

Inputs are strict and bounded. Scope targets are resolved from ISO2, vehicle
code, route code/version or trip reference. Unknown targets are rejected. All
responses are private/no-store; no readiness, departure approval or dispatch
endpoint exists.

## Permissions and OPS

There is no wildcard grant:

| Role                                                             | `permit.read` | `permit.manage` |
| ---------------------------------------------------------------- | ------------- | --------------- |
| `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`                         | yes           | yes             |
| `DISPATCHER`, `COMPLIANCE_AGENT`, `AUDITOR`                      | yes           | no              |
| `BOOKING_AGENT`, `CUSTOMER_SUPPORT`, `FINANCE`, `DRIVER`, `CREW` | no            | no              |

`DISPATCHER` is intentionally read-only: consuming permit facts in PR-17 does
not grant authority to alter them. The API checks database-backed permissions
on every request.

OPS exposes **Autorisations réglementaires** at `/regulatory-permits` only
with `permit.read`. The workspace provides a paginated list, reference/status
filters, detail, inclusive dates, explicit scope and server-evaluated validity.
`permit.manage` additionally reveals draft creation/editing, activation and a
two-step reasoned revocation. Read-only users see no mutation controls. The
screen repeats that intrinsic validity is not trip readiness or departure
authorization.

## Audit and history

Every mutation and audited read uses the request's database transaction:

- `REGULATORY_PERMIT_CREATED`;
- `REGULATORY_PERMIT_UPDATED`;
- `REGULATORY_PERMIT_ACTIVATED`;
- `REGULATORY_PERMIT_REVOKED`;
- `REGULATORY_PERMIT_ACCESSED` (`LIST` or `DETAIL`).

Mutation snapshots explicitly allow-list permit reference, type, title,
issuing authority, jurisdiction, scope, lifecycle, intrinsic validity,
inclusive dates and revision. The top-level
audit event retains its actor and request context. Snapshots exclude notes,
source URLs, authority references, internal UUIDs and actor identifiers. List
metadata records normalized filters and the public references returned;
detail metadata records the public permit reference. The generic audit row
still relates the event to the internal resource and authenticated actor.

The detail view projects at most the 50 latest mutation audit events as a
human timeline (action, time, resulting status/revision and revocation reason
when applicable). The append-only audit table remains the authoritative full
event trail. An audit failure rolls the read or mutation transaction back.

## Migration

`20261015120000_regulatory_permits` is the additive PR-16 migration (migration
16):

- two enums and one `regulatory_permit` table;
- explicit target/actor FKs, CHECKs, unique and list indexes;
- lifecycle/delete/truncate guard functions and triggers;
- `permit.read`, `permit.manage` and nine explicit role grants.

There is no backfill and no real permit seed. Existing PR-15 data is not
rewritten. Foreign-key validation briefly locks referenced country, vehicle,
route-version, trip and identity catalogues; the new table itself contains no
legacy rows.

## Known limitations

- PR-16 records permits but no permit-requirement catalogue. It cannot say
  what a trip needs, whether a scoped permit applies through a hierarchy, or
  whether the set is complete.
- **PR-17 owns departure readiness / dispatch authorization**, including any
  policy that consumes permit facts. PR-18 owns offline Crew/device mechanics.
- `OPERATOR` means the one current operator; supporting several operators
  needs a new entity and migration.
- All permits have a finite `validUntil`; open-ended validity needs a verified,
  data-driven type policy first.
- No supporting document is stored or downloaded. Adding one requires a
  separate private-storage, malware-scanning, retention and RBAC decision.
- The detail timeline is a bounded audit projection, not a full content-version
  store; prior free-text notes and source URLs are intentionally not retained
  in snapshots.
- No production legal data is shipped, and nothing has been validated against
  production.
