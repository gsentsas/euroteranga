# Passenger and private-document domain

> Implemented in PR-11. **Not production deployed.** Passenger-document
> storage and scanning are disabled unless both are explicitly configured.
> **TECHNICALLY_ACCEPTED != REGULATORY_VALID.** PR-12 will own Compliance.

PR-11 introduces the person travelling independently from the authenticated
CUSTOMER who booked, plus a private technical file pipeline. It does not
decide whether a document is legally valid or sufficient for a journey.

## Scope

Included:

- a minimal `Passenger` owned by one CUSTOMER;
- the immutable `BookingPassenger` link to a confirmed booking;
- private PDF/JPEG/PNG upload, validation, hashing, quarantine and malware
  scanning;
- owner-only CUSTOMER reads and downloads;
- read-only STAFF access under `passenger.document.read`;
- sensitive-read and lifecycle audit events;
- LOCAL development/CI storage and an S3-compatible adapter.

Deferred to PR-12 or later: regulatory compliance, legal validity, country
rules, approval/rejection by staff, OCR, MRZ, biometrics, retention/deletion,
check-in, boarding, manifests and ticketing. Production S3 and ClamAV
provisioning are also outside this change.

## Data model

| Model               | Meaning                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Passenger`         | A person travelling: public `ETV-…` reference, immutable CUSTOMER owner, name, date of birth and active-country nationality. It is not an authentication identity.                    |
| `BookingPassenger`  | Historical many-to-many association between a passenger and a confirmed booking owned by the same CUSTOMER.                                                                           |
| `PassengerDocument` | Metadata for one private object: public `ETD-…` reference, type, opaque object key, SHA-256, server-derived MIME, size and technical state. No bytes or original filename are stored. |

Internal ids are UUIDv7. Public references contain 12 CSPRNG Crockford-base32
characters and are never sequential. Object keys contain 256 random bits:
`passenger-documents/<first-byte>/<64-lowercase-hex>`.

PostgreSQL enforces that:

- a new passenger belongs to an ACTIVE CUSTOMER, has normalized non-empty
  names and no future date of birth; identity, reference and owner are
  immutable;
- a booking/passenger link is insert-only, joins records with the same owner,
  targets a confirmed/non-cancelled booking, and cannot exceed booked seats;
- concurrent links for the last seat serialize on the booking row;
- historical passengers, associations and document metadata cannot be
  deleted or truncated;
- a document begins `QUARANTINED`, then moves exactly once to `ACCEPTED` or
  `REJECTED`; file identity/metadata never change;
- reference, object-key, SHA-256, MIME, positive size, failure code and
  state/timestamp combinations remain valid.

Historical PR-09/PR-10 bookings receive no synthetic passenger backfill.

## Technical state machine

```text
QUARANTINED ── clean scan + matching size/hash ──> ACCEPTED
            └─ malware/error/timeout/integrity ──> REJECTED
