# Passenger manifests (PR-15)

PR-15 records versioned passenger snapshots for one scheduled `Trip`. Every
explicit request creates a new immutable `PassengerManifest`; there is no
mutable current row and no final/approved state.

## Snapshot

Only booking passengers with a `PassengerCheckIn` are included. Entries are
ordered naturally by seat label, then by passenger reference. Each entry
contains:

- booking and passenger public references;
- given/family name, calendar date of birth and nationality ISO codes;
- origin and destination stop sequence/code/name/country;
- seat label and check-in reference/time;
- optional boarding reference/time.

Trip reference, planned times and the currently assigned vehicle code/plate
are captured too. Missing vehicle facts are represented as `null`; they are
never invented.

The snapshot excludes documents and files, payment, compliance evidence,
readiness, QR credentials, actor/device/client identifiers, customer email,
baggage and internal audit metadata. `passenger-manifest/1` is canonicalized
and SHA-256 hashed before storage.

## Versioning and persistence

`passenger_manifest` is append-only. Its insertion trigger:

- locks the trip row;
- accepts only a `SCHEDULED` trip and an ACTIVE STAFF generator;
- requires exactly `max(version) + 1` for that trip;
- replaces `generated_at` with the database clock.

Update, delete and truncate are rejected. Two concurrent generations queue on
the same trip and become adjacent versions. No PR-14 row is backfilled.

An empty manifest is valid: it records that no passenger was checked in at
that generation time.

## API and permissions

All routes are STAFF-only and also require `ops.access`:

| Method | Route                                       | Permission                 |
| ------ | ------------------------------------------- | -------------------------- |
| `GET`  | `/v1/admin/manifests?tripReference=…`       | `manifest.read`            |
| `GET`  | `/v1/admin/manifests/:reference`            | `manifest.read`            |
| `POST` | `/v1/admin/manifests/trips/:tripReference`  | `manifest.generate` + CSRF |
| `GET`  | `/v1/admin/manifests/:reference/export.csv` | `manifest.export`          |

Only SUPER_ADMIN, DIRECTOR, OPS_MANAGER and DISPATCHER hold those permissions
by default. Reads, generation and export are audited. Audit metadata contains
only manifest/trip references, version and counts, never passenger PII.

The CSV is UTF-8 RFC 4180 and comes only from the immutable snapshot. Text
beginning with `=`, `+`, `-`, `@`, tab, CR or LF is prefixed with an apostrophe
before CSV escaping to prevent spreadsheet formula injection.

## Explicit non-goals

Manifest is not trip readiness, regulatory clearance, a border permit,
passenger-document validation or dispatch authorization. PR-16 records
operational permits without turning a manifest into one; PR-17 owns departure
readiness / dispatch authorization. PR-18 owns offline Crew delivery and
device synchronization.

## Use by PR-17

PR-17 never treats a manifest as authorization. It rebuilds the same canonical PR-15 snapshot from current check-in/boarding facts and requires its SHA-256 hash to match the latest immutable manifest before departure readiness can pass.
