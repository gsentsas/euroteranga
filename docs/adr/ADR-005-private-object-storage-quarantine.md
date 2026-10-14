# ADR-005 — Private object storage, malware scanning and logical quarantine

- Status: Accepted
- Date: 2026-10-14

## Context

Passenger identity documents are sensitive PII and untrusted uploads. Storing
them in PostgreSQL would mix large binary lifecycle/backup concerns with
business metadata. Storing them under a frontend or Plesk web root would make
an authorization mistake irreversible. PostgreSQL, object storage and a
malware scanner cannot participate in one atomic transaction.

The first implementation must work deterministically in local development and
CI while leaving a safe path to private S3-compatible production storage. It
must not pretend that a technically clean file is legally valid.

## Decision

1. The business domain uses two provider-neutral interfaces:
   `ObjectStorageProvider` (`put/get/head/delete`) and `MalwareScanner`
   (`scan(stream)`). AWS, a local filesystem and clamd stay in adapters.
2. File bytes live only in private object storage. PostgreSQL stores an opaque
   random key, SHA-256, validated MIME, size and technical state. It stores no
   binary, original filename, scanner output, public/signed URL or document
   number.
3. Quarantine is **logical in the same private store**. A newly persisted row
   is `QUARANTINED`; every download query requires `ACCEPTED`. The API is the
   only read path. A separate public host and presigned URLs are not used.
4. Upload and scan are streamed. The object is read back from storage for the
   malware scan and its size/SHA-256 are checked before acceptance. Clamd uses
   `INSTREAM`; scanner failure is fail-closed.
5. Database transactions stay short and never wrap storage or scanner calls.
   Compensating deletion is best effort and idempotent. An uncertain outcome
   stays quarantined or rejected and therefore inaccessible. Operators use a
   documented reconciliation process for possible orphans.
6. `LOCAL` storage and the deterministic `TEST` scanner exist only for
   local/CI and are configuration errors in staging/production. `S3` and
   `CLAMAV` require explicit settings. `DISABLED` is the default and safely
   makes uploads unavailable.
7. Production provisioning, bucket policy, credential rotation, encryption,
   retention and ClamAV operations require a separate infrastructure decision
   before enablement. PR-11 makes no production change.

## Required production properties

Before enabling S3 in a deployed environment, an infrastructure review must
prove: a private bucket with block-public-access/anonymous access disabled,
least-privilege service credentials, HTTPS, encryption at rest, logging and
alerting without object data, versioning/immutability policy as appropriate,
backup/retention decisions, and tested deletion/reconciliation. ClamAV must be
private, authenticated by network placement, monitored, signature-updated and
capacity-tested. None is provisioned by this ADR.

## Consequences

Positive:

- no document is directly web-addressable;
- owner/RBAC checks and sensitive-read audit always precede bytes;
- storage/scanner vendors can change without contaminating domain logic;
- failure modes remain closed and testable;
- PostgreSQL backups contain metadata, not identity-document bytes.

Trade-offs:

- a logical quarantine relies on private storage plus API state, rather than a
  physical bucket move;
- cross-system failure can create an orphan object or a quarantined row that
  needs reconciliation;
- API streaming consumes application bandwidth;
- production readiness depends on external S3/ClamAV provisioning and an
  explicit retention policy.

## Alternatives considered

- **PostgreSQL BYTEA:** rejected because it couples binary volume, backups and
  retention to transactional data and violates the requested storage boundary.
- **Public filesystem/web root:** rejected; URLs bypass ownership, RBAC and
  audit.
- **Permanent or short-lived signed URLs:** not needed for PR-11. Even a short
  URL creates an extra leakage surface and complicates revocation/audit.
- **Separate quarantine and accepted buckets or copy/move:** valid at larger
  scale, but adds non-atomic copies and more orphan modes without improving
  this API-only private read path.
- **Network calls inside a DB transaction:** rejected because slow/failing
  infrastructure would hold locks and still would not create atomicity.
- **MinIO and a full ClamAV daemon in every CI job:** evaluated but not selected
  for this PR. They add images, signature data, startup health and disk/network
  variability. Contract tests exercise the S3 adapter and a TCP clamd protocol
  server exercises the real `INSTREAM` adapter; deterministic integration uses
  LOCAL/TEST. A future infrastructure suite may add pinned private services
  with health checks and cleanup.
