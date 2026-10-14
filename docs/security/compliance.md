# Compliance security and privacy

Passenger compliance data is **SENSITIVE_PII**. It combines identity
(nationality, age), a concrete journey (countries, dates) and decisions about
a person. Rule provenance is legally significant. This document covers PR-12's
technical controls. It is not legal advice, and the software is not a legal
authority (**CODE_IS_NOT_LEGAL_AUTHORITY**).

## Security review

| Threat                               | Control                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDOR (customer)                      | Every CUSTOMER query joins the booking and passenger owners. Foreign, unknown and mismatched booking/passenger pairs get the same 404 body. Customers have no evaluation or review route by evaluation reference.                                                                                         |
| RBAC / privilege escalation          | Deny-by-default guard; `compliance.read`, `compliance.review`, `compliance.rule.read` and `compliance.rule.manage` are separate grants read from PostgreSQL on every request. `booking.read`, `payment.read` or `passenger.document.read` never imply them (RBAC matrix and per-role HTTP tests).         |
| Rule publication bypass              | Publication is a dedicated operation that reads the locked row. A client status or verification field is rejected by strict schemas. PostgreSQL refuses `PUBLISHED`/`RETIRED` without `VERIFIED` and refuses publishing a changed draft.                                                                  |
| Unverified rule                      | Verification needs complete provenance (authority, title, https URL or official reference), a past check date and the exact digest read. Any later content change drops it (trigger), and the verified digest must equal the current one (CHECK).                                                         |
| Historical tampering                 | Published and retired versions, evaluations, results, evidence and reviews are immutable. Rows are never deleted or truncated (triggers). Corrections are new versions, evaluations or reviews.                                                                                                           |
| Stale review reuse                   | Reviews are allowed only on the latest evaluation (PostgreSQL) and only while it is current (fingerprints, under a row lock). A stale evaluation's reviews are shown as historical and the status becomes `STALE`.                                                                                        |
| Publication race                     | All writes to one rule's versions take the rule row lock first. A forced-overlap test proves an edit and a publication serialize in both orders, and two simultaneous publications yield exactly one.                                                                                                     |
| Review race                          | The API locks the evaluation and checks the reviewer's `previousReviewId`. PostgreSQL keeps a linear chain (one first review, each review superseded at most once). Simultaneous first reviews yield exactly one.                                                                                         |
| Evaluation vs publication/retirement | An evaluation reads the versions in effect, then inserts results whose trigger takes a share lock on each version and refuses one that is no longer PUBLISHED. A retirement waits for an in-flight evaluation (tested). Any later change makes the evaluation stale.                                      |
| Frontend-supplied facts              | Facts come from bookings, trips, waypoints, countries, passengers and ACCEPTED documents in PostgreSQL. The evaluation endpoints take no fact, result or status; extra input is ignored or refused.                                                                                                       |
| Arbitrary expression execution       | The rule language is a closed JSON grammar with a fixed set of node kinds and facts, walked by a pure function. No `eval`, `Function`, dynamic import, SQL fragment or regular expression comes from a rule.                                                                                              |
| Hostile rule JSON                    | Bounded depth, value count and string length are checked iteratively before the grammar runs. Prototype keys are refused. Countries must match `^[A-Z]{2}$` and exist; document types, dates and numbers are checked. Tested with unknown operators and facts, 100,000-deep nesting and oversized values. |
| Stored XSS                           | Titles, guidance, source fields, retirement reasons and customer messages are plain text: `<`, `>` and control characters are refused by the API and by CHECK constraints. The UIs render text only (React escaping).                                                                                     |
| Source URL                           | Only `https://` without credentials or whitespace is accepted (API and CHECK). The OPS link uses `rel="noopener noreferrer nofollow"` and is rendered only for https.                                                                                                                                     |
| PII exposure                         | Facts snapshots hold countries, age, document references, types and expiry only. Customer views never include reviewer identities, internal reasons, sources, notes, fingerprints or ids. Responses use `Cache-Control: no-store`.                                                                        |
| Audit failure                        | Every lifecycle change and every STAFF compliance read writes its audit event in the same transaction, before the response; an audit failure fails the request.                                                                                                                                           |
| Pagination abuse                     | Keyset pagination with bounded limits (rules ≤ 100, queue ≤ 50). The derived-status queue filter scans at most 200 rows per request and resumes with an opaque cursor.                                                                                                                                    |
| Rate limiting                        | Customer evaluations are limited to 30 per hour per identity (opaque PostgreSQL bucket). STAFF routes are authenticated, MFA-backed and permission-checked.                                                                                                                                               |

