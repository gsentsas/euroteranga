# ADR-034 — First-party structured CMS

- Status: Accepted
- Date: 2026-10-18 (CMS-1)

## Context

The public website was a single JSX page: changing a sentence needed a
developer and a release. The site must become administrable, with:

- pages, navigation and settings;
- a draft, a publication and a history;
- a preview;
- dedicated permissions and an audit trail.

All of this must keep the security level of the platform. The platform
already has a Core API with RBAC, audit and PostgreSQL invariants, and an
OPS back-office.

## Decision

1. **First-party CMS** in the Core API, PostgreSQL and OPS, rather than an
   external headless CMS. Reasons:
   - it reuses identities, MFA, RBAC, audit, CSP and deployment;
   - there is no new vendor, cost or data processor;
   - nothing leaves the infrastructure.
2. **Generic entries and revisions.** `ContentEntry` covers pages and two
   singletons, settings and navigation. `ContentRevision` carries
   `DRAFT`, `PUBLISHED` and `SUPERSEDED`. One draft/publish/history/restore
   mechanism serves every kind.
3. **Structured blocks instead of HTML.** A closed, versioned set of blocks
   and a minimal rich-text tree are validated by a shared package
   (`@euroteranga/content`). This removes stored XSS by construction and
   keeps the rendering consistent.
4. **Pricing stays the source of truth for fares.** The CMS has no price
   field; marketing blocks display prices read from Pricing.
5. **Owner information is nullable**, never invented.
6. **SEO metadata is a separate grant** (`seo.manage`), and new pages start
   non-indexable.

## Consequences

Positive:

- editors work without developers;
- every change is reversible (restore) and attributable (audit);
- drafts are invisible to the public;
- the content model is testable, and shared by the API, OPS and the website.

Trade-offs:

- new block types need a code change, which is deliberate;
- there is no real-time co-editing: optimistic concurrency refuses stale
  edits instead;
- discarded drafts are not kept (only their audit fingerprint).

## Alternatives considered

| Alternative                           | Rejected because                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| External headless CMS (SaaS)          | New vendor, contract and personal-data processor; a second identity and permission system; network dependency for every page. |
| Self-hosted CMS (another service)     | A second application to secure, patch, back up and monitor, with its own users.                                               |
| Free HTML or Markdown with sanitizing | Larger attack surface and inconsistent rendering; sanitizers must follow every browser change.                                |
| Prices in the CMS                     | A second source of truth able to contradict Booking.                                                                          |
