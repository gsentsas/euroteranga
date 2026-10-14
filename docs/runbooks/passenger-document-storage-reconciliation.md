# Passenger-document storage reconciliation

Use this runbook for a private object-store error, a document stuck in
quarantine, or the warning `OBJECT_DELETE_FAILED`. Passenger documents are
**SENSITIVE_PII**. PR-11 does not install a production store/scanner or an
automatic deletion job.

## Safety rules

- Confirm the environment and incident/change authorization before any
  storage action. Never point local/CI commands at production credentials.
- Keep the bucket/root private. Never copy an object to `public/`, `httpdocs/`,
  `static/`, email, chat, tickets or an analyst laptop.
- Start read-only. Record opaque document reference/object key and normalized
  state only; do not paste bytes, original filenames, hashes, scanner output or
  credentials into logs/tickets.
- Never change a row directly to `ACCEPTED`, and never make a quarantined or
  rejected object downloadable. A scanner outage is not acceptance.
- Never delete an accepted object or an object referenced by any row without a
  separately approved retention/erasure procedure and backup decision.

## Diagnose

1. Confirm API/storage/scanner health and configuration without printing
   secrets. In staging/production, LOCAL/TEST must fail startup; S3 must use
   HTTPS and CLAMAV must have an explicit host.
2. Locate metadata by the opaque public reference using a read-only database
   session:

   ```sql
   SELECT reference, object_key, status, size_bytes, mime_type,
          created_at, accepted_at, rejected_at, failure_code
   FROM passenger_document
   WHERE reference = 'ETD-…';
   ```

3. Check object existence and size with provider metadata (`head`), not by
   opening/rendering it. Compare only to the row. Do not expose endpoint or
   credentials in output.
4. Correlate normalized audit actions and the application request id:
   `PASSENGER_DOCUMENT_UPLOADED`, `…_ACCEPTED`, `…_REJECTED`, `…_ACCESSED`.
   The warning `OBJECT_DELETE_FAILED` identifies a reference but does not prove
   an orphan by itself.

## Classify and contain

| Observation                                 | Classification                   | Immediate action                                                                                      |
| ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `QUARANTINED` row + object                  | interrupted/failed scan          | leave private and inaccessible; restore scanner health; do not manually accept                        |
| `REJECTED` row + object                     | compensating delete failed       | keep private; schedule idempotent delete after verifying exact row/key                                |
| `ACCEPTED` row + missing/wrong-size object  | integrity/availability incident  | keep API fail-closed; investigate store/version/backup; do not substitute a different file            |
| object key with no DB row                   | possible orphan after DB failure | quarantine operationally; prove absence on primary and backups/replicas as required before deletion   |
| DB row + object whose computed hash differs | integrity incident               | stop serving (current size mismatch already fails); preserve evidence privately and escalate security |

If exposure, unauthorized access or integrity loss is suspected, revoke the
affected storage credential, preserve provider/audit logs without document
content, restrict service access, and follow the security incident process.

## Recover or clean up

PR-11 deliberately exposes no operator endpoint that bypasses quarantine.
Until a reviewed recovery worker exists:

- **Stuck quarantine:** keep it inaccessible. A future idempotent job may read
  the same key, verify size/SHA, re-scan, and perform the ordinary guarded
  transition/audit. Direct SQL acceptance is prohibited.
- **Rejected-object residue:** after two-person verification of environment,
  document reference, terminal `REJECTED` state and exact key, retry provider
  deletion. Delete is idempotent. Preserve the immutable DB/audit history.
- **Unreferenced object:** compare a provider inventory with a current primary
  DB key export in a secured workspace. Require a conservative age grace
  period longer than any active upload/scan and a second read immediately
  before deletion. Never use an unbounded recursive delete.
- **Missing accepted object:** restore only the exact bytes whose size and
  SHA-256 match the immutable row. If exact recovery is impossible, keep the
  download unavailable and escalate; do not repurpose the key.

For LOCAL development/CI, remove only the explicit run-specific temporary
root after all processes stop and the disposable database is gone. CI owns
`/tmp/euroteranga-browser-documents` and cleans it at job end. Never use `/`, a
home directory, the repository, `httpdocs`, or an unresolved variable as a
cleanup target.

## Verification and closure

- The key is either absent with no live need, or present with matching row,
  expected size and private policy.
- `QUARANTINED`/`REJECTED` download remains 404; missing/corrupt accepted data
  remains fail-closed rather than partially served.
- CUSTOMER ownership and STAFF permission checks still pass.
- No object URL/bytes/credentials entered logs or incident notes.
- Record the operator decision and request ids outside document metadata; do
  not rewrite the immutable lifecycle/audit rows.

## Deployment and rollback note

The PR-11 migration is additive with no backfill and no repository down
migration. Application rollback comes first. Do not drop the new tables,
permission or object data automatically: older code ignores them, while a
schema rollback could destroy history or orphan private objects. Any later
removal requires a reviewed, data-aware plan after access is disabled and
retention/legal obligations are resolved.
