# Public website content (CMS-1)

The public website is managed as **structured content** in the Core API and
PostgreSQL: pages, site settings and navigation. It is edited in OPS
(CMS-2), never as JSX in the code, and never as free HTML.

## Model

| Entity            | Role                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContentEntry`    | A public page (`PAGE`, keyed by its path: `/`, `/paris-dakar`…) or one of two singletons, `SITE_SETTINGS` (`site`) and `NAVIGATION` (`navigation`). |
| `ContentRevision` | A numbered revision of the entry's document: `DRAFT`, `PUBLISHED` or `SUPERSEDED`.                                                                  |

The rules:

- **One of each:** an entry has at most one `DRAFT` and one `PUBLISHED`
  revision. Both are partial unique indexes.
- **Never deleted:** entries are not deleted; pages are archived. Kind and
  key are immutable.
- **Numbering:** revision numbers increase one at a time from an entry
  counter (`last_revision`). They are never reused, even when a draft is
  discarded, so an audit event always designates one revision.
- **Immutability:** a `PUBLISHED` revision can only become `SUPERSEDED`, and
  a `SUPERSEDED` revision never changes. Only drafts can be deleted
  (discarded). Truncation is refused.
- **Clocks:** the publication and supersession times are set by the database
  clock.
- **Size:** a document is a JSON object of at most 256 KiB.

## Documents

Documents are validated by `@euroteranga/content`, shared by the API, OPS and
the website:

- **Page:** `{ title, seo: { title?, description, indexable, socialMediaId? }, blocks[] }`,
  with at most 40 blocks.
- **Blocks:**

  | Block        | Purpose                                                                                                                        |
  | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
  | `hero`       | Main banner (one per page at most): photo, title and accent, trip search; `variant: page` for inner pages, with the breadcrumb |
  | `richText`   | Formatted text                                                                                                                 |
  | `textImage`  | Text next to an image; `tone: navy` for a highlighted card                                                                     |
  | `image`      | Single image                                                                                                                   |
  | `cta`        | Call to action                                                                                                                 |
  | `cards`      | Cards (features, services with photos, steps, trust, `highlights` row)                                                         |
  | `faq`        | Questions and answers                                                                                                          |
  | `routes`     | The Paris → Dakar and Dakar → Paris lines                                                                                      |
  | `departures` | Next bookable departures of chosen directions (UI-PUBLIC-1); `layout: dates` for a strip of dates and fares (UI-PUBLIC-2)      |
  | `stats`      | Key figures                                                                                                                    |
  | `gallery`    | Image gallery                                                                                                                  |
  | `banner`     | Information banner                                                                                                             |
  | `sectionNav` | Tabs to the sections of the page, each by its anchor (UI-PUBLIC-2)                                                             |
  | `itinerary`  | Planned itinerary of the next bookable departure of a direction (UI-PUBLIC-2)                                                  |
  | `fleet`      | The coaches in service, with Fleet media and editorial text/fallback photos (UI-PUBLIC-2)                                      |

  Stops are named by their network code (`stopCodeSchema`, the same rule as
  the stop table: `^[A-Z0-9][A-Z0-9_-]{0,31}$`). A direction needs two
  different stops. No block holds a date, a number of seats or a price.

  An anchor is unique on its page, and every `sectionNav` tab must point to
  one of them.

  UI-PUBLIC-2 blocks hold no schedule, stop list, seat count or equipment:
  - `itinerary` names a direction (`fromCode`, `toCode`), an optional title
    for the "included" list, up to 8 services the company confirms for
    every journey (`included`, the editor's responsibility) and whether the
    equipment of the assigned coach is added (`showVehicleAmenities`);
  - `fleet` shows every active coach (`selection: all`) or only the listed
    ones (`listed`, in the editor's order). Each item names a vehicle by its
    fleet code (`vehicleCodeSchema`, same rule as the vehicle table) and adds
    a description. Legacy CMS main/gallery images remain a fallback until the
    vehicle is configured in Fleet. A code is presented once.

- **Rich text:** paragraphs, level-2 and level-3 headings and lists of spans,
  with bold, italic and link marks. No HTML.
- **Links:** typed targets:
  - a public page (`path`);
  - an application (`booking`, `client`, `tracking`), resolved from the site
    settings;
  - an absolute HTTPS URL;
  - an anchor on the page.

  `javascript:`, `data:`, `mailto:` and plain `http:` are refused.

- **Site settings:**
  - brand name and slogan;
  - contact;
  - legal identity;
  - social networks;
  - application URLs;
  - footer.
- **Navigation:** header links, a header call to action and footer columns.

### Prices

Prices are never written in the CMS. A `routes` block asks the website to
show the "from" price of each direction. The website reads that price from
the public search API (Pricing, PR-08) when it renders the page. Marketing
can therefore never contradict Booking.

The `cargo-freight` template deliberately uses `cards` for its two directions,
not `routes`: `/fret` must never render passenger fares or a public cargo price.
Its quote calls to action remain editorial anchors to the contact guidance;
the template neither creates Cargo records nor exposes a public lookup form.

### Owner information

Legal and contact fields are nullable. A `null` value means
`OWNER_INPUT_REQUIRED`:

- OPS lists the missing fields (`missingOwnerInputs`);
- the website hides them;
- nothing is invented.

## Workflow

| Step              | API (`/v1/admin/content`)                                                                            | Effect                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Create a page     | `POST /entries` `{ kind: 'PAGE', path, title, description }`                                         | Draft revision 1, **not indexable**                                               |
| Create singletons | `POST /entries` `{ kind: 'SITE_SETTINGS' }` or `{ kind: 'NAVIGATION' }`                              | Draft created from the default content (once)                                     |
| Edit              | `POST /entries/:id/draft` `{ document, note?, expectedDraftUpdatedAt }`                              | Creates or replaces the draft; the live revision is untouched                     |
| Publish           | `POST /entries/:id/publish` `{ expectedDraftUpdatedAt }`                                             | The draft goes live; the previous live revision becomes `SUPERSEDED`              |
| Discard           | `POST /entries/:id/discard-draft` `{ expectedDraftUpdatedAt }`                                       | Removes the draft                                                                 |
| Restore           | `POST /entries/:id/restore` `{ revision, note? }`                                                    | New draft copied from an earlier revision (refused while another draft exists)    |
| Archive           | `POST /entries/:id/archive` `{ reason }`, `POST /entries/:id/unarchive`                              | The page is no longer served; the home page and the singletons cannot be archived |
| Read              | `GET /entries`, `GET /entries/:id` (draft, live, last 30 revisions), `GET /entries/:id/revisions/:n` | Detail and preview (CMS-2)                                                        |

### Concurrency

Every mutation locks the entry row. `expectedDraftUpdatedAt` is the
`updatedAt` of the draft the editor started from, or `null` when they saw
none. It makes a stale decision fail with `409 CONTENT_DRAFT_CONFLICT`
instead of overwriting a colleague's work. A forced-overlap test proves that
two simultaneous publications of the same draft give exactly one success.

### Validation

A document must match the model at save time and again at publication. A
failure is `422 CONTENT_DOCUMENT_INVALID` with
`details.issues[{ path, message }]`.

## Public reads (`/v1/content`, no session)

| Endpoint             | Returns                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `GET /pages?path=/x` | The live revision of a served page (`404 CONTENT_PAGE_NOT_FOUND` otherwise)  |
| `GET /site`          | Live settings and navigation; each is `null` until first published           |
| `GET /sitemap`       | Served pages whose live revision is `indexable`, with their publication date |

Responses carry `Cache-Control: public, max-age=60` (`300` for the sitemap).
Drafts, history and archived pages are never public.

## Errors

| Code                              | HTTP | When                                                    |
| --------------------------------- | ---- | ------------------------------------------------------- |
| `CONTENT_ENTRY_NOT_FOUND`         | 404  | unknown entry                                           |
| `CONTENT_REVISION_NOT_FOUND`      | 404  | unknown revision                                        |
| `CONTENT_PAGE_NOT_FOUND`          | 404  | public read of an unpublished or archived page          |
| `CONTENT_PATH_TAKEN`              | 409  | a page already uses this path                           |
| `CONTENT_SINGLETON_EXISTS`        | 409  | the settings or navigation already exist                |
| `CONTENT_DRAFT_CONFLICT`          | 409  | `expectedDraftUpdatedAt` differs from the current draft |
| `CONTENT_NO_DRAFT`                | 409  | publish or discard without a draft                      |
| `CONTENT_DRAFT_EXISTS`            | 409  | restore while a draft exists                            |
| `CONTENT_ALREADY_ARCHIVED`        | 409  | archive twice                                           |
| `CONTENT_NOT_ARCHIVED`            | 409  | unarchive a served page                                 |
| `CONTENT_SEO_PERMISSION_REQUIRED` | 403  | search metadata changed without `seo.manage`            |
| `CONTENT_DOCUMENT_INVALID`        | 422  | the document does not match the model                   |
| `CONTENT_ARCHIVE_FORBIDDEN`       | 422  | archive the home page or a singleton                    |

## Audit

The audit events are:

- `CONTENT_ENTRY_CREATED`;
- `CONTENT_DRAFT_SAVED`;
- `CONTENT_PUBLISHED`;
- `CONTENT_DRAFT_DISCARDED`;
- `CONTENT_RESTORED`;
- `CONTENT_ARCHIVED`;
- `CONTENT_UNARCHIVED`.

Each event is written in the transaction of its mutation (an audit failure
rolls the mutation back). It carries the kind, key, revision numbers and a
SHA-256 fingerprint of the document, never the document itself: the
revisions table is the content history.

## Website rendering (WEB-1)

The public website (`apps/web`) renders the published content on the server
with `@euroteranga/site`. The OPS preview (CMS-2) uses the same package, so
editors preview exactly what visitors get.

- **Routing:** one catch-all route serves every published path. A path that
  is not a valid content path, or that has no published page, is a 404.
- **Default content:**
  - while nothing is published, or when the Core API cannot be reached, the
    home page falls back to the default content of `@euroteranga/content`,
    so the site never goes blank;
  - any other page answers a French "temporarily unavailable" page when the
    API cannot be reached.
- **Site settings and navigation:** the published versions are used, or the
  defaults until they are published.
- **Trip search (UI-PUBLIC-1):** a hero with `search` shows a plain GET form
  (departure, arrival, date, travellers, no client JavaScript) whose stops
  come from the public stops API. It opens the booking application
  pre-filled: `?from=PAR&to=DKR&date=YYYY-MM-DD&passengers=2`
  (`docs/domain/bookings.md`).
- **Departures (UI-PUBLIC-1):** a `departures` block reads the public trip
  search of each direction (cached 60 s):
  - the soonest journeys with seats left, all directions together, up to
    its limit;
  - date and time in the origin stop's timezone, the exact fare of the
    journey (Pricing) and the seats left;
  - a "Réserver" link to the pre-filled booking search of that day;
  - the destination photo of its direction (media library), else a navy
    placeholder.

  Without an open departure the section says so; when the trip search
  cannot answer, it says the departures are shown in the booking
  application. It never shows a typed date, seat count or price.

- **Inner pages (UI-PUBLIC-2):**
  - **Page hero:** `variant: page` is a shorter banner with the breadcrumb
    "Accueil › page title". The page then carries a schema.org
    `BreadcrumbList`, only because the breadcrumb is visible.
  - **Section tabs:** a `sectionNav` stays under the sticky header; the
    anchor offset includes it, so a section never starts under the tabs.
  - **Departure dates:** `layout: dates` lists the same departures as the
    cards (same search, same rules): local date and time of the origin,
    exact fare, seats left. Each date opens the pre-filled booking search of
    that day, and "Réserver ce voyage" books the soonest one.
  - **Itinerary:** the soonest bookable journey of the direction (the same
    search as the departures, read once per direction), then the trip's
    public itinerary (`GET /v1/booking/trips/{tripId}/itinerary`,
    `docs/domain/bookings.md`), cut between the journey's origin and
    destination waypoints. It shows:
    - departure and arrival times in each place's own timezone, the
      calendar-day offset of the arrival ("+1 j") and the planned duration;
    - the stops and crossings in between (borders, ports, ferry terminals),
      the countries of the journey in order, and a schematic of the route
      (not a map: no coordinate is shown or invented);
    - the editor's confirmed services, then the equipment of the coach
      assigned to that departure while it is active (Fleet). Nothing else
      is listed, and the panel is left out when the list is empty.

    Without a bookable departure it says that none is scheduled; when the
    search or the itinerary cannot be read, it says so.

  - **Coaches:** the public fleet read (`GET /v1/booking/fleet`,
    `docs/domain/fleet.md`) gives the name, model, year, seats (from the
    current seat map) and equipment of each active coach; several coaches
    get anchor tabs. A listed coach that is not active is left out. Unknown
    equipment values are ignored, never shown raw. Main and gallery photos
    come first from the vehicle's MEDIA-1 references; CMS vehicle photos are
    only a backward-compatible fallback.
  - **Departure cards:** the image is the main MEDIA-1 photograph of the
    vehicle actually assigned to that trip; otherwise the route field labelled
    “Photo par défaut du trajet” in OPS; otherwise the existing placeholder.
  - Itineraries are cached 60 s, the fleet 300 s.
- **Prices:** "from" prices come from the public search API (Pricing),
  never from the CMS:
  - the lowest current fare per direction among bookable trips, for the
    `PAR` and `DKR` stops;
  - shown only when every fare uses the same currency;
  - otherwise "Tarif affiché à la réservation".
- **Rendering:**
  - text is React text and rich text is a typed tree, so markup typed by an
    editor is displayed literally;
  - a page without a hero gets its title as its single H1;
  - images come from the media library (MEDIA-1, `docs/domain/media.md`):
    the page's media ids are resolved in one public batch read
    (`GET /v1/media?ids=`), then rendered as responsive WebP (`srcset`,
    `sizes` per section, the hero with `fetchpriority="high"`) loaded from
    the API origin. An unknown or archived image is left out, never shown
    broken. The page's `seo.socialMediaId` becomes its Open Graph and
    Twitter image.
- **Caching:** API reads are cached by Next.js for 60 s (300 s for prices
  and stops), so a publication appears within a minute.
- **Server-side configuration** (read at runtime by `euroteranga-web`):

  | Variable                                                         | Purpose                                                                                                                                                                                                                                                                                                                               |
  | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `CORE_API_INTERNAL_URL`                                          | Optional loopback API base for server-side reads (e.g. `http://127.0.0.1:3206`); defaults to `NEXT_PUBLIC_API_BASE_URL`                                                                                                                                                                                                               |
  | `PUBLIC_BOOKING_URL`, `PUBLIC_CLIENT_URL`, `PUBLIC_TRACKING_URL` | Optional overrides of the application links of the site settings (local, CI, staging). `PUBLIC_BOOKING_URL`'s origin (default `https://booking.euroteranga.com`) is also the only target, besides the site, allowed for forms (CSP `form-action`, fixed at build time): the booking URL in the site settings must stay on that origin |

