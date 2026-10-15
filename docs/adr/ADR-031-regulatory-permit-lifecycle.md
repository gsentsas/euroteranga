# ADR-031 — Regulatory permit lifecycle and intrinsic validity

- Status: Accepted
- Date: 2026-10-15 (PR-16 Regulatory Permits)

## Context

Operations need to record the authorizations under which the transport
operator works and make those facts available to the future departure
readiness domain. The repository already has passenger-document technical
acceptance (PR-11), passenger regulatory compliance (PR-12), operational
boarding credentials (PR-14) and immutable passenger manifests (PR-15).
None of those concepts is an operational permit.

A permit also cannot be treated as a departure approval. Whether a trip has
all the permits it needs depends on requirements and operational facts that
PR-16 neither invents nor evaluates. Hard-coding real permit types or corridor
law would make the source code a legal authority and would hide provenance.

## Decision

1. **A permit is a first-class record, not a file.** `RegulatoryPermit`
   records a type code, human title, issuing authority, optional authority
   reference and jurisdiction, an inclusive validity interval, provenance and
   one explicit business scope. PR-16 stores no permit bytes and adds no
   document permission. Technical acceptance of any file is not regulatory
   validity.
2. **One permit has one referentially constrained scope.** The supported
   scopes are the current single `OPERATOR`, a `COUNTRY`, a `VEHICLE`, a
   historical `ROUTE_VERSION`, or a `TRIP`. A PostgreSQL exact-one-of CHECK and
   explicit foreign keys replace a free `resourceType + resourceId` pair.
   Jurisdiction is separate from the resource to which the permit applies.
3. **Permit content is data-driven.** `permitType` is a bounded normalized
   code; no real permit type, legal requirement, corridor rule or authority
   reference is seeded. A route-version scope is historical and does not move
   when a new route version is published.
4. **The lifecycle is small and irreversible.** Every record starts at
   revision 1 in `DRAFT`; only drafts are editable. Activation performs
   `DRAFT → ACTIVE` without changing content. Revocation performs
   `ACTIVE → REVOKED`, requires a reason and is terminal. Every mutation
   increments an optimistic revision. Update, delete and truncate guards,
   lifecycle CHECKs and ACTIVE STAFF actor checks apply to every database
   writer.
5. **Expiration is derived, not stored as lifecycle.** The pure validity
   function receives an explicit calendar day and returns `DRAFT`,
   `NOT_YET_VALID`, `VALID`, `EXPIRED` or `REVOKED`. Dates are inclusive;
   lifecycle takes precedence over dates. The API obtains its evaluation day
   from PostgreSQL and returns both that day and the derived state. The browser
   never decides validity.
6. **Validity is bounded in PR-16.** `validUntil` is required. There is no
   trusted permit-type catalogue able to declare that a type may be
   open-ended, so allowing a null end date would turn an unverified convention
   into policy. A future data-driven catalogue may change this through an
   explicit migration.
7. **History is the transactional audit trail.** Create, update, activate and
   revoke operations write minimized before/after facts in the same
   transaction. List and detail reads are audited before return. Notes,
   source URLs, internal identifiers and document data are not copied into
   audit snapshots. A permit row is never physically removed.
8. **Access stays server-authoritative.** `permit.read` reads the OPS catalogue;
   `permit.manage` creates, edits, activates and revokes. CSRF and STAFF-origin
   checks protect every mutation. The OPS permission check only controls
   presentation; the API re-authorizes each request.

The public reference is `ETRP-` followed by 12 CSPRNG Crockford Base32
characters. The proposed `ETP-` namespace is not used because PR-10 already
uses it for payment references.

## Consequences

Positive:

- PR-17 can consume stable, scoped permit facts without inheriting a departure
  decision from PR-16;
- PostgreSQL prevents orphaned or ambiguous scope targets and destructive
  lifecycle rewrites;
- the same pure function can be tested on boundary dates without a process
  clock;
- no public object, permanent bearer URL or duplicate document store is
  introduced.

Trade-offs:

- PR-16 does not know which permit types are required for a trip or whether
  the recorded set is complete;
- the current operator scope is an intentional singleton until an operator
  model exists;
- one record cannot cover several scopes; separate records preserve explicit
  foreign-key integrity;
- permits without an authority reference cannot be safely deduplicated and
  are therefore allowed to coexist.

## Boundary

**PERMIT_VALID != TRIP_READY. PR-17 owns departure readiness / dispatch
authorization.** A `VALID` result says only that one ACTIVE permit is within
its own inclusive date interval on the server-supplied evaluation day.

Furthermore:

- **PassengerManifest != permit.** A manifest is a historical passenger
  snapshot, not an operating authorization.
- **PassengerCompliance != operational permit.** PR-12 evaluates a passenger
  against published passenger rules; PR-16 records operator-side permits.
- **Technical document acceptance != regulatory validity.** A scanned and
  technically accepted file cannot activate a permit or prove its intrinsic
  validity.

PR-16 creates no `READY`, `APPROVED_FOR_DEPARTURE` or `DISPATCHED` state, no
global checklist and no departure endpoint.

## Alternatives considered

- **Treat a passenger document or manifest as a permit:** rejected because it
  conflates technical evidence or passenger history with an operational
  authorization.
- **A polymorphic `resourceType/resourceId` scope:** rejected because
  PostgreSQL could not enforce the target foreign key.
- **Scope a permit to a stable Route:** rejected because a permit applying to
  concrete geography must retain the historical route version.
- **Store `EXPIRED` as a lifecycle status:** rejected because the value would
  drift with the calendar and require a background writer.
- **Infer readiness from active permits:** rejected because intrinsic validity
  does not establish applicability, completeness or any other departure gate.
- **Reuse private passenger-document storage:** rejected for PR-16 because no
  file is required by the model. Adding evidence later requires an explicit
  private-storage, authorization and retention design.
