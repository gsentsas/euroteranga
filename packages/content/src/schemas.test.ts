import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_PAGE, DEFAULT_NAVIGATION, DEFAULT_SITE_SETTINGS } from './defaults.js';
import {
  BLOCK_TYPES,
  contentPathSchema,
  documentSchemaOf,
  linkSchema,
  mediaIdsOf,
  mediaReferencesOf,
  missingOwnerInputs,
  navigationSchema,
  pageDocumentSchema,
  siteSettingsSchema,
} from './schemas.js';

const page = (blocks: unknown[]) => ({
  title: 'Page',
  seo: { description: 'Description de la page.' },
  blocks,
});

describe('content model', () => {
  it('accepts the default content and fills block defaults', () => {
    const home = pageDocumentSchema.parse(DEFAULT_HOME_PAGE);
    expect(home.blocks[0]).toMatchObject({
      type: 'hero',
      journeyCard: false,
      search: { fromCode: 'PAR', toCode: 'DKR' },
    });
    expect(home.blocks.map((block) => block.type)).toContain('departures');
    expect(home.seo.indexable).toBe(true);
    expect(siteSettingsSchema.parse(DEFAULT_SITE_SETTINGS)).toEqual(DEFAULT_SITE_SETTINGS);
    expect(navigationSchema.parse(DEFAULT_NAVIGATION)).toEqual(DEFAULT_NAVIGATION);
    expect(documentSchemaOf('PAGE')).toBe(pageDocumentSchema);
  });

  it('never invents owner information: missing values are listed', () => {
    const missing = missingOwnerInputs(DEFAULT_SITE_SETTINGS);
    expect(missing).toContain('contact.email');
    expect(missing).toContain('legal.companyName');
    expect(missing).toContain('legal.hostName');
    expect(missing).toHaveLength(14);
  });

  it('accepts lowercase public paths and refuses reserved, odd or unsafe ones', () => {
    for (const path of ['/', '/paris-dakar', '/aide/bagages', '/a/b/c/d']) {
      expect(contentPathSchema.safeParse(path).success, path).toBe(true);
    }
    for (const path of [
      '',
      'paris',
      '/Paris',
      '/paris_dakar',
      '/paris--dakar',
      '/paris/',
      '/../etc',
      '/a/b/c/d/e',
      '/sitemap',
      '/robots',
      '/apercu',
      '/apercu/x',
      '/media/logo',
      '/api',
      '/opengraph-image',
      `/${'a'.repeat(130)}`,
    ]) {
      expect(contentPathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it('only allows typed link targets: no javascript:, data:, mailto: or plain http', () => {
    const ok = (target: unknown) => linkSchema.safeParse({ label: 'Lien', target }).success;
    expect(ok({ kind: 'url', url: 'https://example.org/page' })).toBe(true);
    expect(ok({ kind: 'page', path: '/paris-dakar' })).toBe(true);
    expect(ok({ kind: 'app', app: 'booking' })).toBe(true);
    expect(ok({ kind: 'anchor', id: 'trajets' })).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'mailto:a@b.c',
      'http://example.org',
      'https://user:pass@example.org',
      '//example.org',
      '/relative',
    ]) {
      expect(ok({ kind: 'url', url }), url).toBe(false);
    }
    expect(ok({ kind: 'app', app: 'ops' })).toBe(false);
    expect(ok({ kind: 'anchor', id: 'Bad Anchor' })).toBe(false);
    expect(ok({ kind: 'page', path: '/x', extra: true })).toBe(false);
  });

  it('refuses unknown blocks, unknown fields and HTML-like attributes', () => {
    expect(pageDocumentSchema.safeParse(page([{ type: 'html', html: '<script>' }])).success).toBe(
      false,
    );
    expect(
      pageDocumentSchema.safeParse(page([{ type: 'banner', text: 'Info', onClick: 'alert(1)' }]))
        .success,
    ).toBe(false);
    expect(
      pageDocumentSchema.safeParse({ ...page([]), dangerouslySetInnerHTML: { __html: 'x' } })
        .success,
    ).toBe(false);
    // Text stays text: markup is accepted as characters, never interpreted.
    const parsed = pageDocumentSchema.parse(page([{ type: 'banner', text: '<b>Annonce</b>' }]));
    expect(parsed.blocks[0]).toMatchObject({ text: '<b>Annonce</b>' });
  });

  it('bounds every list and string', () => {
    const tooMany = Array.from({ length: 41 }, () => ({ type: 'banner', text: 'Info' }));
    expect(pageDocumentSchema.safeParse(page(tooMany)).success).toBe(false);
    expect(
      pageDocumentSchema.safeParse(page([{ type: 'banner', text: 'x'.repeat(301) }])).success,
    ).toBe(false);
    expect(
      pageDocumentSchema.safeParse({ ...page([]), seo: { description: 'x'.repeat(171) } }).success,
    ).toBe(false);
  });

  it('refuses duplicate anchors and more than one hero', () => {
    const banner = { type: 'banner', anchor: 'info', text: 'Info' };
    expect(pageDocumentSchema.safeParse(page([banner, banner])).success).toBe(false);
    const hero = { type: 'hero', title: 'Titre' };
    expect(pageDocumentSchema.safeParse(page([hero, hero])).success).toBe(false);
  });

  it('has no price field anywhere: routes only ask for Pricing "from" prices', () => {
    const routes = {
      type: 'routes',
      title: 'Lignes',
      items: [
        {
          direction: 'PAR-DKR',
          label: 'France → Sénégal',
          title: 'Paris vers Dakar',
          text: 'Texte',
          price: 249,
        },
      ],
    };
    expect(pageDocumentSchema.safeParse(page([routes])).success).toBe(false);
    expect(BLOCK_TYPES).toEqual([
      'hero',
      'richText',
      'textImage',
      'image',
      'cta',
      'cards',
      'faq',
      'routes',
      'departures',
      'stats',
      'gallery',
      'banner',
    ]);
  });

  it('reads departures and the hero search from real stops, never from typed data (UI-PUBLIC-1)', () => {
    const departures = {
      type: 'departures',
      title: 'Nos prochains départs',
      routes: [{ fromCode: ' par ', toCode: 'dkr' }],
    };
    const parsed = pageDocumentSchema.parse(page([departures]));
    expect(parsed.blocks[0]).toEqual({
      type: 'departures',
      title: 'Nos prochains départs',
      routes: [{ fromCode: 'PAR', toCode: 'DKR' }],
      limit: 3,
    });
    for (const invalid of [
      { ...departures, routes: [{ fromCode: 'PAR', toCode: 'PAR' }] },
      { ...departures, routes: [{ fromCode: 'PA R', toCode: 'DKR' }] },
      { ...departures, routes: [] },
      { ...departures, limit: 7 },
      // Dates, seats and prices come from Booking and Pricing only.
      { ...departures, routes: [{ fromCode: 'PAR', toCode: 'DKR', price: 249 }] },
      { ...departures, departures: [{ date: '2030-01-01' }] },
    ]) {
      expect(pageDocumentSchema.safeParse(page([invalid])).success, JSON.stringify(invalid)).toBe(
        false,
      );
    }
    const hero = { type: 'hero', title: 'Voyagez', search: { fromCode: 'DKR', toCode: 'DKR' } };
    const refused = pageDocumentSchema.safeParse(page([hero]));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['blocks', 0, 'search', 'toCode']);
    expect(
      pageDocumentSchema.safeParse(
        page([
          {
            type: 'cards',
            variant: 'highlights',
            title: 'Atouts',
            items: [{ title: 'A', text: 'B' }],
          },
        ]),
      ).success,
    ).toBe(true);
  });

  it('lists the media referenced by a page', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    const other = '01900000-0000-7000-8000-000000000002';
    const parsed = pageDocumentSchema.parse({
      title: 'Page',
      seo: { description: 'Description.', socialMediaId: id },
      blocks: [
        { type: 'image', mediaId: other },
        { type: 'gallery', items: [{ mediaId: id }, { mediaId: other }] },
      ],
    });
    expect(mediaIdsOf(parsed).sort()).toEqual([id, other].sort());
    // Media ids are stored in their canonical lowercase form.
    const capitals = pageDocumentSchema.parse({
      title: 'Page',
      seo: { description: 'Description.', socialMediaId: id.toUpperCase() },
      blocks: [{ type: 'gallery', items: [{ mediaId: other.toUpperCase() }] }],
    });
    expect(mediaIdsOf(capitals).sort()).toEqual([id, other].sort());
    // Service card photos and destination photos are media references too.
    const withCards = pageDocumentSchema.parse({
      title: 'Page',
      seo: { description: 'Description.' },
      blocks: [
        {
          type: 'cards',
          variant: 'services',
          title: 'Services',
          items: [{ title: 'A', text: 'B', mediaId: id }],
        },
        {
          type: 'departures',
          title: 'Départs',
          routes: [{ fromCode: 'PAR', toCode: 'DKR', mediaId: other }],
        },
      ],
    });
    expect(mediaReferencesOf(withCards)).toEqual([
      { path: 'blocks.0.items.0.mediaId', mediaId: id },
      { path: 'blocks.1.routes.0.mediaId', mediaId: other },
    ]);
    // MEDIA-1 reports each reference with its field path, duplicates included.
    expect(mediaReferencesOf(parsed)).toEqual([
      { path: 'seo.socialMediaId', mediaId: id },
      { path: 'blocks.0.mediaId', mediaId: other },
      { path: 'blocks.1.items.0.mediaId', mediaId: id },
      { path: 'blocks.1.items.1.mediaId', mediaId: other },
    ]);
  });

  it('keeps owner fields nullable and validates contact and social values', () => {
    const settings = structuredClone(DEFAULT_SITE_SETTINGS);
    settings.contact.email = 'not-an-email';
    expect(siteSettingsSchema.safeParse(settings).success).toBe(false);
    settings.contact.email = 'contact@example.org';
    expect(siteSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      siteSettingsSchema.safeParse({
        ...DEFAULT_SITE_SETTINGS,
        social: [{ network: 'facebook', url: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });
});