- **Sitemap:** it lists the served, indexable CMS pages, and only the home
  page when the API cannot answer.

## OPS editor (CMS-2)

OPS → **Site public → Contenus du site** (`/contenus`) lists the pages with
their status, and the two singletons (site settings, navigation). The
editor (`/contenus/edition?entree=<id>`) works on one entry.

- **Permissions:**
  - `content.read` opens the module, read only;
  - `content.manage` edits, publishes, restores and archives;
  - `seo.manage` unlocks the search metadata of a page;
  - every call is authorized again by the Core API.
- **Structured fields, never markup:**
  - each section type has its own form, with French labels, bounds and
    counters taken from the content model;
  - a new section starts empty, so the content model refuses it until it
    is filled in: no placeholder text can be published by mistake;
  - owner information (contact, legal notice) left empty stays
    "à compléter par l’exploitant" and is not displayed, never invented;
  - prices are never typed: the `routes` section and the hero journey card
    read them from Pricing on the website.
- **Rich text input:** paragraphs, `##` headings, `-` lists, `**bold**`,
  `*italic*` and `[label](/path)` links are typed in a text area and
  converted in the browser to the typed tree (`markupToRichText`). The tree
  is what is validated, stored and rendered; markup such as `<b>` stays
  literal text. A malformed mark is reported with its line.
