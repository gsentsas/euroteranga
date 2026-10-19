# Search-engine indexing of the public website (SEO-1)

Only the public website (`euroteranga.com`) can ever be indexed. Booking,
Client, Tracking, OPS and Crew always answer `robots.txt` with
`Disallow: /` and carry `noindex, nofollow`, whatever the environment.

## Decision rule (fail-closed)

The public website is indexable only when **both** of these hold:

- `NEXT_PUBLIC_APP_ENV=production`;
- `SEO_INDEXING_ENABLED=true` (exactly this value).

In every other case, including today's pilot (`staging`), CI, local
development, a missing or misspelt flag, the site serves:

- `robots.txt` with `Disallow: /` and no sitemap;
- `<meta name="robots" content="noindex, nofollow, nocache">` on every page.

| Variable               | Where              | Default                                                                                |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `SEO_INDEXING_ENABLED` | `public.env` (web) | unset: not indexable                                                                   |
| `PUBLIC_SITE_URL`      | `public.env` (web) | `https://euroteranga.com` in staging and production, `http://localhost:3000` otherwise |

`PUBLIC_SITE_URL` is the canonical origin, used for:

- `metadataBase` and canonical links;
- Open Graph and Twitter URLs;
- the sitemap and JSON-LD.

It must be an origin, without path or query, and HTTPS is required in staging
and production. An invalid explicit value fails the page render instead of
publishing wrong canonical URLs.

The web pages are rendered on the server for each request. Both variables are
therefore read from the running service: changing them needs
`systemctl restart euroteranga-web.service`, not a new build.

## What is published

- **`/robots.txt`:**
  - when indexable, `Allow: /`, the sitemap URL and the host;
  - otherwise, `Disallow: /`.
- **`/sitemap.xml`:** the public pages on the canonical origin. It never
  lists private applications.
- **Metadata:**
  - a unique title (template `%s — EURO TERANGA`), a description and the
    canonical URL;
  - Open Graph and Twitter `summary_large_image`, with generated
    1200×630 PNG images (no price, no date);
  - the `fr_FR` locale and an SVG icon.
- **JSON-LD:** `Organization` and `WebSite` only. There is no rating, review,
  offer or price. `FAQPage` will be added only on a real FAQ page.
- **404 pages:** a French page with a way back, `noindex`, on every
  frontend. The tracking `[token]` route answers 404 for anything that is
  not a well-formed token, so `/robots.txt` and typos are never treated as
  tokens and never reach the API.

## Enabling indexing at commercial go-live

1. Confirm the go-live prerequisites (audit P0 items):
   - legal notice and privacy policy published;
   - real payment provider;
   - final prices and terms.
2. Switch the environment to `production` (a separate go-live decision).
3. Add to `/var/www/vhosts/euroteranga.com/.secrets/public.env`:
   `SEO_INDEXING_ENABLED=true`, and `PUBLIC_SITE_URL=https://euroteranga.com`
   if it differs from the default.
4. `systemctl restart euroteranga-web.service`.
5. Check:
   - `curl -s https://euroteranga.com/robots.txt` shows `Allow: /` and the
     sitemap;
   - the homepage has no `noindex` meta.

To withdraw the site from search engines, remove the flag (or set any other
value) and restart: robots.txt and the meta directive close again.
