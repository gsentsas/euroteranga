# Public website design system (UI-PUBLIC-1)

The public website (`apps/web`) and the OPS preview render the same
components (`@euroteranga/site`) with the same stylesheet
(`packages/site/styles/site.css`).

The visual target is the approved mockup: navy, royal blue, white and gold,
large photographs, the EURO TERANGA coach, Europe ↔ Africa. It is a target,
not a pixel-perfect specification. Departures from it have a UX reason.

## Tokens (`:root` in `site.css`)

| Group      | Tokens                                                                        | Use                                                                |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Navy       | `--public-navy-950` … `-700`                                                  | Hero, strengths row, navy cards, footer, titles                    |
| Royal blue | `--public-royal-600/500`, `-100/50` tints                                     | Links, kickers, focus ring, icon chips, hover                      |
| Gold       | `--public-gold-600/500/400`, `-100` tint                                      | Primary actions ("Réserver", "Rechercher"), accents, icons on navy |
| Neutrals   | `--public-ink`, `--public-muted`, `--public-line`, `--public-surface(-muted)` | Text, borders, alternating sections                                |
| Radius     | `--public-radius-sm`, `--public-radius`, `-lg`, `-xl`                         | Fields, buttons, cards, large panels                               |
| Shadows    | `--public-shadow-sm`, `--public-shadow`, `-lg`                                | Cards, panels, the hero search                                     |
| Rhythm     | `--public-space-section`, `--public-header-height`                            | Section padding, sticky header and anchor offset                   |

**Contrast rules (WCAG 2.2 AA):**

- text on gold is always navy (about 10:1);
- muted text on white is 6.5:1;
- white text on navy, and on the photo veil, passes AA.

The visual acceptance measures contrast on every page width.

## Components

- **Buttons** (`public-button`):
  - `--gold` is the primary action;
  - default navy is the secondary action on light backgrounds;
  - `--secondary` is outlined on white;
  - `--ghost` is outlined on navy or photos.

  Every button is at least 44 px high (48 px for the search submit).

- **Focus:** a 3 px royal outline, gold on dark surfaces. It is never removed.
- **Header:** sticky, white:
  - the brand, the CMS navigation, "Mon compte", and "Réserver" in gold;
  - below 1024 px, the navigation moves into a `<details>` disclosure, which
    works with the keyboard and screen readers without any script.
- **Hero:**
  - a media-library photograph under a navy veil (lighter on the right on
    desktop, full on phones), with the focal point applied;
  - without a photo, a navy gradient with the coach illustration;
  - the photo is `fetchpriority="high"` and preloaded; the photo credit is
    shown.
- **Trip search:** a plain GET form to Booking, with labelled fields
  (Départ, Arrivée, Date aller, Voyageurs):
  - one row from 1024 px;
  - two columns on tablets;
  - one column on phones.
- **Strengths row** (`cards` variant `highlights`): navy band; icon, title and
  short text; 6, 3, 2 then 1 per row.
- **Departures:** photo or navy placeholder, route, local date and time,
  Pricing fare, seats left, and a gold "Réserver"; 3, 2 then 1 per row.
- **Navy card** (`textImage` with `tone: navy`): the Teranga story, with a
  gold call to action.
- **Cards:** white, bordered, soft shadow. Services can carry a photograph.
  Steps are numbered in gold.
- **Footer:** navy; gold column titles; owner contact only when provided.

## Breakpoints

Checked at 1440, 1280, 1024, 820 (tablet), 430, 390 and 375 px:

- **80rem (1280 px):** the strengths row wraps to 3 per row.
- **64rem (1024 px):** mobile navigation; 2-column search, departures and
  cards.
- **48rem (768 px):** single-column sections; the photo veil covers the
  whole hero.
- **30rem (480 px):** single-column search, strengths and footer; the menu
  button shows its icon only (its name stays readable by screen readers).

## Performance

- Pages are rendered on the server. The home page ships no client
  JavaScript of its own: the search is a form, and the menu is a
  `<details>` element.
- Images are WebP renditions of the media library (480 to 2400 px) with
  `srcset`, `sizes` per use and explicit dimensions (no layout shift):
  - the hero image is the LCP element, never lazy;
  - all other images are lazy.

  `next/image` is not used: the renditions are already resized and
  re-encoded by the API, and re-optimizing them would only add latency.

- No web font is loaded (system stack); the brand typeface remains an
  owner decision.
- `prefers-reduced-motion` removes transitions and hover movements.

## Data rules

Nothing on these pages is invented:

- Content comes from the CMS, images from the media library and fares
  from Pricing.
- Departures and seats left come from the public trip search.
- Figures, reviews and on-board equipment appear only when the owner
  provides them.
- Until real photographs are uploaded, the hero uses the navy backdrop and
  departures use placeholders.
