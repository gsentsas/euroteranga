import {
  DEFAULT_HOME_PAGE,
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  pageDocumentSchema,
} from '@euroteranga/content';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { siteMediaOf, type SiteContext } from './blocks.js';
import { bookingSearchHref, localDate, seatsLabel, type SiteDeparture } from './departures.js';
import { formatPrice } from './money.js';
import { SitePage } from './shell.js';

const ctx = (overrides: Partial<SiteContext> = {}): SiteContext => ({
  settings: DEFAULT_SITE_SETTINGS,
  navigation: DEFAULT_NAVIGATION,
  apps: {
    booking: 'https://booking.example/',
    client: 'https://client.example/',
    tracking: 'https://tracking.example/',
  },
  fromPrices: {},
  year: 2030,
  ...overrides,
});

const home = pageDocumentSchema.parse(DEFAULT_HOME_PAGE);
const render = (document = home, context = ctx()) =>
  renderToStaticMarkup(<SitePage title={document.title} blocks={document.blocks} ctx={context} />);

describe('public website rendering', () => {
  it('renders the default home page with exactly one H1 and resolved links', () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(
      'Voyagez entre l’Europe et l’Afrique <span class="public-hero__accent">en toute confiance</span>',
    );
    expect(html).toContain('action="https://booking.example/"');
    expect(html).toContain('href="https://booking.example/"');
    expect(html).toContain('href="https://client.example/"');
    expect(html).toContain('href="https://tracking.example/"');
    expect(html).toContain('href="#trajets"');
    expect(html).toContain('id="aide"');
    expect(html).toContain('<details>');
    expect(html).toContain('© 2030 EURO TERANGA');
  });

  // A page with the journey card and the routes, both priced by Pricing only.
  const priced = pageDocumentSchema.parse({
    title: 'Lignes',
    seo: { description: 'Description.' },
    blocks: [
      { type: 'hero', title: 'Paris ↔ Dakar', journeyCard: true },
      {
        type: 'routes',
        title: 'Nos lignes',
        items: [
          { direction: 'PAR-DKR', label: 'Aller', title: 'Paris vers Dakar', text: 'Texte.' },
          { direction: 'DKR-PAR', label: 'Retour', title: 'Dakar vers Paris', text: 'Texte.' },
        ],
      },
    ],
  });

  it('never shows a price that Pricing did not provide', () => {
    expect(render()).not.toMatch(/\d\s?€/);
    const html = render(priced);
    expect(html).not.toMatch(/\d\s?€/);
    expect(html).toContain('Tarif affiché à la réservation');
    expect(html).toContain('affichés à la réservation');
  });

  it('shows the Pricing "from" price of each direction when available', () => {
    const html = render(
      priced,
      ctx({
        fromPrices: {
          'PAR-DKR': { amountMinor: 24_900, currencyCode: 'EUR', currencyMinorUnit: 2 },
          'DKR-PAR': { amountMinor: 26_950, currencyCode: 'EUR', currencyMinorUnit: 2 },
        },
      }),
    );
    expect(html).toContain('249');
    expect(html).toContain('269,50');
    expect(
      formatPrice({ amountMinor: 150_000, currencyCode: 'XOF', currencyMinorUnit: 0 }),
    ).toMatch(/150\s000/);
  });

  it('renders editor text as text: markup is escaped, never interpreted', () => {
    const page = pageDocumentSchema.parse({
      title: 'Page',
      seo: { description: 'Description.' },
      blocks: [
        { type: 'banner', text: '<img src=x onerror=alert(1)>' },
        {
          type: 'richText',
          body: [
            {
              kind: 'paragraph',
              spans: [
                {
                  text: '<script>alert(1)</script>',
                  bold: true,
                  link: { kind: 'page', path: '/aide' },
                },
              ],
            },
          ],
        },
      ],
    });
    const html = render(page);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<a href="/aide"><strong>');
    // A page without hero gets its title as the single H1.
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('<h1>Page</h1>');
  });

  it('omits media that the library cannot resolve and shows owner contact only when set', () => {
    const page = pageDocumentSchema.parse({
      title: 'Page',
      seo: { description: 'Description.' },
      blocks: [{ type: 'image', mediaId: '01900000-0000-7000-8000-000000000001' }],
    });
    expect(render(page)).not.toContain('<img');
    const withMedia = render(
      page,
      ctx({ media: () => ({ src: '/media/x.webp', alt: 'Autocar', width: 1200, height: 800 }) }),
    );
    expect(withMedia).toContain('alt="Autocar"');
    expect(withMedia).toContain('loading="lazy"');
    expect(withMedia).toContain('width="1200"');
    expect(render()).not.toContain('public-footer__contact');
    const contact = render(
      home,
      ctx({
        settings: {
          ...DEFAULT_SITE_SETTINGS,
          contact: { ...DEFAULT_SITE_SETTINGS.contact, email: 'contact@example.org' },
        },
      }),
    );
    expect(contact).toContain('contact@example.org');
  });
  it('renders responsive WebP images with focal point, caption and credit (MEDIA-1)', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    const media = siteMediaOf(
      {
        altText: 'Autocar au départ',
        caption: 'Gare routière',
        credit: 'Euro Teranga',
        width: 2000,
        height: 1000,
        focalX: 30,
        focalY: 70,
        renditions: [
          { width: 1600, path: `/v1/media/files/${id}/1600.webp` },
          { width: 480, path: `/v1/media/files/${id}/480.webp` },
          { width: 960, path: `/v1/media/files/${id}/960.webp` },
          { width: 2000, path: `/v1/media/files/${id}/2000.webp` },
        ],
      },
      (path) => `https://api.example${path}`,
    );
    expect(media.src).toBe(`https://api.example/v1/media/files/${id}/960.webp`);
    expect(media.srcSet).toBe(
      [480, 960, 1600, 2000]
        .map((width) => `https://api.example/v1/media/files/${id}/${width}.webp ${width}w`)
        .join(', '),
    );
    const page = pageDocumentSchema.parse({
      title: 'Galerie',
      seo: { description: 'Description.' },
      blocks: [
        { type: 'hero', title: 'Paris ↔ Dakar', mediaId: id, journeyCard: false },
        { type: 'gallery', items: [{ mediaId: id, caption: 'Légende du bloc' }] },
      ],
    });
    const html = render(page, ctx({ media: (wanted) => (wanted === id ? media : null) }));
    // The hero photo is the full-width backdrop: never lazy, preloaded, decorative.
    expect(html).toContain('class="public-hero public-hero--photo"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toMatch(/<img class="public-hero__photo"[^>]*sizes="100vw"[^>]*alt=""/);
    expect(html).toContain('<link rel="preload" as="image"');
    expect(html).toContain('sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw"');
    expect(html).toContain('object-position:30% 70%');
    // The block caption wins over the library caption; the credit is always shown,
    // on the hero backdrop too.
    expect(html).toContain('Légende du bloc');
    expect(html).toContain('<p class="public-hero__credit">Crédit photo : Euro Teranga</p>');
    expect(html.match(/Crédit photo : Euro Teranga/g)).toHaveLength(2);
    const centred = render(
      page,
      ctx({ media: () => ({ ...media, focalX: 50, focalY: 50, credit: null, caption: null }) }),
    );
    expect(centred).not.toContain('object-position');
    expect(centred).not.toContain('Crédit photo');
  });
});

