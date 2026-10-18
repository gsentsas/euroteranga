import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_PAGE, DEFAULT_NAVIGATION, DEFAULT_SITE_SETTINGS } from './defaults.js';
import {
  BLOCK_TYPES,
  contentPathSchema,
  documentSchemaOf,
  linkSchema,
  mediaIdsOf,
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
    expect(home.blocks[0]).toMatchObject({ type: 'hero', journeyCard: true });
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
      'stats',
      'gallery',
      'banner',
    ]);
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
