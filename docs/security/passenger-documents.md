# Passenger-document security and privacy

Passenger documents are classified **SENSITIVE_PII**. They contain untrusted
bytes and may contain identity, nationality, age and travel information. This
document covers PR-11's technical controls; it is not a regulatory approval or
retention policy.

## Security review

| Threat                          | Control                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDOR / foreign CUSTOMER         | Every CUSTOMER query joins the passenger's immutable owner; foreign, malformed and unknown references all return 404. Public references are CSPRNG, but secrecy of an id is never the authorization.                                                                                                                                                             |
| Staff overreach                 | Admin routes require an active MFA-backed STAFF session, `ops.access` and `passenger.document.read` from the database on every call. No write/approval route exists.                                                                                                                                                                                             |
| CSRF                            | Cookie-authenticated multipart upload remains behind the existing exact-Origin and session-bound CSRF guards. Multipart is explicitly marked as body-parser bypass, not guard bypass.                                                                                                                                                                            |
| Upload abuse / DoS              | Per-CUSTOMER PostgreSQL-backed rate limit, one bounded streamed file, bounded field/part counts, 10 MiB default/25 MiB hard config maximum, no arbitrary whole-file buffer. Oversized streams are drained safely.                                                                                                                                                |
| MIME confusion / polyglot entry | Extension, declared MIME and magic bytes must agree; only PDF/JPEG/PNG enter storage. Responses use the server MIME plus `nosniff` and attachment disposition. Deep content sanitization is deferred.                                                                                                                                                            |
| Filename/path traversal         | Names with controls, path separators, NUL or extra extensions are rejected. Original names never become paths/keys/log fields. Generated keys match one strict regex; the LOCAL adapter resolves below a dedicated root and rejects symlink roots/shards.                                                                                                        |
| Malware                         | The stored object is streamed to `MalwareScanner`; ClamAV `INSTREAM` invokes no shell. Malware, timeout, unavailable scanner and invalid response never accept the row. An idle timeout destroys both the socket and the source stream, so a clamd that stops reading or a stalled object cannot hang an upload. Tests use only a harmless marker/protocol stub. |
| Malformed multipart             | A truncated or malformed body is answered 422 without an uncaught stream error (a listener is attached to every file part before any await), so a crafted body cannot stop the API process.                                                                                                                                                                      |
| Quarantine bypass               | PostgreSQL permits only `QUARANTINED → ACCEPTED                                                                                                                                                                                                                                                                                                                  | REJECTED`; download queries require `ACCEPTED`. Rejected/quarantined/unknown are indistinguishable as 404 to a CUSTOMER. |
| Storage exposure                | No public ACL, public path, object key, endpoint or signed URL is returned. LOCAL is outside public roots with 0700/0600 permissions; deployed LOCAL is refused. Production bucket policy remains a prerequisite, not an assumption.                                                                                                                             |
| Cache/content sniffing          | Downloads set `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, validated `Content-Type`, exact length and opaque attachment filename.                                                                                                                                                                                                      |
| Integrity                       | SHA-256 is computed during upload and recomputed from the stored stream before acceptance; stored size must agree. Digest and object key are immutable and unique. No cross-passenger deduplication occurs.                                                                                                                                                      |
| Audit leakage                   | Sensitive list/metadata/content reads and lifecycle changes are audited, but bytes, original filename, SHA, object key, raw scanner result and credentials are excluded from API/audit. Logs use stable codes and references only.                                                                                                                               |
| Secret leakage                  | S3 credentials are server-only validated environment values; no `NEXT_PUBLIC_` variable, API response or committed real value carries them.                                                                                                                                                                                                                      |
| Cross-system failure            | No network call holds a DB transaction. Unknown results stay inaccessible; best-effort cleanup and explicit reconciliation handle orphans.                                                                                                                                                                                                                       |

## Ownership and permissions

A CUSTOMER can add a passenger only to their own confirmed/non-cancelled
booking, up to its seat count, then list/upload/download only through that
passenger's immutable owner. Sharing a passenger between bookings is allowed
only when both bookings have that same owner; each association independently
obeys capacity and confirmation rules.

The narrow STAFF permission `passenger.document.read` is assigned to
`SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER` and `COMPLIANCE_AGENT`. It permits
metadata/detail and accepted-content reads. It does not imply regulatory
review. `BOOKING_AGENT`, `CUSTOMER_SUPPORT`, `FINANCE`, `AUDITOR` and
`DISPATCHER` do not receive it by default.

## Sensitive-read audit

Every STAFF or CUSTOMER read of document data leaves a
`PASSENGER_DOCUMENT_ACCESSED` trace written before the response:

- `access=LIST`: one event per STAFF list page (not per row), with the exact
  document references shown and the filters used. A page names passengers next
  to their document types, so it is as sensitive as a detail view;
- `access=METADATA`: STAFF detail view;
- `access=CONTENT`: CUSTOMER or STAFF byte download, written before the stream
  is returned.

An audit failure fails the request (and destroys a prepared stream), so no
data leaves without its trace. Audit rows contain references, filters and the
access kind only.

Upload rejections use normalized codes only. Raw multipart values, file bytes,
ClamAV response text and storage errors are never written to the audit trail.

Upload rejections use normalized codes only. Raw multipart values, file bytes,
ClamAV response text and storage errors are never written to the audit trail.

## Privacy review

- **Purpose:** attach a traveller's supplied identity/travel file to a paid,
  confirmed journey for future compliance work.
- **Minimization:** name, birth date, nationality, declared document type and
  optional expiry are the only PR-11 passenger fields. No document number,
  place of birth, gender, address, OCR/MRZ/biometric extraction or original
  filename is captured.
- **Access:** owner CUSTOMER and four explicit STAFF roles only; private API
  streaming with audit, no public/signed URL.
- **Retention/deletion:** intentionally unresolved. Database history is
  immutable in PR-11 and objects must not be bulk-deleted until a reviewed
  retention/legal-hold design exists. The model keeps bytes outside the DB so
  a future erasure workflow can remove/replace object content without a schema
  rewrite.
- **Environments:** test/browser fixtures are synthetic. No production fixture,
  bucket, scanner or data is created by PR-11.
- **Logs:** no document content, document number, original filename, object key
  or digest.

## Residual risks and limits

**TECHNICALLY_ACCEPTED != REGULATORY_VALID.** Magic bytes and malware
scanning do not prove that a PDF/image is benign,
authentic or legally valid. PR-11 has no content-disarm/reconstruction,
password-protected PDF handling, OCR, MRZ, country-specific rule, expiry
decision, human approval, retention scheduler, legal hold, customer erasure,
production S3 policy or production ClamAV service. These limits must remain
visible in product text. **PR-12 owns Compliance / regulatory validation.**

Further measured limits:

- the ClamAV timeout is an idle timeout (no byte exchanged for
  `CLAMAV_TIMEOUT_MS`); a scanner that keeps trickling data is bounded by the
  upload size, not by a total deadline;
- the original filename is validated (UTF-8, no controls, separators, line or
  paragraph separators, path characters or double extension) and then
  discarded; look-alike characters such as `∕` or `／` are inert because no
  name ever becomes a path, key, row, audit or log field;
- the upload is staged in an owner-only temporary file before private
  storage, so the API host needs local temporary space for in-flight uploads
  (bounded by the per-file limit and the per-CUSTOMER rate limit);
- a QUARANTINED row whose acceptance transaction failed, or a REJECTED row
  whose compensating delete failed, keeps a private object until the
  reconciliation runbook is applied; neither is ever downloadable;
- LOCAL root checks are textual (absolute, normalized, not `/`, no public or
  upload segment) plus symlink refusal for the root and fixed key
  directories. Symlinks above the configured root are not inspected; LOCAL is
  refused in staging and production.

Operational anomalies follow the
[storage reconciliation runbook](../runbooks/passenger-document-storage-reconciliation.md).