describe('homepage blocks (UI-PUBLIC-1)', () => {
  const stops = [
    {
      code: 'DKR',
      name: 'Gare routière',
      locality: 'Dakar',
      countryName: 'Sénégal',
      timezone: 'Africa/Dakar',
    },
    {
      code: 'PAR',
      name: 'Gare routière',
      locality: 'Paris',
      countryName: 'France',
      timezone: 'Europe/Paris',
    },
  ];
  const [dakar, paris] = stops as [(typeof stops)[0], (typeof stops)[0]];
  const fare = (euros: number) => ({
    amountMinor: euros * 100,
    currencyCode: 'EUR',
    currencyMinorUnit: 2,
  });
  const departures: Record<string, SiteDeparture[]> = {
    'PAR>DKR': [
      // 00:30 in Paris on 12 November is still 11 November in UTC.
      {
        tripId: 't1',
        from: paris,
        to: dakar,
        departureAt: '2030-11-11T23:30:00.000Z',
        availableSeats: 3,
        fare: fare(249),
      },
      {
        tripId: 't3',
        from: paris,
        to: dakar,
        departureAt: '2030-12-10T07:00:00.000Z',
        availableSeats: 0,
        fare: fare(249),
      },
      {
        tripId: 't4',
        from: paris,
        to: dakar,
        departureAt: '2030-12-20T07:00:00.000Z',
        availableSeats: 40,
        fare: fare(259),
      },
    ],
    'DKR>PAR': [
      {
        tripId: 't2',
        from: dakar,
        to: paris,
        departureAt: '2030-11-26T08:00:00.000Z',
        availableSeats: 1,
        fare: fare(269),
      },
    ],
  };
  const lookup = (from: string, to: string) => departures[`${from}>${to}`] ?? [];
  const homeCtx = ctx({ stops, departures: lookup, today: '2030-11-01' });

  it('searches trips through a plain form that opens the booking application pre-filled', () => {
    const html = render(home, homeCtx);
    const form = html.match(/<form class="public-search"[^>]*>/)?.[0] ?? '';
    for (const attribute of [
      'method="get"',
      'action="https://booking.example/"',
      'role="search"',
    ]) {
      expect(form).toContain(attribute);
    }
    expect(html).toMatch(
      /<select id="public-search-from" name="from">.*<option value="PAR" selected="">Paris · Gare routière<\/option>/,
    );
    expect(html).toMatch(
      /<select id="public-search-to" name="to">.*<option value="DKR" selected="">Dakar · Gare routière<\/option>/,
    );
    expect(html).toMatch(
      /<input id="public-search-date"(?=[^>]*name="date")(?=[^>]*type="date")[^>]*min="2030-11-01"/,
    );
    expect(html.match(/<option value="\d"( selected="")?>/g)).toHaveLength(8);
    for (const label of ['Départ', 'Arrivée', 'Date aller', 'Voyageurs']) {
      expect(html).toContain(label);
    }
    // Without the stops API, the configured stops are still offered.
    expect(render(home, ctx())).toContain('<option value="PAR" selected="">PAR</option>');
  });

  it('lists the soonest bookable departures with Pricing fares, local times and a pre-filled booking link', () => {
    const html = render(home, homeCtx);
    const cards = html.match(/<li class="public-departure">/g) ?? [];
    expect(cards).toHaveLength(3);
    // Soonest first, full trips left out.
    expect(html.indexOf('t1') === -1).toBe(true);
    expect(html.indexOf('12 nov. 2030')).toBeLessThan(html.indexOf('26 nov. 2030'));
    expect(html).not.toContain('10 déc. 2030');
    expect(html).toContain(
      '<time dateTime="2030-11-11T23:30:00.000Z">mar. 12 nov. 2030</time> · 00:30',
    );
    expect(html).toMatch(/249\s€<\/strong> par place/);
    expect(html).toContain('Plus que 3 places');
    expect(html).toContain('Dernière place disponible');
    expect(html).toContain(
      'href="https://booking.example/?from=PAR&amp;to=DKR&amp;date=2030-11-12"',
    );
    expect(html).toContain(
      'href="https://booking.example/?from=DKR&amp;to=PAR&amp;date=2030-11-26"',
    );
    expect(html).toContain(
      'Réserver<span class="et-visually-hidden"> : Paris → Dakar, mar. 12 nov. 2030</span>',
    );
  });

  it('says so when no departure is open, or when the trip search cannot answer', () => {
    expect(render(home, ctx({ departures: () => [] }))).toContain(
      'Les prochains départs seront affichés ici dès leur ouverture à la réservation.',
    );
    expect(render(home, ctx({ departures: () => null }))).toContain(
      'Les prochains départs ne peuvent pas être affichés pour le moment',
    );
    expect(render(home, ctx())).not.toContain('public-departure"');
  });

  it('renders the strengths row, the navy story card and the mobile menu', () => {
    const html = render(home, homeCtx);
    expect(html).toContain('<section class="public-highlights" aria-labelledby="section-1-title">');
    expect(html).toContain(
      '<h2 id="section-1-title" class="et-visually-hidden">Pourquoi voyager avec EURO TERANGA</h2>',
    );
    expect(html.match(/public-highlights__icon/g)).toHaveLength(6);
    expect(html).toContain('public-text-image--tone-navy');
    expect(html).toContain(
      'class="public-button public-button--gold" href="https://booking.example/">Rechercher un voyage',
    );
    expect(html).toMatch(
      /<details class="public-menu"><summary class="public-menu__toggle">.*<span>Menu<\/span><\/summary><nav class="public-menu__panel" aria-label="Navigation principale \(mobile\)">/,
    );
  });
});

describe('departure helpers (UI-PUBLIC-1)', () => {
  it('dates a departure in its origin timezone and keeps the booking base', () => {
    expect(localDate('2030-11-11T23:30:00.000Z', 'Europe/Paris')).toBe('2030-11-12');
    expect(localDate('2030-11-11T23:30:00.000Z', 'Africa/Dakar')).toBe('2030-11-11');
    expect(localDate('2030-11-11T23:30:00.000Z', 'Not/AZone')).toBe('2030-11-11');
    expect(
      bookingSearchHref('https://booking.example/reserver?lang=fr', {
        from: 'PAR',
        to: 'DKR',
        date: '2030-11-12',
        passengers: 2,
      }),
    ).toBe('https://booking.example/reserver?lang=fr&from=PAR&to=DKR&date=2030-11-12&passengers=2');
    expect(seatsLabel(12)).toBe('12 places disponibles');
  });
});
