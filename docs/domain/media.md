# Public media library (MEDIA-1)

The images of the public website: hero, text and image sections, galleries
and the social image of a page. They are uploaded and described in OPS,
stored outside PostgreSQL and served by the Core API.

The library is separate from passenger documents (PR-11):

- other tables (`public_media_asset`, `public_media_rendition`);
- other permissions (`media.read`, `media.manage`);
- another storage root and another key space (`public-media/…`). The two
  stores refuse each other's keys.

No permission of one domain opens the other.

## Model

- **Asset** (`public_media_asset`): one image.
  - **Description:** alternative text (required, 1–250 characters), caption
    (≤ 240), credit (≤ 160) and focal point (`focalX`, `focalY`, 0–100 %,
    50/50 by default). This is the only part that can change, while the
    asset is active.
  - **Source facts:**
    - the decoded format (`jpeg`, `png`, `webp`);
    - the SHA-256 and size of the uploaded bytes;
    - the dimensions once the EXIF orientation is applied.

    They never change (trigger).

  - **Lifecycle:** `ACTIVE` → `ARCHIVED`, with date, author and reason
    (≥ 3 characters). Archiving is **terminal**: an archived asset is
    frozen by a trigger, and there is no restoration and no deletion.
- **Renditions** (`public_media_rendition`):
  - WebP files 480, 960, 1600 and 2400 px wide, never wider than the source
    (a 640 px image gets 480 and 640);
  - content-addressed: the storage key is `public-media/<2 hex>/<sha256>`,
    checked by a CHECK constraint;
  - immutable (trigger).

  An image uploaded again after being archived shares the same files.

- **Uniqueness:** the same file cannot be active twice (partial unique index
  on `source_sha256` among `ACTIVE` assets). Once archived, it can be
  uploaded again as a new asset.

**An image is never replaced in place.** "Remplacer" uploads a new asset,
pre-filled with the old description; the audit event of the upload records
`replacesMediaId`. The editor then picks the new image in the contents and
archives the old one. Old revisions keep their reference, so the history
stays exact and a restore cannot silently show another image.

## Ingestion (`POST /v1/admin/media`, multipart)

1. **Request checks:**
   - a STAFF session, `ops.access`, `media.read` and `media.manage`, and a
     CSRF token;
   - at most 60 uploads per hour per identity;
   - at most 2 images processed at a time per API process (`MEDIA_BUSY`,
     `Retry-After: 5`);
   - the whole body must arrive within 120 s (`MEDIA_UPLOAD_TIMEOUT`); an
     upload abandoned by the client (`MEDIA_UPLOAD_ABORTED`) always releases
     its processing slot.
2. **Multipart shape:**
   - exactly one `file` part, plus the fields `altText`, `caption`,
     `credit`, `focalX`, `focalY` and `replaces`;
   - field names and values are bounded, and anything else is refused
     (`MEDIA_UPLOAD_MALFORMED`);
   - the declared type must be `image/jpeg`, `image/png` or `image/webp`;
   - the file name is ignored and never stored.
3. **Size:** at most `PUBLIC_MEDIA_MAX_BYTES` (default 10 MiB). The body is
   kept in memory, never written to disk as received.
4. **Format:** the magic bytes must be JPEG, PNG or WebP, checked _before_
   any decoding. libvips could decode SVG, GIF, TIFF or HEIF, but they are
   never handed to it. The decoder must then confirm the same format.
5. **Decoding:** `sharp` (libvips) decodes the image.
   - It is bounded to `PUBLIC_MEDIA_MAX_PIXELS` (default 40 megapixels,
     against decompression bombs) and to 20 000 px on a side (the database
     limit), checked before any rendition is encoded or stored.
   - It fails on a broken or truncated file.
   - Animated or multi-page images are refused, and so are images under
     200 px on a side.
6. **Re-encoding:** each rendition is a fresh WebP (quality 80) with the
   orientation applied. EXIF, GPS, XMP and comments are dropped. **The
   uploaded file is not stored.**
