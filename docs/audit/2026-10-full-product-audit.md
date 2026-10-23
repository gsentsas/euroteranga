# EURO TERANGA — Full product audit (October 2026)

- **Audit date:** 2026-10-18
- **Audited commit:** `main` = `7259e1915d163dd1cf444de1df7b1e1e3d06846c` (PR #51, OPS-3A)
- **Production observed:** `https://euroteranga.com` and its six sub-domains, read-only probes only
- **Scope:** repository, CI, documentation, public production surface. No production write.

This document is the baseline of the "master mission" programme. Every finding
has an identifier, evidence, a criticality and a status. Statuses are updated
by the pull requests that address them, so the document stays the single
source of truth for what is done, planned or blocked.

## Readiness vocabulary

| Level              | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `CODE_READY`       | Implemented and reviewed on `main`.                                                      |
| `CI_READY`         | Covered by the mandatory CI gates (unit, integration, browser where relevant).           |
| `DEPLOY_READY`     | Deployable with the official release script, with configuration documented.              |
| `PILOT_READY`      | Usable by the pilot team with synthetic or explicitly authorized data.                   |
| `PRODUCTION_READY` | Usable with real customers, real money and real documents. **No domain is there today.** |

A green CI never implies `PRODUCTION_READY` on its own.

## Executive summary

The technical platform is broad and well protected. It covers 23 migrations,
three authentication realms, RBAC, an append-only audit trail and every
operational domain from network to reporting. Every domain has server-side
invariants (SQL triggers and constraints) and integration and browser tests.
The CI on `main` is green, CodeQL included.

The product is not yet exploitable as a transport company:

1. **Nothing can be booked in production.** The public API returns no trip,
   in either direction. Only the Paris and Dakar stops exist publicly.
2. **There is no way to initialize data reproducibly.** Every vehicle, seat
   map, route, fare and trip must be typed by hand in OPS. There is no
   reference dataset and no pilot dataset.
3. **The public site is a single hard-coded page.** It has no CMS, no image,
   no legal notice and no privacy policy. `robots.txt` and `sitemap.xml` are
   missing. Indexing cannot be configured, and the advertised price (249 €)
   exists nowhere in Pricing.
4. **Production lags behind `main`.** It runs the code of PR #44 (inferred),
   while `main` has six more merged PRs, OPS-3A included.
5. **External blockers stay closed:**
   - no real payment provider;
   - no private object storage;
   - ClamAV is not installed in production;
   - no off-site backup;
   - no external monitoring.

## Production observations (2026-10-18, read-only)

| Probe                                                 | Result                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| TLS on the 7 hosts                                    | Valid certificates (`ssl_verify_result=0`), `www` → 301                                                                |
| `api.euroteranga.com/health/live` and `/health/ready` | `200 {"status":"ok"}`                                                                                                  |
| systemd                                               | `euroteranga-{api,web,booking,client,tracking,ops,crew}` active since 2026-10-18 10:57:38 UTC; auth purge timer active |
| Deployed release                                      | Not readable from the repository account (`/var/www/vhosts/euroteranga.com` is `drwx--x---`)                           |
| Deployed release (inferred)                           | The OPS bundle contains UI-4B (`ops-pulse`) and not UI-4C (`ops-global-search`): consistent with `e0f2d25` (PR #44)    |
| `GET /v1/booking/stops`                               | Two stops: `PAR` Paris (FR), `DKR` Dakar (SN)                                                                          |
| `GET /v1/booking/trips` PAR → DKR and DKR → PAR       | `{"items":[]}` in both directions                                                                                      |
| `euroteranga.com/robots.txt`, `/sitemap.xml`          | 404                                                                                                                    |
| `tracking.euroteranga.com/robots.txt`                 | 200: the `[token]` route renders the tracking page for any path (soft 404)                                             |
| `euroteranga.com/<unknown>`                           | 404 with the English Next.js default page ("This page could not be found.")                                            |
| `<meta name="robots">`                                | `noindex, nofollow` on all six frontends (hard-coded)                                                                  |
| Security headers                                      | CSP, HSTS (6 months, sub-domains), `X-Frame-Options: DENY`, referrer and permissions policies present                  |

## Architecture

The architecture follows ADR-001: a modular monolith. The Core API is the
only business authority, and the frontends never touch PostgreSQL. The
monorepo contains:

- seven applications (`web`, `booking`, `client`, `tracking`, `ops`, `crew`, `api`);
- five packages (`config`, `logger`, `database`, `ui`, `auth-client`);
- one browser test suite.

Strengths:

- **Responsibilities:** clear module boundaries per domain (one NestJS module
  per domain, with DTOs, errors, views and services).
- **Integrity:** invariants are doubled in SQL (triggers, CHECK constraints,
  composite foreign keys) and in services, with concurrency proofs.
- **Typed client:** one typed client (`@euroteranga/auth-client`) for every
  frontend, so there is no ad-hoc `fetch`.
- **Errors:** stable error codes (`PublicApiError`) and request ids in every
  error body.

Weaknesses:

- **Hard-coded hosts:** the public site and `JourneyShell` (`packages/ui`)
  hard-code the production host names. A local, CI or staging build links to
  production (F-ARCH-01).
- **Marketing content:** all of it is JSX inside the `web` application.
  There is no content domain (F-CMS-01).
- **Scripted mutations:** domain services require an HTTP `AuthPrincipal`
  even though the audit trail already supports system actors. An operator
  CLI therefore cannot reuse the domain rules (F-ARCH-02).

## Existing functionality (verified on `main`)

| Domain                              | API | OPS UI | Customer UI | Tests (unit/int/browser) | Docs |
| ----------------------------------- | --- | ------ | ----------- | ------------------------ | ---- |
| Identity (3 realms, STAFF TOTP MFA) | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| RBAC and audit                      | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Network and versioned routes        | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Fleet                               | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Seat maps                           | ✅  | ✅     | ✅ (seats)  | ✅ ✅ ✅                 | ✅   |
| Pricing                             | ✅  | ✅     | ✅ (fare)   | ✅ ✅ ✅                 | ✅   |
| Trips                               | ✅  | ✅     | ✅ (search) | ✅ ✅ ✅                 | ✅   |
| Booking and holds                   | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Payments (SANDBOX only)             | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Passenger documents                 | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Compliance                          | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Baggage                             | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Check-in and boarding               | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Manifests                           | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Regulatory permits                  | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Departure readiness and dispatch    | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Crew PWA (offline)                  | ✅  | —      | ✅ (Crew)   | ✅ ✅ ✅                 | ✅   |
| Tracking                            | ✅  | ✅     | ✅          | ✅ ✅ ✅                 | ✅   |
| Borders                             | ✅  | ✅     | ✅ (Crew)   | ✅ ✅ ✅                 | ✅   |
| Incidents                           | ✅  | ✅     | ✅ (Crew)   | ✅ ✅ ✅                 | ✅   |
| Finance and refunds                 | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Reporting                           | ✅  | ✅     | —           | ✅ ✅ ✅                 | ✅   |
| Public site                         | —   | —      | ⚠️ 1 page   | — — ✅                   | ❌   |
| CMS and media                       | ❌  | ❌     | ❌          | ❌                       | ❌   |
| SEO                                 | —   | —      | ❌          | ❌                       | ❌   |

## Data

### Inventory

| Category                | What exists                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Reference (real)        | None in the repository. In production, only the `PAR` and `DKR` stops and the FR and SN countries are visible publicly.    |
| Demo / pilot            | Code-ready DATA-1 bootstrap: `pnpm data:bootstrap-pilot`; production remains empty until the owner runs it explicitly.           |
| CI fixtures             | Only in tests: `apps/api/test/support/*`, `tests/browser/global-setup.ts`. They are synthetic and reset per run.           |
| Hard-coded in frontends | Homepage price `249 €` (4 times), production URLs (`apps/web`, `packages/ui/src/journey-shell.tsx`), FAQ and service copy. |

### Missing data for a pilot

- The corridor (France → Spain → Morocco → Mauritania → Senegal) in both
  directions, with countries, checkpoints and published route versions. The
  borders and the ferry crossing are operational checkpoints only, with no
  regulatory claim.
- At least two vehicles with published seat maps.
- Fare tables per direction, in EUR minor units.
- Future trips in both directions, with timetables, vehicle, seat map and
  fare table.
- The tracking configuration of those trips.

_Status update:_ DATA-1/DATA-1B now implements this dataset reproducibly, including
`CHECKPOINT_ONLY` Tracking on every upcoming pilot trip. The production observation above remains
historical fact until the owner explicitly runs the bootstrap with `--confirm-production`.

## Findings

Criticality:

- **P0:** blocks exploitation;
- **P1:** high risk or major business UX;
- **P2:** significant improvement;
- **P3:** polish.

### Product and data

| ID         | Category | Description                                                                                                                   | Evidence                                                                           | Impact                                                                    | Crit. | Solution                                                                                                                          | Effort | Status             | PR            |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------ | ------------- |
| F-DATA-01  | Data     | No bookable trip in production, in either direction                                                                           | Public `GET /v1/booking/trips` returns `[]`                                        | Booking is empty: no search, booking or check-in flow can be demonstrated | P0    | Idempotent pilot bootstrap (2 coaches, seat maps, corridor, fares, trips + Tracking), run by the owner with explicit production confirmation | M      | READY_TO_RUN (owner) | DATA-1, DATA-1B (#105) |
| F-DATA-02  | Data     | Reproducible initialization of reference and pilot data is now implemented                                                     | `apps/api/src/cli/bootstrap-pilot-data.ts`, `apps/api/src/pilot/*`                 | Environments can be initialized repeatably with conflict detection        | P1    | `pnpm data:bootstrap-pilot`: idempotent, audited, dry-run capable, refuses production without `--confirm-production`               | M      | FIXED               | DATA-1, DATA-1B (#105) |
| F-DATA-03  | Data     | Reference, pilot and CI data categories are defined and pilot records are explicitly marked                                    | `pilot-dataset.ts`, `docs/runbooks/pilot-data-bootstrap.md`                       | Pilot/test data can be distinguished from operator data                   | P2    | Keep reserved codes `ET-COACH-*`, `DEMO-*`, `ET-PILOT-*` and the documented data categories                                     | S      | FIXED               | DATA-1, DATA-1B (#105) |
| F-DATA-04  | Pricing  | The homepage advertises `249 €` (4 times) without any fare in Pricing                                                         | `apps/web/app/page.tsx` lines 177, 250, 331 and 347                                | The public site can contradict the API; misleading-price risk             | P1    | Derive "from" prices from the public search API (Pricing is the source of truth), and hide them when there is no bookable trip    | S      | FIXED              | WEB-1         |
| F-TRIP-01  | Trips    | Nothing prevents one vehicle from being scheduled on two trips whose planned windows overlap (no service check, no SQL guard) | `trip.service.ts` `schedule`/`assignVehicle`; PR-06 migration has no overlap check | Double-booked coaches; impossible operations reach Dispatch               | P1    | Refuse overlapping SCHEDULED/IN_PROGRESS windows per vehicle in the API and in PostgreSQL, with a per-vehicle lock                | M      | IMPLEMENTING       | FLEET-1 (#53) |
| F-FLEET-01 | Fleet    | Vehicles have no operational name (only a technical code)                                                                     | `Vehicle` model                                                                    | Teams cannot refer to "Teranga 01" in OPS and dispatch                    | P3    | Optional unique `name`                                                                                                            | S      | IMPLEMENTING       | FLEET-1 (#53) |
| F-ARCH-01  | Config   | Production hosts are hard-coded in the public site and the shared journey shell                                               | `apps/web/app/page.tsx:2-4`, `packages/ui/src/journey-shell.tsx:13-16,56`          | Local, CI and staging pages link to production                            | P1    | Validated public URL configuration (`NEXT_PUBLIC_*_URL`) injected into the shell                                                  | S      | READY_TO_IMPLEMENT | WEB-1         |
| F-ARCH-02  | Arch.    | Operator scripts use explicit system actors without fabricating HTTP sessions                                                  | `auth-principal.ts`, DATA-1 bootstrap and audit metadata                              | CLI mutations reuse domain rules while remaining distinguishable in audit | P2    | Keep `SystemActor` / `SystemOperatorActor` paths audited with `actor_identity_id = NULL` and `systemActor` metadata               | S      | FIXED               | DATA-1, DATA-1B (#105) |

### Public site, content and SEO

| ID       | Category | Description                                                                                                                                                                   | Evidence                                       | Impact                                                                                                   | Crit.           | Solution                                                                                                                              | Effort | Status                                             | PR                  |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- | ------------------- |
| F-WEB-01 | Legal    | No legal notice and no privacy policy, although the platform collects accounts, passengers and identity documents                                                             | No route or page; grep finds nothing           | Required in France (legal notice, LCEN art. 6-III) and in the EU (GDPR art. 13) before any real customer | P0 (production) | Structured pages and settings in the CMS. Legal values stay `OWNER_INPUT_REQUIRED` until the owner provides them; nothing is invented | M      | BLOCKED_EXTERNAL (values) / READY (pages)          | WEB-2               |
| F-WEB-02 | Content  | The public site is a single page: no Paris → Dakar or Dakar → Paris page, no "Our coaches", baggage, how it works, FAQ, about or contact page                                 | `apps/web/app` has one `page.tsx`              | The company is not credible; no landing pages for search                                                 | P1              | CMS-driven pages                                                                                                                      | L      | READY_TO_IMPLEMENT                                 | WEB-2               |
| F-CMS-01 | CMS      | No content management: all marketing copy is JSX                                                                                                                              | `apps/web/app/page.tsx` (582 lines)            | Every text change requires a developer and a deployment                                                  | P1              | First-party CMS domain (pages, structured blocks, navigation, settings, versions, preview) in Core API + PostgreSQL + OPS             | L      | FIXED                                              | CMS-1, WEB-1, CMS-2 |
| F-MED-01 | Media    | No media library and no image on the public site; no favicon outside Crew                                                                                                     | `git ls-files` (only `apps/crew/public/*.svg`) | The site looks empty; images cannot be replaced without code                                             | P1              | Public media library, separate from private documents; original SVG illustrations; shot list for future photos                        | L      | FIXED (library); real photos: OWNER_INPUT_REQUIRED | MEDIA-1             |
| F-SEO-01 | SEO      | `robots.txt` and `sitemap.xml` answer 404                                                                                                                                     | Production probes                              | Crawlers get no directive and no page list                                                               | P1              | `robots.ts` and `sitemap.ts` per app; private apps disallow everything                                                                | S      | READY_TO_IMPLEMENT                                 | SEO-1               |
| F-SEO-02 | SEO      | `noindex` is hard-coded and cannot be configured; no `metadataBase`, canonical, social image or unique title                                                                  | `apps/web/app/layout.tsx`                      | Indexing cannot be enabled safely at commercial go-live                                                  | P1              | `SEO_INDEXING_ENABLED` (effective only with `APP_ENV=production`, fail-closed), canonical URLs, Open Graph and Twitter images         | S      | READY_TO_IMPLEMENT                                 | SEO-1               |
| F-SEO-03 | SEO      | No structured data                                                                                                                                                            | No `application/ld+json`                       | Weaker search presentation                                                                               | P2              | Organization, WebSite and BreadcrumbList; FAQPage only on the real FAQ page; no review, rating or fictional offer                     | S      | READY_TO_IMPLEMENT                                 | SEO-1               |
| F-SEO-04 | SEO/UX   | The 404 page is the English Next.js default on every frontend                                                                                                                 | `euroteranga.com/<unknown>`                    | An unprofessional dead end, in English                                                                   | P2              | French branded `not-found` pages that link back to the home page and search                                                           | S      | READY_TO_IMPLEMENT                                 | SEO-1               |
| F-SEO-05 | SEO/Sec. | Tracking `[token]` route renders the tracking page for any path (`/robots.txt`, `/sitemap.xml`) and calls the API with it                                                     | `tracking.euroteranga.com/robots.txt` = 200    | Soft 404s; useless API calls with invalid tokens                                                         | P2              | Validate the token shape before rendering (`notFound()`); add `robots.ts` (disallow all)                                              | S      | READY_TO_IMPLEMENT                                 | SEO-1               |
| F-WEB-03 | Copy     | The public copy exposes internal vocabulary ("projection publique contrôlée", "parcours opérationnel", "brouillon interne", "Plateforme pilote") and repeats "pilote" 8 times | `apps/web/app/page.tsx`                        | Reads like an internal tool, not a travel company                                                        | P2              | Traveller-oriented copy managed in the CMS                                                                                            | S      | FIXED                                              | WEB-1               |

### Infrastructure, operations and CI

| ID       | Category | Description                                                                                                                         | Evidence                                                | Impact                                                                                    | Crit. | Solution                                                                                                                   | Effort | Status                                  | PR            |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- | ------------- |
| F-INF-01 | Release  | Production lags behind `main` (`e0f2d25` inferred vs `7259e19`), and the deployed SHA cannot be checked from the repository account | Bundle markers, file permissions                        | UI-4C to UI-4G and OPS-3A are not live; the deployed state cannot be audited without root | P1    | Root runs `deploy-release.sh <sha>` after each merge train; add a root-only release status in the runbook                  | S      | BLOCKED_EXTERNAL (root)                 | —             |
| F-INF-02 | Backup   | No periodic PostgreSQL backup: only pre-migration dumps, on the same host, without rotation or restore rehearsal                    | `deploy-release.sh` (single `pg_dump` before migrating) | Data written between deployments is not backed up; a disk loss loses everything           | P1    | Daily backup timer with retention and restore-check script (repository). The off-site copy needs a storage target          | M      | READY_TO_IMPLEMENT / BLOCKED (off-site) | OPS-4         |
| F-INF-03 | Storage  | Private object storage, the malware scanner and payments are `DISABLED` in production                                               | `docs/runbooks/pilot-deployment.md`                     | Documents and payments cannot be used                                                     | P0    | Provision private S3 (encryption, policy, backups), install the OPS-3A ClamAV stack, choose a PSP                          | L      | BLOCKED_EXTERNAL                        | OPS-3B, PAY-1 |
| F-OBS-01 | Monitor  | No external uptime monitoring or alerting; logs only in journald; no metrics                                                        | No exporter; runbook "Observability" section            | Outages are discovered by users                                                           | P1    | Operational checklist now; external probe on `/health/ready` once a monitoring provider is chosen                          | S      | BLOCKED_EXTERNAL (provider)             | OPS-4         |
| F-CI-01  | CI       | Branch protection requires 6 checks but not `pilot-acceptance` or CodeQL                                                            | GitHub branch protection API                            | A red aggregate or CodeQL run does not block a merge by itself                            | P2    | Owner adds `pilot-acceptance` and `Analyze (javascript-typescript)` to the required checks                                 | S      | BLOCKED_EXTERNAL (repository admin)     | —             |
| F-CI-03  | CI       | No schema-to-migration drift check: CI deploys migrations but never compares the result with `schema.prisma`                        | `.github/workflows/ci.yml` (database job)               | A model change without its migration, or a constraint name mismatch, would reach `main`   | P2    | `prisma migrate diff --from-config-datasource --to-schema … --exit-code` after the deploy in the `database` job            | S      | FIXED                                   | AUDIT-0       |
| F-CI-02  | Deps     | Dependabot PR #3 (`@types/node` 26) has been open since 2026-10-12, while `engines` pins Node 24                                    | PR list                                                 | Noise; a major version that does not match the runtime                                    | P3    | Ignore semver-major `@types/node` updates in `dependabot.yml`; #3 then becomes obsolete                                    | S      | FIXED                                   | AUDIT-0       |
| F-PAY-01 | Payments | No real payment provider; SANDBOX is refused in production                                                                          | ADR-027, `payment-env.ts`                               | No booking can be confirmed in production                                                 | P0    | Owner chooses a PSP (Stripe, PayDunya, Wave, Orange Money…); the provider abstraction and its contract tests already exist | L      | BLOCKED_EXTERNAL                        | PAY-1         |

### Documentation

| ID       | Category | Description                                                                                                                       | Evidence                      | Impact                                           | Crit. | Solution                                                                  | Effort | Status | PR      |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ | ----- | ------------------------------------------------------------------------- | ------ | ------ | ------- |
| F-DOC-01 | Docs     | The README states "NOT PRODUCTION DEPLOYED", contains literal `\n` sequences, a truncated sentence and broken table rows          | `README.md`                   | Misleading status; broken rendering              | P2    | Rewrite the status and fix the formatting                                 | S      | FIXED  | AUDIT-0 |
| F-DOC-02 | Docs     | The pilot deployment runbook shows escaped backticks (`` \`bash …\` ``), so the commands cannot be copied as rendered             | `pilot-deployment.md`         | Operator error during a deployment               | P2    | Use real code spans and blocks                                            | S      | FIXED  | AUDIT-0 |
| F-DOC-04 | Docs     | Tracking (PR-19) now has a domain document covering visibility, public capabilities, RBAC, Crew provenance and privacy boundaries | `docs/domain/tracking.md`     | Visibility levels and token rules are documented | P2    | `docs/domain/tracking.md`                                                 | S      | FIXED  | DOCS-1  |
| F-DOC-03 | Docs     | The architecture overview still says "Implementation starts in PR-01… No business feature is implemented yet", and stops at PR-16 | `docs/architecture/README.md` | Stale reference document                         | P2    | Update the header, and add a current domain map and the ADR index entries | S      | FIXED  | AUDIT-0 |

## UI and UX

The UI-1 to UI-4 phases redesigned:

- the homepage;
- the customer journey;
- the OPS control centre (dashboard, global search, responsive layout,
  loading, empty and retry states, confirmation of sensitive actions);
- the Crew PWA.

`ui-final.spec.ts` covers a cross-app responsive acceptance. This audit did not
redo a screen-by-screen review of every OPS view. The remaining UX findings
are tracked in UX-1, which reviews every screen with screenshots at desktop
and 400 px.

## Mobile and accessibility

The audit verified the following:

- **Navigation:** skip links (`.et-skip-link`) exist on the public site and
  the journey shell, and `main` is focusable.
- **Landmarks:** they are present.
- **Language:** `lang="fr"` is set.
- **Mobile:** UI-4G proved there is no horizontal overflow on Booking mobile.

Gaps:

- the public FAQ uses `<details>`, which is accessible, but its content is
  not managed anywhere;
- there are no images, so alt text has not been tested yet;
- reduced motion is not checked for the public animations.

An automated check (WCAG A/AA rules in Playwright) is planned with the new
public pages (WEB-2).

## Performance

- The public homepage is a Server Component with no client JavaScript of its
  own; the shared Next.js runtime chunks still load.
- There are no images, so there is no LCP image and no layout-shift risk yet.
- When media arrive (MEDIA-1):
  - the hero gets an explicit priority and fixed ratios;
  - lazy loading applies below the fold;
  - images are served in AVIF and WebP.

  _Status (MEDIA-1):_ done for WebP. Every image has explicit dimensions
  and a `srcset` of 480–2400 px renditions with `sizes` per section. The
  hero image is `fetchpriority="high"` and the others are lazy. AVIF was
  left out: WebP covers the target browsers and AVIF encoding is much
  slower on the pilot server (`docs/domain/media.md`).

- CMS pages are rendered on the server with time-based revalidation, so the
  site does not depend on the API being reachable at build time.

## Security and privacy

No vulnerability was found in this pass. The existing controls are:

- CSP, HSTS and frame denial;
- CSRF on STAFF mutations;
- RBAC with deny by default;
- audit inside the same transaction;
- a gitleaks gate;
- `pnpm audit` gates (one documented exception: `braces`, lint-time only).

New surfaces bring new requirements:

- **CMS content and media:**
  - structured blocks only (no free HTML);
  - text rendered as React text;
  - SVG upload refused;
  - magic-byte MIME checks, size and pixel limits;
  - generated storage names (no user path);
  - permissions `content.*`, `media.*` and `seo.manage`;
  - an audit event for every mutation.
- **Public media:** they must never share storage, keys or URLs with private
  passenger documents.

## Database

Twenty-three migrations are applied in order, and CI deploys them twice.
Gaps:

- **Drift:** the historical PR-14 mismatch (a foreign key named without
  `map:`) is now covered by F-CI-03. After deploying every migration, the CI
  `database` job runs
  `pnpm --filter @euroteranga/database exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
  and fails if the migrated database differs from `schema.prisma`.
- **Data procedures:** there is no reference or pilot data procedure
  (F-DATA-02).
- **Maintenance:** there is no maintenance procedure for growing append-only
  tables (audit, tracking observations). Their retention is a policy
  decision (B5).
- **Orphan models:** no per-table analysis of models without an API or UI
  was done in this pass. Each table belongs to a domain module with an API
  surface and tests.

## CI/CD

The CI jobs `quality`, `database`, `test`, `build`, `browser`, `security`
and `pilot-acceptance` all run, as does CodeQL (security-extended). Actions
are pinned to SHAs and permissions are read-only. No gate uses
`continue-on-error`. See F-CI-01 to F-CI-03.

## Observability

What exists:

- structured JSON logs with redaction;
- request ids;
- minimal health probes (`/health`, `/health/live`, `/health/ready`, the
  latter checking the database);
- journald;
- the daily auth purge timer.

What is missing:

- external uptime probes and alerting;
- disk and PostgreSQL size alerts;
- backup freshness checks;
- monitoring of the Crew offline queue and the scanner.

See F-OBS-01 and F-INF-02.

## Technical debt

- The public site is monolithic JSX (F-CMS-01).
- Production URLs are hard-coded (F-ARCH-01).
- The README and architecture overview had drifted (F-DOC-01 to F-DOC-03).
- No dead code, `TODO`, `FIXME` or stray `console.*` call was found in
  application sources (grep on `apps/` and `packages/`).

## Risks

1. A real customer could be exposed to the site before the legal notice and
   privacy policy exist (F-WEB-01).
2. Data loss without periodic backups (F-INF-02).
3. A misleading displayed price (F-DATA-04).
4. Confusion between pilot data and real operations: pilot records must stay
   clearly marked, and real bookings must stay impossible while payments are
   `DISABLED`.

## Blockers for exploitation (owner input required)

| ID  | Decision or input                                                                                                                                | Blocks                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| B1  | Payment provider (PSP), merchant contract and credentials                                                                                        | Real payments (F-PAY-01)                |
| B2  | Private S3-compatible storage (encryption at rest, bucket policy, credentials, backups, retention)                                               | Passenger documents (F-INF-03)          |
| B3  | Root action: install the ClamAV stack (OPS-3A runbook) and switch `MALWARE_SCANNER`                                                              | Passenger documents                     |
| B4  | Legal identity: company name, legal form, registered address, share capital, registration number (RCS or NINEA), publication director, host, VAT | Legal notice, terms, privacy (F-WEB-01) |
| B5  | Privacy: data controller, DPO or contact, retention periods, processors, transfers outside the EU                                                | Privacy policy                          |
| B6  | Commercial: final fares, terms of carriage and sale, baggage allowance and tariff, timetable                                                     | Public prices, terms, real trips        |
| B7  | Public contact details: email, phone, opening hours, social networks                                                                             | Contact page and footer                 |
| B8  | Monitoring provider and on-call contact                                                                                                          | F-OBS-01                                |
| B9  | Off-site backup target                                                                                                                           | F-INF-02 (off-site part)                |
| B10 | Root deployment of each validated `main` SHA                                                                                                     | F-INF-01                                |
| B11 | Repository admin: add `pilot-acceptance` and CodeQL to the required checks                                                                       | F-CI-01                                 |

## Pull request roadmap

The PRs are ordered by dependency. Each starts from the current `origin/main`
and is merged only when CI and CodeQL are green.

| Order | PR      | Scope                                                                                                                                                      | Depends on     | Blocked?                                                   |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| 1     | AUDIT-0 | This audit; README, runbook and architecture truth; Dependabot ignore for semver-major `@types/node`                                                       | —              | No                                                         |
| 2     | FLEET-1 | Operational vehicle name; refuse overlapping vehicle assignments (API + PostgreSQL); upgrade tests compare with the repository migrations                  | —              | No                                                         |
| 3     | DATA-1  | System actor; `pnpm data:bootstrap-pilot` (reference corridor, 2 coaches, seat maps, routes, fares, future trips, tracking); production guard; tests; docs | —              | No                                                         |
| 4     | SEO-1   | Indexing configuration; robots and sitemap; metadata, canonical and social images; JSON-LD; French 404 pages; tracking soft 404                            | —              | No                                                         |
| 5     | CMS-1   | Content domain: pages, versions (draft, published, history, restore), structured blocks, navigation, site settings, preview, RBAC, audit, public read API  | —              | No                                                         |
| 6     | CMS-2   | OPS "Contenus" area: pages, navigation, settings, SEO, preview, publish and restore                                                                        | CMS-1          | No                                                         |
| 7     | MEDIA-1 | Public media library (validated raster uploads, metadata, usage, replace, archive) and original SVG illustrations                                          | CMS-1          | Storage target for production (local volume for the pilot) |
| 8     | WEB-1   | Homepage rendered from the CMS; API-derived "from" prices; configurable URLs                                                                               | CMS-1, MEDIA-1 | No                                                         |
| 9     | WEB-2   | Public pages (directions, coaches, services, baggage, tracking, how it works, FAQ, about, contact, legal, privacy); accessibility checks                   | WEB-1          | Legal values (B4, B5, B7)                                  |
| 10    | UX-1    | Screen-by-screen fixes across Booking, Client, Tracking, OPS and Crew                                                                                      | —              | No                                                         |
| 11    | OPS-4   | Backup timer, retention, restore check, operational checklist                                                                                              | —              | Off-site target (B9)                                       |
| 12    | OPS-3B  | Private document storage activation                                                                                                                        | B2, B3         | Yes                                                        |
| 13    | PAY-1   | Real PSP adapter                                                                                                                                           | B1             | Yes                                                        |

## Readiness matrix (baseline, 2026-10-18)

| Domain    | Code | UI  | Data | Tests | Docs | Exploitable | Why not                                                                |
| --------- | ---- | --- | ---- | ----- | ---- | ----------- | ---------------------------------------------------------------------- |
| Public    | ⚠️   | ⚠️  | ❌   | ⚠️    | ❌   | ❌          | One hard-coded page, no legal pages (F-WEB-01, F-WEB-02)               |
| CMS       | ❌   | ❌  | ❌   | ❌    | ❌   | ❌          | Does not exist (F-CMS-01)                                              |
| SEO       | ❌   | —   | —    | ❌    | ❌   | ❌          | F-SEO-01 to F-SEO-05                                                   |
| Booking   | ✅   | ✅  | ❌   | ✅    | ✅   | ❌          | No trip in production (F-DATA-01), no PSP (F-PAY-01)                   |
| Client    | ✅   | ✅  | —    | ✅    | ✅   | ⚠️          | Depends on bookings; documents blocked (F-INF-03)                      |
| OPS       | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Usable; production lags behind `main` (F-INF-01)                       |
| Crew      | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Needs trips and assignments                                            |
| Fleet     | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | No vehicle in production (F-DATA-01)                                   |
| Trips     | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | No trip in production (F-DATA-01)                                      |
| Payment   | ⚠️   | ✅  | —    | ✅    | ✅   | ❌          | SANDBOX only (F-PAY-01)                                                |
| Documents | ✅   | ✅  | —    | ✅    | ✅   | ❌          | Storage and scanner disabled (F-INF-03)                                |
| Tracking  | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Needs trips; public availability still depends on configured trip data |
| Finance   | ✅   | ✅  | —    | ✅    | ✅   | ⚠️          | Operational finance only; no statutory accounting                      |
