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

  | Block       | Purpose                                   |
  | ----------- | ----------------------------------------- |
  | `hero`      | Main banner (one per page at most)        |
  | `richText`  | Formatted text                            |
  | `textImage` | Text next to an image                     |
  | `image`     | Single image                              |
  | `cta`       | Call to action                            |
  | `cards`     | Cards (features, services, steps, trust)  |
  | `faq`       | Questions and answers                     |
  | `routes`    | The Paris → Dakar and Dakar → Paris lines |
  | `stats`     | Key figures                               |
  | `gallery`   | Image gallery                             |
  | `banner`    | Information banner                        |

  An anchor is unique on its page.

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

## Deliberately not in CMS-1

- **OPS editor and preview:** CMS-2.
- **Media library:** MEDIA-1. Blocks already reference media ids
  (`mediaIds` lists them).
- **Website rendering:** WEB-1.
- **Testimonials:** not modelled, so that no fake review can be published.
- **Scheduled publication:** not modelled.
- **Real-time co-editing:** not modelled.
