# Public media storage (MEDIA-1)

The files of the website's media library are WebP renditions re-encoded
without metadata. They are public by nature and hold no personal data.
They are still served **only through the Core API**, never by the web
server, and they live **outside releases**: a deployment or rollback must
not lose them.

The library is disabled by default (`PUBLIC_MEDIA_STORAGE=DISABLED`): OPS
shows it read-only and uploads answer `MEDIA_STORAGE_DISABLED`.

## Safety rules

- The public media directory is never the passenger-document root, never
  inside it and never contains it. Configuration refuses an overlap.
- Never point it at `httpdocs/`, `public/`, `static/` or an `uploads/`
  directory, and never create an nginx location for it. Configuration
  refuses those names.
- Never edit, replace or delete a file by hand. Files are content-addressed
  (`public-media/<2 hex>/<sha256>`) and referenced by immutable rows. To
  change an image, upload a new one in OPS and archive the old one.
- Never update or delete `public_media_asset` / `public_media_rendition`
  rows by hand. Triggers refuse deletion, changes to source facts and any
  change to an archived asset.

## Enable on the pilot (owner or root)

The service user of the API (`euroteranga.com_5p804yhows7`, see
`infrastructure/plesk/systemd/euroteranga-api.service`) must own the
directory. `ProtectSystem=full` keeps `/var` writable, and `PrivateTmp`
makes `/tmp` unsuitable.

1. Create the directory outside the releases, owner-only:

   ```bash
   install -d -m 0700 -o euroteranga.com_5p804yhows7 -g psacln /var/www/vhosts/euroteranga.com/media-library
   ```

2. Add to `/var/www/vhosts/euroteranga.com/.secrets/api.env`:

   ```
   PUBLIC_MEDIA_STORAGE=LOCAL
   PUBLIC_MEDIA_LOCAL_ROOT=/var/www/vhosts/euroteranga.com/media-library
   # Optional: PUBLIC_MEDIA_MAX_BYTES=10485760 PUBLIC_MEDIA_MAX_PIXELS=40000000
   ```

3. Restart the API (`systemctl restart euroteranga-api`). The service
   refuses to start on an invalid configuration (relative path, web or
   upload directory, overlap with the passenger-document root), and the
   error names the variable.
4. In OPS → Médiathèque, the import button appears. Upload one test image,
   check it on a draft page in the preview, then archive it if it is not
   needed.

To disable again, set `PUBLIC_MEDIA_STORAGE=DISABLED` and restart. Stored
files and rows stay, but published images are no longer served (404) until
storage is enabled again with the same root.

## Capacity

An image takes the sum of its renditions:

- typically 100–600 KB for a photograph;
- up to four files (480, 960, 1600 and 2400 px wide).

The uploaded original is not kept. Check the volume with
`du -sh /var/www/vhosts/euroteranga.com/media-library`.

## Backup and restore

Back up the directory together with the database: rows without files answer
404, and files without rows are unused.

- **Files:** copy the directory (for example
  `tar -C /var/www/vhosts/euroteranga.com -czf media-library-<date>.tgz media-library`)
  at the time of the database dump.
- **Restore:** restore the database dump, then the directory, with the same
  owner and modes (`0700` directories, `0600` files).

## Reconcile (read-only)

1. List the expected files in a read-only database session:

   ```sql
   SELECT DISTINCT storage_key
   FROM public_media_rendition r
   JOIN public_media_asset a ON a.id = r.asset_id
   WHERE a.status = 'ACTIVE'
   ORDER BY storage_key;
   ```

2. For each key, the file `<root>/<storage_key>` must exist, and its SHA-256
   (`sha256sum`) must equal the last path segment. A missing or different
   file is an integrity incident: do not replace it with another file.
   Restore it from the backup, or have editors upload the image again and
   switch the contents to the new asset.
3. A file with no row can come from an upload interrupted between storage
   and the database transaction. It is harmless and never served. Keep it,
   or remove it only after proving that no row references its key in the
   database and its backups.

## Errors

| Symptom                                  | Cause and action                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MEDIA_STORAGE_DISABLED` (503) on upload | Storage disabled: expected by default, enable it as above if the owner wants uploads       |
| `MEDIA_UNAVAILABLE` (503)                | Root not writable by the service user, a symlink or not a directory: check owner and modes |
| `MEDIA_BUSY` (503)                       | Two images already being processed: wait a few seconds                                     |
| `MEDIA_IMAGE_TOO_LARGE` (422)            | Over `PUBLIC_MEDIA_MAX_PIXELS`: reduce the image dimensions before uploading               |
| Images missing on the website, API up    | Image archived, or file missing: check the asset status in OPS, then reconcile             |