7. **Storage and record:**
   - the files are stored first; an existing content-addressed file is
     reused only if its SHA-256 matches;
   - then, in one transaction: the asset, its renditions and the audit
     event `PUBLIC_MEDIA_UPLOADED`.

## Administration (`/v1/admin/media`, STAFF)

| Endpoint            | Permission     | Effect                                                                                                     |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /`             | `media.read`   | Images, newest first (`status`, `limit` ≤ 100, `cursor`), and `storageEnabled`                             |
| `GET /:id`          | `media.read`   | One image, its renditions, its authors and the contents that use it (`usages`)                             |
| `POST /`            | `media.manage` | Upload (above)                                                                                             |
| `POST /:id`         | `media.manage` | Alternative text, caption, credit, focal point (`MEDIA_ARCHIVED` once archived); audited with before/after |
| `POST /:id/archive` | `media.manage` | Terminal archive with a reason; refused with `MEDIA_IN_USE` and the usages while a content shows it        |

**Usages** are the draft and published revisions that reference the id
(`seo.socialMediaId`, section `mediaId`, gallery items). Archived content
entries count too, because unarchiving one puts its published revision back
online; they are flagged with `entryArchived`.

## Contents and the archive ↔ publication race

Saving a draft, publishing it and restoring a revision all check, in their
own transaction, that every referenced image exists and is `ACTIVE`.
Otherwise the API answers `CONTENT_DOCUMENT_INVALID` with the path of each
field (`blocks.2.mediaId`…).

- The check locks the images `FOR SHARE`.
- Archiving locks the image `FOR UPDATE`, then looks for usages in a new
  statement.

So the two serialize:

- a save that holds the image makes the archive wait, and the archive
  then sees the new draft and refuses;
- an archive in progress makes the save wait, and the save then sees
  `ARCHIVED` and refuses.

Both orders are proven by integration tests with a held transaction.
Publication checks again because a draft may have been saved before an
image became unavailable by another path.

## Public delivery (no session)

- `GET /v1/media?ids=<id>,<id>` returns at most 50 distinct ids, and only
  active images: alternative text, caption, credit, dimensions, focal point
  and rendition paths. Unknown or archived ids are absent. The response
  holds no storage key and no STAFF identity. `Cache-Control: public,
max-age=60`.
- `GET /v1/media/files/:id/:width.webp` returns one rendition of an active
  image:
  - `Content-Type: image/webp`, `X-Content-Type-Options: nosniff` and
    `Content-Disposition: inline`;
  - `Cross-Origin-Resource-Policy: cross-origin`, for the website and the
    sandboxed OPS preview, whose origin is opaque;
  - `Cache-Control: public, max-age=86400`, a strong `ETag` (the SHA-256)
    and `304` on `If-None-Match`.

  An archived image answers 404, and caches stop serving it within a day.
  Errors (404, 503) are `Cache-Control: no-store`: a passing storage failure
  is never kept by a browser or a proxy. With `PUBLIC_MEDIA_STORAGE=DISABLED`,
  descriptions stay readable but files answer 503 `MEDIA_UNAVAILABLE`.

## Website and OPS

- **Website** (`apps/web`):
  - resolves the media ids of the page in one server-side read;
  - renders `<img>` with `srcset` of the WebP renditions, `sizes` per
    section, explicit dimensions (no layout shift), `loading="lazy"`
    except for the hero (`fetchpriority="high"`), the focal point as
    `object-position`, then the caption and "Crédit photo : …";
  - uses the page's social image as its Open Graph and Twitter image.
- **CSP:** `img-src 'self' data: blob: <API origin>`: the exact Core API
  origin is the only added source, never a wildcard.
- **OPS → Site public → Médiathèque** (`/mediatheque`, `media.read`):
  - a grid of active or archived images, with a filter on their
    description;
  - an import form with local checks (format, 20 MiB) and a preview;
  - a focal point editor (sliders, or a click on the image) with 16:9, 4:3
    and 1:1 crops;
  - the usages, the replacement and the confirmed archive.
- **Content editor:** image fields use a picker of active images (see
  `docs/domain/content.md`).

## Configuration (`apps/api`)

| Variable                  | Default    | Purpose                                                                                                                                                   |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_MEDIA_STORAGE`    | `DISABLED` | `DISABLED` (the library is read-only, uploads answer `MEDIA_STORAGE_DISABLED`) or `LOCAL`                                                                 |
| `PUBLIC_MEDIA_LOCAL_ROOT` | —          | Absolute dedicated directory, required with `LOCAL`. Not a web root or upload directory; never equal to, inside or containing `OBJECT_STORAGE_LOCAL_ROOT` |
| `PUBLIC_MEDIA_MAX_BYTES`  | 10 MiB     | Upload limit, 1 KiB–20 MiB                                                                                                                                |
| `PUBLIC_MEDIA_MAX_PIXELS` | 40 000 000 | Decoding limit (width × height), 1–100 megapixels                                                                                                         |