- **Validation:** the editor validates with the same schemas as the API
  and lists the issues in French with a link to each field. Saving is
  disabled while an issue remains; the API validates again.
- **Preview:**
  - the page is rendered with `@euroteranga/site`, the website's own
    components and stylesheets (`@euroteranga/site/css-text`);
  - it runs in a sandboxed frame (`sandbox=""`: no script, no origin), so
    nothing in it can act on OPS and its links lead nowhere;
  - mobile (390 px), tablet (768 px) and desktop (1280 px) widths use the
    real breakpoints of the website;
  - "from" prices are not shown in the preview;
  - images are read from the public media endpoint, like on the website.
- **Images:** an image field shows the chosen image and opens a picker of
  the active images of the media library (`media.read`), with a filter on
  their description. An image that became unavailable is flagged; the
  API refuses to save, publish or restore a document that references it.
- **Workflow:**
  - "Enregistrer le brouillon" saves the draft with the `updatedAt` it
    started from. If someone saved meanwhile, the API answers
    `CONTENT_DRAFT_CONFLICT` and the editor offers to reload; it never
    overwrites the other change;
  - publication, discarding a draft and archiving ask for confirmation;
  - the history lists the last 30 revisions; any of them can be previewed
    and restored as a new draft;
  - leaving the page with unsaved changes asks for confirmation.
