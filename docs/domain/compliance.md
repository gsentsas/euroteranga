# Passenger regulatory compliance

> Implemented in PR-12. **Not production deployed.**
>
> - **CODE_IS_NOT_LEGAL_AUTHORITY.** The software ships no regulatory rule.
> - **TECHNICALLY_ACCEPTED != REGULATORY_VALID.**
> - **NO_MATCHING_RULE != COMPLIANT.**

PR-12 decides whether one passenger, on one concrete booked journey, satisfies
the regulatory rules that authorized people have entered from official
sources, verified and published. When no verified rule covers the journey, it
says so: the result is "review required", never "compliant".

## Scope and boundaries

PR-12 creates:

- versioned regulatory rules;
- deterministic evaluation of a booking passenger;
- an append-only human review;
- the audit trail;
- the customer compliance summary;
- the OPS rule catalogue and review workspace.

It does **not** create:

- carrier, vehicle or country operating permits (PR-16);
- dispatch authorization or trip readiness (PR-17);
- check-in (PR-14), boarding, baggage (PR-13) or manifests (PR-15);
- OCR, MRZ or document-number extraction, or biometrics;
- automatic legal web scraping.

The source code contains no visa, validity, minor or transit requirement. All
tests use synthetic countries, rules, passengers and documents.

## Rules and versions