Unlike the private document adapter, `LOCAL` is allowed in staging and
production: the files are public by nature and hold no personal data. The
directory is created owner-only (`0700`, files `0600`) and served only
through the API, never by the web server. Operations are covered in
`docs/runbooks/public-media-storage.md`.

## Errors

| Code                                            | HTTP | When                                                  |
| ----------------------------------------------- | ---- | ----------------------------------------------------- |
| `MEDIA_STORAGE_DISABLED`                        | 503  | `PUBLIC_MEDIA_STORAGE=DISABLED`                       |
| `MEDIA_BUSY`                                    | 503  | Two images already being processed (`Retry-After: 5`) |
| `MEDIA_UNAVAILABLE`                             | 503  | Storage failure, or a file while storage is disabled  |
| `MEDIA_UPLOAD_MALFORMED`, `MEDIA_UPLOAD_EMPTY`  | 400  | Form shape, empty file                                |
| `MEDIA_UPLOAD_ABORTED`                          | 400  | The client went away before the end of the body       |
| `MEDIA_UPLOAD_TIMEOUT`                          | 408  | The body did not arrive within 120 s                  |
| `VALIDATION_FAILED`                             | 400  | Description fields (names in the message)             |
| `MEDIA_UPLOAD_TOO_LARGE`                        | 413  | Over `PUBLIC_MEDIA_MAX_BYTES`                         |
| `MEDIA_FORMAT_UNSUPPORTED`                      | 415  | Not JPEG, PNG or WebP (declared type or content)      |
| `MEDIA_IMAGE_INVALID`                           | 422  | Broken or truncated image                             |
| `MEDIA_IMAGE_TOO_LARGE`                         | 422  | Over `PUBLIC_MEDIA_MAX_PIXELS` or 20 000 px on a side |
| `MEDIA_IMAGE_TOO_SMALL`, `MEDIA_IMAGE_ANIMATED` | 422  | Under 200 px on a side; animated or multi-page        |
| `MEDIA_DUPLICATE`                               | 409  | Same file already active (`details.mediaId`)          |
| `MEDIA_IN_USE`                                  | 409  | Archive refused (`details.usages`)                    |
| `MEDIA_ARCHIVED`                                | 409  | Changing or archiving an archived image               |
| `MEDIA_NOT_FOUND`                               | 404  | Unknown id, archived file, unknown width              |

## Audit

| Action                  | Recorded                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_MEDIA_UPLOADED` | Format, source SHA-256, dimensions, rendition widths; `replacesMediaId` for a replacement |
| `PUBLIC_MEDIA_UPDATED`  | Description before and after                                                              |
| `PUBLIC_MEDIA_ARCHIVED` | Status before and after, the reason                                                       |

## Not in MEDIA-1

- **Other formats:**
  - SVG uploads are refused (the site's illustrations are code);
  - GIF, HEIC and TIFF are refused;
  - AVIF renditions are not produced: WebP covers every target browser,
    and AVIF encoding is several times slower on the pilot server.
- **Video** and **documents (PDF)** are not handled.
- **Cropping:** the focal point guides automatic crops; no image editing.
- **External storage or CDN:** the pilot uses a local volume. An
  S3-compatible public bucket would be a new adapter behind the same
  interface.