- **Inner-page sections (UI-PUBLIC-2):** the hero has a "Format du
  bandeau" (home or inner page); the departures section a "Présentation"
  (cards or dates); the section tabs, itinerary and coaches sections have
  their own forms. Stops are chosen among the active stops, coaches among
  the active vehicles of the public fleet read. Times, stops, seats and
  equipment are never typed: the preview reads them from the same public
  API as the website (one search per direction).
- **Page templates (UI-PUBLIC-2 / WEB-2A):** "Créer une page" offers
  templates (`PAGE_TEMPLATES`): Voyage Paris → Dakar, Voyage Dakar → Paris,
  Nos bus, Services, Bagages, Comment ça marche, FAQ, À propos and Colis &
  fret. A template pre-fills the path, title and description, and brings its
  sections. The SEO of the created draft is kept (not indexed): indexing
  stays a `seo.manage` decision. Templates state only what the platform
  provides; no fare, luggage allowance, weight limit, legal identity,
  contact detail or assistance promise is invented. Contact, legal notice
  and privacy remain separate owner-input work.
- **Home page:** while no `/` page exists, the website shows the default
  content. "Créer la page d’accueil à partir du contenu actuel" creates it
  as a draft from that default content, so editing starts from what
  visitors see.

## Deliberately not in CMS

- **Image files:** the media library (MEDIA-1, `docs/domain/media.md`)
  holds them; documents only reference their ids (`mediaIdsOf` and
  `mediaReferencesOf` list them).
- **Testimonials:** not modelled, so that no fake review can be published.
- **Scheduled publication:** not modelled.
- **Real-time co-editing:** not modelled.
