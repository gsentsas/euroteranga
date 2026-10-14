# ADR-009 — Versioned regulatory rule engine

- Status: Accepted
- Date: 2026-10-14 (PR-12 Compliance)

## Context

Passengers on cross-border journeys may need identity or travel documents.
The applicable obligations depend on several facts:

- the countries entered;
- the passenger's nationality and age;
- the travel date.

These obligations change over time and must be traceable to official sources.

PR-11 established that a technically ACCEPTED file is not a valid document
(**TECHNICALLY_ACCEPTED != REGULATORY_VALID**). Writing obligations in code
would make developers the legal authority, hide provenance and rewrite history
on every change. Treating "no rule found" as compliance would turn ignorance
into authorization.

## Decision

1. **Data, not code.** Requirements are stored as versions of a
   `ComplianceRule`, entered by authorized STAFF from official sources. The
   repository ships no regulatory rule (**CODE_IS_NOT_LEGAL_AUTHORITY**), and
   tests use synthetic rules only.
2. **Lifecycle with provenance.** `DRAFT → PUBLISHED → RETIRED`:
   - verification records the authority, title, https URL or official
     reference, the check date, the verifier and the digest of the exact
     definition;
   - only a verified, unchanged draft can be published, as an explicit
     server-side operation;
   - published versions are immutable;
   - PostgreSQL enforces these rules (CHECKs, triggers, partial unique index).
3. **Travel-date semantics.** Versions carry inclusive effective dates compared
   with the planned travel date. For each rule, the highest-numbered PUBLISHED
   version in effect on that date applies.
4. **Closed, versioned language.** A strict JSON grammar (language 1) with a
   fixed set of scope facts and requirement kinds, bounded depth and size, and
   canonical JSON digests. No expression is executed.
5. **Deterministic engine and fail-closed coverage.** A pure function of
   server-derived facts and rule versions (`compliance-engine/1`). No
   applicable rule, or an entered country without explicit verified coverage,
   is `REVIEW_REQUIRED` (**NO_MATCHING_RULE != COMPLIANT**).
6. **Historical evaluations of a booking passenger.** Evaluations, per-rule
   results and evidence are append-only. They record:
   - the facts and rules fingerprints;
   - the engine version.

   Staleness is recomputed rather than stored, and stale evaluations are
   history.

7. **Human review.** An append-only, reasoned decision on the latest current
   evaluation, as a linear chain enforced by PostgreSQL. It cannot be reused
   once facts or rules change.
8. **Separate permissions.** `compliance.read`, `compliance.review`,
   `compliance.rule.read` and `compliance.rule.manage`. Rule publication is
   narrower than review.

## Consequences

Positive:

- every decision can be explained later: which versions, sources, facts and
  engine;
- rule changes never rewrite past evaluations: they make current ones stale;
- unknown situations surface as review work instead of silent approval;
- the grammar can grow through a new language version without breaking stored
  rules.

Trade-offs:

- someone must enter, verify and keep rules current: the system cannot know
  the law;
- explicit per-country coverage means more review until coverage exists;
- staleness checks cost queries at read time (bounded per page);
- "highest published version" precedence makes repeal an explicit act.

## Alternatives considered

- **Hard-coded requirements in TypeScript:** rejected. They are unverifiable,
  unversioned, and make code the legal authority.
- **A general rule engine or expression language (JSONLogic, CEL, JavaScript
  sandbox):** rejected for PR-12. It enlarges the attack surface and makes
  rules harder to review than a closed grammar. It would also add a
  dependency.
- **Evaluating against "now":** rejected. Obligations apply to the travel
  date.
- **Mutable published rules or a mutable evaluation status column:** rejected.
  They lose history, and a stored stale flag drifts.
- **Treating an ACCEPTED document or an empty rule set as compliant:**
  rejected. It is exactly the confusion PR-11 and PR-12 forbid.
- **Automatic scraping of legal sources:** out of scope. It cannot replace
  verification by a responsible person.