```

Only `ACCEPTED` objects can be downloaded. `ACCEPTED` means only that the file
passed this upload's technical checks. It is not a compliance outcome. PR-11
has no approval endpoint, button or permission.

## Upload pipeline

```text
CUSTOMER session → origin/CSRF → ownership → per-identity rate limit
→ bounded multipart stream → field/name/extension/MIME/magic validation
→ SHA-256 while streaming → opaque key in private storage
→ QUARANTINED metadata + audit → malware scan outside a DB transaction
→ size/hash verification → terminal state + audit
```

The accepted combinations are PDF/`.pdf`, JPEG/`.jpg|.jpeg`, and PNG/`.png`.
HTML, SVG, archives, executables, office documents, extra files/fields,
control characters, path separators, double extensions, empty files and
MIME/magic mismatches are rejected. The server derives the actual MIME and
limits the stream to `PASSENGER_DOCUMENT_MAX_BYTES` (10 MiB by default,
1 KiB–25 MiB allowed). It never trusts a browser-supplied status or MIME.

The scanner interface consumes a stream. `CLAMAV` implements clamd `INSTREAM`
over TCP without a shell or temporary command. Timeout, unavailable service,
invalid response and unknown errors all fail closed. `TEST` recognizes only a
harmless synthetic marker and is refused in staging/production.

## Storage and download

The domain depends only on `ObjectStorageProvider` (`put`, `get`, `head`,
`delete`). See [ADR-005](../adr/ADR-005-private-object-storage-quarantine.md).

- `LOCAL` is development/CI only. Its configured absolute root cannot be a
  public/static/upload path; roots and shards cannot be symlinks; directories
  are owner-only `0700`, objects `0600`.
- `S3` uses an explicitly configured endpoint/bucket/credentials, emits no
  public ACL and no signed URL, and marks objects `private, no-store`.
- `DISABLED` is the safe default. Enabling storage without a scanner is a
  startup error. LOCAL and TEST are refused in staging/production, and a
  deployed S3 endpoint must use HTTPS.

Every read is `client → authenticated API → owner/RBAC check → audit → private
stream`. Responses use the validated MIME, an attachment filename derived
from the opaque document reference, `X-Content-Type-Options: nosniff` and
`Cache-Control: private, no-store`. Foreign/unknown references return the same 404. Quarantined/rejected references are never streamed.

## Consistency across PostgreSQL and storage

There is deliberately no distributed transaction, and no network operation
holds a PostgreSQL transaction open:

| Failure window                                        | Safe result                                                           | Recovery                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| object write succeeds, DB insert fails                | best-effort delete; a delete failure can leave an unreferenced object | inventory and remove only after proving no DB key exists                                           |
| DB insert succeeds, process/network fails before scan | row stays `QUARANTINED` and cannot be downloaded                      | investigate/re-scan through a future controlled recovery job; never force-accept                   |
| scanner fails or finds malware                        | transaction marks `REJECTED`; object is deleted best effort           | retry deletion if the private object remains                                                       |
| scanner succeeds, terminal DB transaction fails       | row stays `QUARANTINED`                                               | do not expose; controlled re-scan may retry                                                        |
| accepted object is missing or has wrong size          | API returns 503, emits no bytes                                       | restore the exact object or investigate storage; never replace under the key without hash evidence |
| network interruption during download                  | no state change; the audited access may have started                  | client retries through authorization                                                               |

Opaque keys and delete are idempotent; key collisions are retried. The
[storage reconciliation runbook](../runbooks/passenger-document-storage-reconciliation.md)
defines safe operator handling.

## Authorization and audit

The CUSTOMER may create a passenger only on their own confirmed booking,
within seat capacity. Passenger/document list, upload and accepted download
all query through the immutable CUSTOMER owner. Ownership mismatch is hidden
as 404.

STAFF routes require `ops.access` and `passenger.document.read`. The migration
grants the narrow read permission to `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`
and `COMPLIANCE_AGENT`; it grants no document mutation or compliance approval.

Audit actions are `PASSENGER_CREATED`, `BOOKING_PASSENGER_ATTACHED`,
`PASSENGER_DOCUMENT_UPLOADED`, `PASSENGER_DOCUMENT_ACCEPTED`,
`PASSENGER_DOCUMENT_REJECTED` and `PASSENGER_DOCUMENT_ACCESSED` (`METADATA` or
`CONTENT`). Audit/log data includes stable references, normalized technical
codes and sizes, never bytes, original filenames, object-store credentials,
scanner output or document numbers.

## API surfaces

CUSTOMER routes under `/v1/booking`:

- `GET /passenger-countries`;
- `POST|GET /bookings/:bookingReference/passengers`;
- `GET /passengers/:passengerReference`;
- `POST|GET /passengers/:passengerReference/documents`;
- `GET /documents/:documentReference/download`.

STAFF routes under `/v1/admin/passenger-documents` are list, detail and
accepted-file download only. Lists and JSON detail return metadata, never an
object key, digest, failure code, original filename or file bytes.

## Migration review

```text
FORWARD=Additive enums/tables/indexes/FKs/checks/triggers and one narrow permission with four role grants.
BACKWARD=No down migration by repository policy; roll application code back first, preserve data, then use a reviewed data-aware manual removal only if explicitly approved.
LOCK_RISK=Low to moderate: new tables/indexes are isolated; foreign keys briefly lock referenced booking/auth/country tables and permission inserts touch the RBAC catalogue. No existing table rewrite or backfill.
DATA_RISK=Low and additive; existing booking/payment rows are not modified. New history is intentionally immutable.
BACKFILL=NO
EXISTING_BOOKINGS_PRESERVED=YES
EXISTING_PAYMENTS_PRESERVED=YES
```
