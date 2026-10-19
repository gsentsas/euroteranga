# Public media library: security review (MEDIA-1)

| Threat                              | Control                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Script in an image (SVG, polyglot)  | Only JPEG, PNG and WebP, recognised by magic bytes **before** decoding; SVG, GIF, TIFF, HEIF never reach libvips. Every served file is a fresh WebP produced by the server, with `Content-Type: image/webp`, `nosniff` and `inline`: no uploaded byte is ever served.                                                                            |
| Malformed or hostile image          | Decoded by libvips through `sharp` with `failOn: 'error'`: broken or truncated files are refused. The decoder must confirm the magic format. Integration tests cover disguised SVG/GIF/PDF, a signature followed by garbage and a truncated JPEG.                                                                                                |
| Decompression bomb                  | `limitInputPixels` = `PUBLIC_MEDIA_MAX_PIXELS` (default 40 megapixels) and 20 000 px per side before decoding; animated and multi-page images refused; body limited to `PUBLIC_MEDIA_MAX_BYTES`. At most 2 images processed at once per process, libvips cache disabled and 2 threads, within the API `MemoryMax`.                               |
| Privacy leak through metadata       | EXIF, GPS, XMP and comments are dropped (renditions are re-encoded without metadata); the orientation is applied first. The uploaded original and its file name are not stored. Tests check that a JPEG with GPS gives renditions without EXIF/XMP.                                                                                              |
| Path traversal, key confusion       | Storage keys are derived from the rendition SHA-256 (`public-media/<2 hex>/<sha256>`), checked by a CHECK constraint and by the provider. The public store accepts only that key space and the private document store refuses it (and vice versa). The public file route validates the UUID and `<width>.webp`.                                  |
| Mixing public and private storage   | Separate root (`PUBLIC_MEDIA_LOCAL_ROOT`), refused when equal to, inside or containing `OBJECT_STORAGE_LOCAL_ROOT`, or under a web/upload directory. Separate tables and permissions; `media.*` gives no access to passenger documents and no document permission gives `media.*`.                                                               |
| Unauthorized change                 | STAFF session, `ops.access` + `media.read`; changes need `media.manage` and a CSRF token. Only `SUPER_ADMIN`, `DIRECTOR` and `CONTENT_EDITOR` hold them (RBAC matrix test).                                                                                                                                                                      |
| Upload abuse                        | 60 uploads per hour per identity (rate limit), bounded multipart shape (one file, six named fields, bounded names and values), `MEDIA_BUSY` beyond 2 concurrent uploads. A body must arrive within 120 s, and an upload abandoned mid-body settles at once: no processing slot can be held or leaked (integration test with a destroyed socket). |
| Silent replacement of an image      | Assets and renditions are immutable (triggers); a replacement is a new asset, audited with `replacesMediaId`. Archived assets are frozen. Published revisions keep their reference, so history and restores never show another image.                                                                                                            |
| Broken page after an archive (race) | Saves, publications and restores lock the referenced images `FOR SHARE` and require `ACTIVE`; archiving locks `FOR UPDATE` and refuses an image still referenced by a draft or live revision (archived pages included). Both interleavings are proven with a held transaction.                                                                   |
| Disclosure through public reads     | Public reads return active images only: alternative text, caption, credit, dimensions, focal point and rendition paths. No storage key, no source hash, no STAFF identity. Archived images answer 404.                                                                                                                                           |
| Cross-origin embedding              | `Cross-Origin-Resource-Policy: cross-origin` on the files: the images are public and are shown by the website and by the sandboxed OPS preview (opaque origin). The frontends' CSP adds only the exact API origin to `img-src`, never `*` or a scheme (unit test).                                                                               |
| Integrity of a reused file          | Content-addressed files already present are reused only after their SHA-256 is recomputed and matches.                                                                                                                                                                                                                                           |
| Audit evasion                       | `PUBLIC_MEDIA_UPLOADED`, `PUBLIC_MEDIA_UPDATED` and `PUBLIC_MEDIA_ARCHIVED` are written in the same transaction as the change.                                                                                                                                                                                                                   |

## Privacy

- Images must not show identifiable passengers without their consent.
  This is an editorial rule for the owner, not something the server can
  check. The alternative text and caption must not name a private person.
- STAFF e-mails of authors are visible only to `media.read` holders and in
  the audit trail.

## Residual risks

- libvips is native code. A decoder vulnerability is mitigated by the
  format allow-list, the pixel limit and the dependency audit, but not
  eliminated. Track `sharp` updates (Dependabot, `pnpm audit`).
- The local volume is not replicated: backups are the owner's
  responsibility (`docs/runbooks/public-media-storage.md`).