| Model                   | Meaning                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ComplianceRule`        | Stable identity: public `ETCR-…` reference (CSPRNG, unambiguous alphabet) and an internal title. Both are immutable, and a rule is never deleted.             |
| `ComplianceRuleVersion` | Numbered version: definition, customer guidance, inclusive effective dates, provenance, verification, publication and retirement. At most one DRAFT per rule. |

Lifecycle: `DRAFT → PUBLISHED → RETIRED`.

- **DRAFT** is the only editable state. Any content change drops its
  verification.
- **Verification** records who checked the cited official source, the date the
  source was consulted, and the SHA-256 of the exact definition that was read.
  It requires an authority, a title and an https URL or an official reference.
  It cannot be dated in the future.
- **Publication** is an explicit operation, decided by the server from the
  locked row. Only a VERIFIED draft can be published, unchanged since
  verification, valid in the rule language and naming existing countries. A
  client-supplied status is refused.
- **PUBLISHED** is immutable. A correction is a new version: the next DRAFT
  copies the latest content.
- **RETIRED** withdraws a version from every future evaluation and keeps it as
  history.

PostgreSQL enforces this with CHECK constraints and triggers:

- PUBLISHED or RETIRED is impossible while UNVERIFIED;
- a verified definition must match its digest;
- published and retired versions cannot be modified;
- no delete and no truncate;
- a partial unique index allows only one draft per rule.

### Effective dates

`effectiveFrom` and `effectiveTo` are inclusive calendar dates compared with the
**planned travel date**, not with the evaluation date. For each rule, the
applicable version is the highest-numbered PUBLISHED version whose interval
contains the travel date.

Two journeys evaluated on the same day can therefore use different versions
(tested). A new version is not "today's rule": it applies to the travel dates
it declares.

## Rule language (version 1)

A definition is strict JSON, validated server-side and never executed: no
`eval`, no dynamic code, no SQL fragment.

```json
{
  "language": 1,
  "scope": {
    "nationalities": ["XA"],
    "originCountries": ["XB"],
    "destinationCountries": ["XC"],
    "transitCountries": ["XD"],
    "minAgeOnTravelDate": 0,
    "maxAgeOnTravelDate": 17
  },
  "requirement": {
    "kind": "ANY_OF",
    "requirements": [
      {
        "kind": "DOCUMENT",
        "documentType": "PASSPORT",
        "minValidity": { "from": "TRAVEL_DATE", "days": 0 }
      },
      { "kind": "DOCUMENT", "documentType": "NATIONAL_ID", "humanCheck": true }
    ]
  }
}
```

(Synthetic example: user-assigned `X?` codes, no real requirement.)

- **Scope:** every key is optional. Country lists use ISO alpha-2 codes that
  must exist in the country catalogue. `transitCountries` matches when at least
  one listed country is crossed. Age bounds are inclusive, computed on the
  travel date.
- **Requirement kinds:** `DOCUMENT`, `ALL_OF`, `ANY_OF`, `HUMAN_REVIEW` (the
  rule says a machine cannot decide) and `NO_DOCUMENT_REQUIRED` (verified
  coverage with no document).
- **`DOCUMENT` options:**
  - `minValidity` asks that the declared expiry be on or after the travel or
    arrival date plus N days. Without it, no expiry is checked: the code never
    assumes a validity rule;
  - `humanCheck` sends a present document to human review.
- **Limits:**
  - raw JSON: depth ≤ 16, ≤ 600 values, strings ≤ 64 characters, plain objects
    only;
  - `__proto__`, `constructor` and `prototype` keys are refused;
  - requirement tree: depth ≤ 4 and ≤ 32 nodes, 2 to 8 children per
    combinator;
  - canonical JSON ≤ 8 KiB.
- **Language versioning:** the grammar is versioned by the `language` field.
  A new grammar is a new language version.

## Evaluation

The unit is a **booking passenger** (`BookingPassenger`), never a person alone:
the same person can be compliant for trip A and not for trip B.

### Facts

Facts are derived from PostgreSQL only; nothing comes from the client.

- **Countries:** the booked segment (`originSequence → destinationSequence`) of
  the trip's route version gives the waypoints (stops and checkpoints) and
  their countries. Consecutive duplicates are collapsed. Origin is the first
  country and destination the last. Transit is the interior of the path, in
  route order.
- **Dates:**
  - `travelDate` is the local calendar date of the planned departure at the
    booked origin stop, in the stop's time zone;
  - `arrivalDate` is the local date at the destination stop, never before
    `travelDate`.
- **Person:** nationality, and age on the travel date.
- **Documents:** the technically ACCEPTED documents (reference, declared type,
  declared expiry). QUARANTINED and REJECTED files are ignored.

The minimized snapshot holds no name, no birth date, no object key, no digest
and no bytes.

### Engine

`compliance-engine/1` is a pure function of facts and rule versions. Same
facts, same versions and same engine give the same result. The steps, per
version in effect on the travel date:

1. **Not relevant:** the journey part of the scope (origin, destination,
   transit) does not match. The version is not recorded.
2. **`NOT_APPLICABLE`:** the journey matches but the person part (nationality,
   age) does not.
3. **Requirement evaluation:** otherwise, the requirement is evaluated in
   three-valued logic. In `ALL_OF`, FAIL wins over REVIEW. In `ANY_OF`, PASS
   wins over REVIEW. A document leaf is `DOCUMENT_PRESENT`, `DOCUMENT_MISSING`,
   `DOCUMENT_VALIDITY_TOO_SHORT`, `DOCUMENT_EXPIRY_UNKNOWN` or
   `DOCUMENT_REQUIRES_HUMAN_CHECK`.

**Coverage.** Each country entered (every transit country and the destination)
must be explicitly named by an applicable rule, as a transit or destination
country respectively. A rule that names no country covers nothing.

- No applicable rule gives `NO_APPLICABLE_RULE`.
- A country without coverage gives `NO_VERIFIED_COVERAGE` for that country.

**Overall result:**

- `FAIL` if any applicable rule fails;
- otherwise `REVIEW_REQUIRED` if any rule asks for review or any coverage
  finding exists;
- otherwise `PASS`.

Hence an empty rule set, or an ACCEPTED passport without verified coverage, is
`REVIEW_REQUIRED` (tested).

### History

`ComplianceEvaluation` is append-only. It records:

- the booking passenger, travel and arrival dates, and evaluation time;
- the engine version;
- the facts snapshot and its fingerprint;
- the rules fingerprint and the overall result;
- evaluation-level findings and the triggering identity.

`ComplianceEvaluationResult` stores, per recorded rule version, the outcome
(`PASS`, `FAIL`, `REVIEW_REQUIRED`, `NOT_APPLICABLE`), a stable reason code
and leaf findings.

`ComplianceEvaluationEvidence` links a result to the ACCEPTED documents
examined.

PostgreSQL enforces that:

- only PUBLISHED versions can be applied (with a share lock, so a concurrent
  retirement waits);
- evidence belongs to the evaluated passenger and is ACCEPTED;
- nothing is updated, deleted or truncated.

### Staleness

There is no `stale` column. A fresh computation rebuilds the facts and the
versions in effect, then compares three things with the evaluation:

- the facts fingerprint (SHA-256 of canonical JSON);
- the rules fingerprint (sorted rule reference, version and definition digest);
- the engine version.

A new document, an expiry change, passenger data changes, a trip timing or
route change, and the publication or retirement of an applicable version all
make the latest evaluation **stale**. A stale evaluation is history. It is
never presented as current compliance.

Evaluating again with nothing changed returns the same evaluation (no
duplicate history row), under the booking-passenger row lock.

## Human review

`ComplianceReview` is an append-only decision on one evaluation:
`COMPLIANT`, `NON_COMPLIANT` or `NEEDS_INFORMATION`.

- **Reason:** an internal reason of 10 to 1,000 characters is mandatory. An
  optional customer message may be added.
- **Who:** an ACTIVE STAFF identity holding `compliance.review`.
- **On what:** only on the latest evaluation of the booking passenger
  (PostgreSQL), and only while it is current (API, under a row lock on the
  evaluation).
- **History:**
  - a later review supersedes exactly one earlier review of the same
    evaluation, through `supersedes_review_id`, which is unique, with one first
    review per evaluation (linear chain enforced by PostgreSQL);
  - the reviewer names the latest review they saw, and a concurrent decision
    returns `409 COMPLIANCE_REVIEW_CONFLICT`.

A review attached to an evaluation that became stale is historical. The
status then shows `STALE`, and a new evaluation and review are needed. There
is no "force OK", bypass or ignore-rule action.

## Status shown to people

| Status                   | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `NOT_EVALUATED`          | No evaluation yet ("À vérifier")                                           |
| `STALE`                  | Facts or rules changed since the latest evaluation ("À vérifier")          |
| `REVIEW_REQUIRED`        | Current machine result needs a human ("Revue en cours")                    |
| `COMPLIANT_BY_RULES`     | Current machine PASS, no review ("Conforme selon les règles publiées")     |
| `NON_COMPLIANT_BY_RULES` | Current machine FAIL, no review ("Non conforme selon les règles publiées") |
| `COMPLIANT`              | Latest review of the current evaluation ("Conforme après revue")           |
| `NON_COMPLIANT`          | Latest review of the current evaluation                                    |
| `NEEDS_INFORMATION`      | Latest review of the current evaluation                                    |

A machine PASS relies on document types and expiry dates declared with
technically accepted files. A rule can require a human check of a document
(`humanCheck`) when that is not enough.

## API surfaces

CUSTOMER routes, under `/v1/booking`:

- `GET /bookings/:bookingReference/compliance`: current status per passenger
  of an owned booking, with requirements, findings and the documents examined.
  It has no side effect.
- `POST /bookings/:bookingReference/passengers/:passengerReference/compliance-evaluations`:
  evaluation with CSRF, rate-limited to 30 per hour per identity, deduplicated.

Customers never see internal reasons, reviewer identities, rule sources or
notes, fingerprints or ids. A foreign or unknown booking or passenger gets the
same 404.

STAFF routes, under `/v1/admin/compliance`:

- `GET /booking-passengers` and `GET /evaluations/:reference` require
  `compliance.read`. Both are audited.
- `POST /evaluations` and `POST /evaluations/:reference/reviews` require
  `compliance.review` and CSRF.
- `GET /rules` and `GET /rules/:reference` require `compliance.rule.read`.
- `POST /rules`, `/rules/:reference/versions`, `…/versions/:n`, `…/verify`,
  `…/publish` and `…/retire` require `compliance.rule.manage` and CSRF.

## Migration

```text
FORWARD=Additive: 5 enums, 6 tables, indexes, FKs, CHECKs, 2 partial unique indexes, 6 guard/append-only triggers (7 functions), 6 no-truncate triggers, 4 permissions and 13 grants.
BACKWARD=No down migration by repository policy; roll the application back first; the tables are history and must not be dropped automatically.
LOCK_RISK=Low: new tables only; FKs reference booking_passenger, passenger_document and auth_identity briefly; RBAC catalogue inserts.
DATA_RISK=None for existing rows (proven by the PR-11 -> PR-12 upgrade test with full-row snapshots).
BACKFILL=NO (no evaluation, rule or review is created).
```