## Permissions and least privilege

| Permission               | Grants                                                       | Rationale                                                                                                        |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `compliance.read`        | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `COMPLIANCE_AGENT` | The roles that already read passenger documents (PR-11); operations oversight needs the status.                  |
| `compliance.review`      | `SUPER_ADMIN`, `DIRECTOR`, `COMPLIANCE_AGENT`                | Deciding about a person is narrower than reading: `OPS_MANAGER` reads but does not decide.                       |
| `compliance.rule.read`   | `SUPER_ADMIN`, `DIRECTOR`, `COMPLIANCE_AGENT`, `AUDITOR`     | Reviewers must understand applied rules; auditors check provenance (rules contain no PII).                       |
| `compliance.rule.manage` | `SUPER_ADMIN`, `DIRECTOR`                                    | Publishing a legal rule is more restrictive than reviewing a file (existing `DIRECTOR` = all except privileged). |

`BOOKING_AGENT`, `CUSTOMER_SUPPORT`, `FINANCE` and `DISPATCHER` receive none.
`AUDITOR` does not read passenger compliance (no PII grant, consistent with
PR-11). There is no four-eyes rule between verification and publication in
PR-12. A deployment that needs one can add it later as a separate control.

## Audit

The audit actions are:

- rule lifecycle: `COMPLIANCE_RULE_CREATED`, `COMPLIANCE_RULE_VERSION_CREATED`,
  `COMPLIANCE_RULE_VERSION_UPDATED`, `COMPLIANCE_RULE_VERIFIED`,
  `COMPLIANCE_RULE_PUBLISHED` and `COMPLIANCE_RULE_RETIRED`;
- passenger compliance: `COMPLIANCE_EVALUATED`, `COMPLIANCE_ACCESSED`
  (`LIST`, one per queue page, or `DETAIL`) and `COMPLIANCE_REVIEWED`.

Events carry stable references (rule `ETCR-…` with version, evaluation
`ETCE-…`, `ETB-…/ETV-…` subjects), digests, results, finding codes and
decisions.

They never carry document bytes, object keys, file digests, names, birth
dates, the internal review reason or credentials.

## Privacy review

- **Purpose:** decide, for a confirmed journey, whether a passenger meets
  verified published rules, and record the human decisions when needed.
- **Minimization:**
  - facts snapshot: countries, age on the travel date, document references,
    types and declared expiry;
  - no name, birth date, document number, OCR or biometrics;
  - rules contain no personal data.
- **Access:**
  - the customer sees only their own passengers;
  - STAFF need explicit grants, and every detail read and queue page is
    audited;
  - documents are opened only through the PR-11 secure, audited route
    (`passenger.document.read`).
- **Retention:** evaluation and review history is immutable in PR-12. The
  retention or erasure policy remains an open decision shared with PR-11. No
  automatic deletion exists.
- **Environments:** synthetic data only in tests and browser runs. No
  production rule, evaluation or document is created.

## Residual limits

- **Declared metadata:** the machine relies on declared document types and
  expiry dates of technically accepted files. It does not read document
  content. Use `humanCheck` or `HUMAN_REVIEW` in a rule when a person must
  confirm.
- **Coverage is explicit by country.** A rule naming no country covers
  nothing, so global rules alone always lead to review.
- **Version selection:** precedence is "highest published version in effect
  on the travel date". Retiring a newer version lets an older still-published
  version apply again. Repealing a rule from a date requires publishing a
  version that says so.
- **Staleness is computed at read time.** Queue pages pay a bounded cost
  (≤ 200 rows scanned).
- **Arrival date:** when time zones make the arrival's local date earlier than
  the departure's, the arrival date is clamped to the travel date.
- **No four-eyes control** between verification and publication yet.
- **Out of scope:** no legal content is maintained by the software. Keeping
  rules current is an operational responsibility. Permits (PR-16) and trip
  readiness (PR-17) are not part of PR-12.
