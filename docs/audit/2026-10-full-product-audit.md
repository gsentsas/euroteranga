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
| Demo / pilot            | Code-ready DATA-1 bootstrap: `pnpm data:bootstrap-pilot`; production remains empty until the owner runs it explicitly.     |
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

| ID         | Category | Description                                                                                        | Evidence                                                                       | Impact                                                                    | Crit. | Solution                                                                                                                                     | Effort | Status               | PR                     |
| ---------- | -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- | ---------------------- |
| F-DATA-01  | Data     | No bookable trip in production, in either direction                                                | Public `GET /v1/booking/trips` returns `[]`                                    | Booking is empty: no search, booking or check-in flow can be demonstrated | P0    | Idempotent pilot bootstrap (2 coaches, seat maps, corridor, fares, trips + Tracking), run by the owner with explicit production confirmation | M      | READY_TO_RUN (owner) | DATA-1, DATA-1B (#105) |
| F-DATA-02  | Data     | Reproducible initialization of reference and pilot data is now implemented                         | `apps/api/src/cli/bootstrap-pilot-data.ts`, `apps/api/src/pilot/*`             | Environments can be initialized repeatably with conflict detection        | P1    | `pnpm data:bootstrap-pilot`: idempotent, audited, dry-run capable, refuses production without `--confirm-production`                         | M      | FIXED                | DATA-1, DATA-1B (#105) |
| F-DATA-03  | Data     | Reference, pilot and CI data categories are defined and pilot records are explicitly marked        | `pilot-dataset.ts`, `docs/runbooks/pilot-data-bootstrap.md`                    | Pilot/test data can be distinguished from operator data                   | P2    | Keep reserved codes `ET-COACH-*`, `DEMO-*`, `ET-PILOT-*` and the documented data categories                                                  | S      | FIXED                | DATA-1, DATA-1B (#105) |
| F-DATA-04  | Pricing  | The homepage advertises `249 €` (4 times) without any fare in Pricing                              | `apps/web/app/page.tsx` lines 177, 250, 331 and 347                            | The public site can contradict the API; misleading-price risk             | P1    | Derive "from" prices from the public search API (Pricing is the source of truth), and hide them when there is no bookable trip               | S      | FIXED                | WEB-1                  |
| F-TRIP-01  | Trips    | Overlapping SCHEDULED/IN_PROGRESS vehicle assignments are refused by the service and PostgreSQL    | FLEET-1 #53; availability migration + concurrency tests                        | Double-booked coaches are blocked by API and database concurrency guards  | P1    | Keep half-open windows, per-vehicle advisory locking and the SQL backstop covered by integration tests                                       | M      | FIXED                | FLEET-1 (#53)          |
| F-FLEET-01 | Fleet    | Vehicles support an optional unique operational name in API, OPS and trip projections              | FLEET-1 #53; `vehicle.name` + OPS/browser coverage                             | Teams can use coach names while legacy unnamed rows remain valid          | P3    | Keep the normalized optional unique name; pilot bootstrap supplies the Teranga coach labels                                                  | S      | FIXED                | FLEET-1 (#53)          |
| F-ARCH-01  | Config   | Public site and JourneyShell application links are supplied by validated environment configuration | `apps/web/lib/content.ts`, `public-env.ts`, `journey-shell.tsx`, CI/Plesk envs | Local, CI, staging and production keep their own navigation destinations  | P1    | Keep `PUBLIC_*_URL` / `NEXT_PUBLIC_*_URL` explicit and fail-fast; never reintroduce production URL fallbacks                                 | S      | FIXED                | WEB-1, ARCH-1B (#113)  |
| F-ARCH-02  | Arch.    | Operator scripts use explicit system actors without fabricating HTTP sessions                      | `auth-principal.ts`, DATA-1 bootstrap and audit metadata                       | CLI mutations reuse domain rules while remaining distinguishable in audit | P2    | Keep `SystemActor` / `SystemOperatorActor` paths audited with `actor_identity_id = NULL` and `systemActor` metadata                          | S      | FIXED                | DATA-1, DATA-1B (#105) |

### Public site, content and SEO

| ID       | Category | Description                                                                                                                                                                   | Evidence                                       | Impact                                                                                                   | Crit.           | Solution                                                                                                                              | Effort | Status                                             | PR                  |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- | ------------------- |
| F-WEB-01 | Legal    | No legal notice and no privacy policy, although the platform collects accounts, passengers and identity documents                                                             | No route or page; grep finds nothing           | Required in France (legal notice, LCEN art. 6-III) and in the EU (GDPR art. 13) before any real customer | P0 (production) | Structured pages and settings in the CMS. Legal values stay `OWNER_INPUT_REQUIRED` until the owner provides them; nothing is invented | M      | BLOCKED_EXTERNAL (values) / READY (pages)          | WEB-2               |
| F-WEB-02 | Content  | Paris → Dakar, Dakar → Paris, Nos bus and Services are delivered; FAQ, About, Contact, Legal and Privacy remain incomplete                                                    | `PAGE_TEMPLATES`; `web-pages.spec.ts`          | Core landing pages exist, but trust, contact and legal coverage remains incomplete                       | P1              | Finish the remaining WEB-2 pages; owner/legal/contact values must stay explicit and must never be invented                            | L      | PARTIAL                                            | UI-PUBLIC-2 (#70)   |
| F-CMS-01 | CMS      | No content management: all marketing copy is JSX                                                                                                                              | `apps/web/app/page.tsx` (582 lines)            | Every text change requires a developer and a deployment                                                  | P1              | First-party CMS domain (pages, structured blocks, navigation, settings, versions, preview) in Core API + PostgreSQL + OPS             | L      | FIXED                                              | CMS-1, WEB-1, CMS-2 |
| F-MED-01 | Media    | No media library and no image on the public site; no favicon outside Crew                                                                                                     | `git ls-files` (only `apps/crew/public/*.svg`) | The site looks empty; images cannot be replaced without code                                             | P1              | Public media library, separate from private documents; original SVG illustrations; shot list for future photos                        | L      | FIXED (library); real photos: OWNER_INPUT_REQUIRED | MEDIA-1             |
| F-SEO-01 | SEO      | Public robots and sitemap routes exist; private applications disallow crawling                                                                                                | `robots.ts`, `sitemap.ts`, SEO-1 #55           | Crawler directives and the public page list are explicit and fail closed                                 | P1              | Keep public indexing gated by production configuration and private applications permanently disallowed                                | S      | FIXED                                              | SEO-1 (#55)         |
| F-SEO-02 | SEO      | Indexing is configurable fail-closed with metadataBase, canonical metadata, Open Graph and Twitter images                                                                     | `seo.ts`; `apps/web/app/layout.tsx`            | Commercial indexing can be enabled deliberately without making staging indexable                         | P1              | Require production plus `SEO_INDEXING_ENABLED=true`; keep HTTPS canonical origin validation                                           | S      | FIXED                                              | SEO-1 (#55)         |
| F-SEO-03 | SEO      | Structured data is emitted for Organization/WebSite and BreadcrumbList where applicable                                                                                       | SEO-1 #55; browser JSON-LD checks              | Search engines receive structured context without fictional offers or ratings                            | P2              | Keep JSON-LD limited to facts actually served; add FAQPage only with a real FAQ page                                                  | S      | FIXED                                              | SEO-1 (#55)         |
| F-SEO-04 | SEO/UX   | Public, Booking, Client, Tracking, OPS and Crew have French branded not-found pages                                                                                           | SEO-1 #55; app `not-found.tsx` files           | Unknown routes end in a coherent French recovery path instead of the Next.js default                     | P2              | Keep branded 404 coverage in browser acceptance for every frontend                                                                    | S      | FIXED                                              | SEO-1 (#55)         |
| F-SEO-05 | SEO/Sec. | Tracking validates the 43-character public token before rendering and serves private robots rules                                                                             | `tracking/[token]/page.tsx`; `robots.ts`       | Invalid paths are real 404s and do not trigger pointless tracking API calls                              | P2              | Keep token-shape validation before API access and keep Tracking permanently non-indexable                                             | S      | FIXED                                              | SEO-1 (#55)         |
| F-WEB-03 | Copy     | The public copy exposes internal vocabulary ("projection publique contrôlée", "parcours opérationnel", "brouillon interne", "Plateforme pilote") and repeats "pilote" 8 times | `apps/web/app/page.tsx`                        | Reads like an internal tool, not a travel company                                                        | P2              | Traveller-oriented copy managed in the CMS                                                                                            | S      | FIXED                                              | WEB-1               |

### Infrastructure, operations and CI

| ID       | Category | Description                                                                                                      | Evidence                                                | Impact                                                                                  | Crit. | Solution                                                                                                                   | Effort | Status                                  | PR            |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- | ------------- |
| F-INF-01 | Release  | The repository cannot verify the currently deployed production SHA; release activation requires root access      | `pilot-deployment.md`; `deploy-release.sh`              | Validated main can remain ahead of live until the owner/root performs deployment        | P1    | Root deploys an exact validated main SHA with `deploy-release.sh`; keep release status as an operator check                | S      | BLOCKED_EXTERNAL (root)                 | —             |
| F-INF-02 | Backup   | Daily PostgreSQL backups include retention, checksums and restore rehearsal; off-site copy remains blocked by B9 | `postgres-backups.md`, daily/restore timers, freshness. | Local recovery is tested; host or disk loss can still destroy all local backups         | P1    | Keep OPS-4 local checks; choose B9 before adding a reviewed encrypted off-site copy, retention and restore checks          | M      | FIXED_LOCAL / BLOCKED_OFFSITE; needs B9 | OPS-4         |
| F-INF-03 | Storage  | Private object storage, the malware scanner and payments are `DISABLED` in production                            | `docs/runbooks/pilot-deployment.md`                     | Documents and payments cannot be used                                                   | P0    | Provision private S3 (encryption, policy, backups), install the OPS-3A ClamAV stack, choose a PSP                          | L      | BLOCKED_EXTERNAL                        | OPS-3B, PAY-1 |
| F-OBS-01 | Monitor  | No external uptime monitoring or alerting; logs only in journald; no metrics                                     | No exporter; runbook "Observability" section            | Outages are discovered by users                                                         | P1    | Operational checklist now; external probe on `/health/ready` once a monitoring provider is chosen                          | S      | BLOCKED_EXTERNAL (provider)             | OPS-4         |
| F-CI-01  | CI       | Branch protection requires 6 checks but not `pilot-acceptance` or CodeQL                                         | GitHub branch protection API                            | A red aggregate or CodeQL run does not block a merge by itself                          | P2    | Owner adds `pilot-acceptance` and `Analyze (javascript-typescript)` to the required checks                                 | S      | BLOCKED_EXTERNAL (repository admin)     | —             |
| F-CI-03  | CI       | No schema-to-migration drift check: CI deploys migrations but never compares the result with `schema.prisma`     | `.github/workflows/ci.yml` (database job)               | A model change without its migration, or a constraint name mismatch, would reach `main` | P2    | `prisma migrate diff --from-config-datasource --to-schema … --exit-code` after the deploy in the `database` job            | S      | FIXED                                   | AUDIT-0       |
| F-CI-02  | Deps     | Dependabot PR #3 (`@types/node` 26) has been open since 2026-10-12, while `engines` pins Node 24                 | PR list                                                 | Noise; a major version that does not match the runtime                                  | P3    | Ignore semver-major `@types/node` updates in `dependabot.yml`; #3 then becomes obsolete                                    | S      | FIXED                                   | AUDIT-0       |
| F-PAY-01 | Payments | No real payment provider; SANDBOX is refused in production                                                       | ADR-027, `payment-env.ts`                               | No booking can be confirmed in production                                               | P0    | Owner chooses a PSP (Stripe, PayDunya, Wave, Orange Money…); the provider abstraction and its contract tests already exist | L      | BLOCKED_EXTERNAL                        | PAY-1         |

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

`ui-final.spec.ts` covers a cross-app responsive acceptance. UX-1A
extends that baseline at desktop and exactly 400 px on all six frontends and
on the seeded public inner pages. UX-1B then fixes the first interaction
review findings: traveller, Crew and OPS mobile navigation targets are at
least 44 px high, the OPS drawer close target is 44 × 44 px, and the public
OPS foundation status is consistently French.

## Mobile and accessibility

Automated regression guards now verify:

- **Navigation:** skip links (`.et-skip-link`) exist on the public site and
  the journey shell, and the first keyboard Tab reaches a real focus target.
- **Landmarks:** each entry/public page has one `main` landmark and one H1.
- **Images:** browser acceptance rejects any `img` without an `alt`
  attribute, including the seeded public inner pages.
- **Structure:** duplicate IDs and horizontal overflow are rejected on all six
  entry surfaces and on the seeded public pages.
- **Mobile:** the shared acceptance uses a 400 px viewport, matching the UX-1
  review target.
- **Reduced motion:** the public stylesheet disables smooth scrolling,
  transitions and hover transforms under `prefers-reduced-motion: reduce`;
  UX-1A verifies that behavior in Chromium.
- **Language:** `lang="fr"` is set.

These checks are regression guards, not a claim of complete WCAG A/AA
conformance. A full semantic, contrast and screen-reader audit remains a
separate review task.

## Performance

- The public homepage is a Server Component with no client JavaScript of its
  own; the shared Next.js runtime chunks still load.
- MEDIA-1 public image rendering is implemented. Real owner photos remain an
  editorial input rather than a code blocker.
- Every rendered public image has explicit dimensions and a `srcset` of
  480–2400 px WebP renditions with `sizes` per section. The hero image uses
  `fetchpriority="high"`; images below the fold are lazy. AVIF remains out
  because WebP covers the target browsers and AVIF encoding is much slower on
  the pilot server (`docs/domain/media.md`).
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
- **Data procedures:** DATA-1/DATA-1B now provide the idempotent
  `pnpm data:bootstrap-pilot` procedure, dry-run support, conflict detection,
  explicit pilot markers and a production confirmation guard.
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
- the daily auth purge timer;
- OPS-4 local PostgreSQL backup freshness checks plus an isolated restore
  rehearsal.

What is missing:

- external uptime probes and alerting;
- disk and PostgreSQL size alerts;
- monitoring of the Crew offline queue and the scanner.

See F-OBS-01 and F-INF-02.

## Technical debt

- The remaining public WEB-2 page set is incomplete: FAQ, About, Contact,
  Legal and Privacy are not yet demonstrated by the repository.
- The README and architecture overview had drifted (F-DOC-01 to F-DOC-03).
- No dead code, `TODO`, `FIXME` or stray `console.*` call was found in
  application sources (grep on `apps/` and `packages/`).

## Risks

1. A real customer could be exposed to the site before the legal notice and
   privacy policy exist (F-WEB-01).
2. A host or disk loss can still destroy PostgreSQL and its local backups
   until an off-site target is chosen (F-INF-02 / B9).
3. Validated `main` can remain ahead of the live server until root performs
   the explicit deployment (F-INF-01 / B10).
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

The table below is the original dependency roadmap. Current state on
2026-10-23: FLEET-1 (#53), SEO-1 (#55), CMS-1 (#56), WEB-1 (#66), CMS-2
(#67), MEDIA-1 (#68), UI-PUBLIC-2 (#70), DATA-1/DATA-1B (#54/#106),
UX-1A/UX-1B (#110/#112), OPS-4 local (#108) and ARCH-1B (#114) are merged.
WEB-2 remains partial. OPS-3B, PAY-1, off-site backup, external monitoring and
root deployment remain blocked by owner/external inputs.

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

## Readiness matrix (current code state, 2026-10-23)

| Domain    | Code | UI  | Data | Tests | Docs | Exploitable | Why not                                                                |
| --------- | ---- | --- | ---- | ----- | ---- | ----------- | ---------------------------------------------------------------------- |
| Public    | ✅    | ✅   | ⚠️  | ✅     | ⚠️  | ❌          | WEB-2 legal/contact incomplete; no production trips or real PSP        |
| CMS       | ✅   | ✅  | ⚠️  | ✅    | ✅   | ⚠️         | Code/UI ready; production content/media still depend on owner data     |
| SEO       | ✅   | —   | —    | ✅    | ✅   | ⚠️         | Code ready; indexing stays off unless production flag is enabled       |
| Booking   | ✅   | ✅  | ❌   | ✅    | ✅   | ❌          | No trip in production (F-DATA-01), no PSP (F-PAY-01)                   |
| Client    | ✅   | ✅  | —    | ✅    | ✅   | ⚠️          | Depends on bookings; documents blocked (F-INF-03)                      |
| OPS       | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Code ready; live state still depends on root deployment (F-INF-01)     |
| Crew      | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Needs trips and assignments                                            |
| Fleet     | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | No vehicle in production (F-DATA-01)                                   |
| Trips     | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | No trip in production (F-DATA-01)                                      |
| Payment   | ⚠️   | ✅  | —    | ✅    | ✅   | ❌          | SANDBOX only (F-PAY-01)                                                |
| Documents | ✅   | ✅  | —    | ✅    | ✅   | ❌          | Storage and scanner disabled (F-INF-03)                                |
| Tracking  | ✅   | ✅  | ❌   | ✅    | ✅   | ⚠️          | Needs trips; public availability still depends on configured trip data |
| Finance   | ✅   | ✅  | —    | ✅    | ✅   | ⚠️          | Operational finance only; no statutory accounting                      |
