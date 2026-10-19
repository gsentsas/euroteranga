import {
  DEFAULT_HOME_PAGE,
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  pageDocumentSchema,
} from '@euroteranga/content';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { siteMediaOf, type SiteContext } from './blocks.js';
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
    expect(html).toContain('Paris ↔ Dakar, la route qui rapproche.');
    expect(html).toContain('href="https://booking.example/"');
    expect(html).toContain('href="https://client.example/"');
    expect(html).toContain('href="https://tracking.example/"');
    expect(html).toContain('href="#trajets"');
    expect(html).toContain('id="aide"');
    expect(html).toContain('<details>');
    expect(html).toContain('© 2030 EURO TERANGA');
  });

  it('never shows a price that Pricing did not provide', () => {
    const html = render();
    expect(html).not.toMatch(/\d\s?€/);
    expect(html).toContain('Tarif affiché à la réservation');
    expect(html).toContain('affichés à la réservation');
  });

  it('shows the Pricing "from" price of each direction when available', () => {
    const html = render(
      home,
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
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('sizes="(max-width: 900px) 100vw, 50vw"');
    expect(html).toContain('sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw"');
    expect(html).toContain('object-position:30% 70%');
    // The block caption wins over the library caption; the credit is always shown.
    expect(html).toContain('Gare routière');
    expect(html).toContain('Légende du bloc');
    expect(html.match(/Crédit photo : Euro Teranga/g)).toHaveLength(2);
    const centred = render(
      page,
      ctx({ media: () => ({ ...media, focalX: 50, focalY: 50, credit: null, caption: null }) }),
    );
    expect(centred).not.toContain('object-position');
    expect(centred).not.toContain('Crédit photo');
  });
});
