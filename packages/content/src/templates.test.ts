import { describe, expect, it } from 'vitest';
import { pageDocumentSchema } from './schemas.js';
import { PAGE_TEMPLATES } from './templates.js';

const cargoTemplate = PAGE_TEMPLATES.find((template) => template.id === 'cargo-freight');

describe('cargo and freight public page template (WEB-CARGO-1)', () => {
  it('offers a valid, indexable /fret template with complete search metadata', () => {
    expect(cargoTemplate).toBeDefined();
    expect(cargoTemplate).toMatchObject({ label: 'Colis & fret', path: '/fret' });
    const document = pageDocumentSchema.parse(cargoTemplate!.document);
    expect(document.seo).toEqual({
      title: 'Colis & fret Paris ↔ Dakar — EURO TERANGA',
      description:
        'Envoyez vos colis et votre fret routier entre Paris et Dakar avec EURO TERANGA : prise en charge, suivi sécurisé et devis adapté à votre envoi.',
      indexable: true,
    });
  });

  it('keeps every section-nav target real and every anchor unique', () => {
    const document = pageDocumentSchema.parse(cargoTemplate!.document);
    const anchors = document.blocks.flatMap((block) => (block.anchor ? [block.anchor] : []));
    expect(new Set(anchors).size).toBe(anchors.length);
    const nav = document.blocks.find((block) => block.type === 'sectionNav');
    expect(nav?.items.map((item) => item.anchor)).toEqual([
      'services',
      'fonctionnement',
      'directions',
      'suivi',
      'questions',
    ]);
    for (const item of nav?.items ?? []) expect(anchors).toContain(item.anchor);
  });

  it('contains no timetable, public amount, cargo booking, lookup or offer', () => {
    const document = pageDocumentSchema.parse(cargoTemplate!.document);
    expect(document.blocks.some((block) => block.type === 'departures')).toBe(false);
    expect(document.blocks.some((block) => block.type === 'routes')).toBe(false);

    const links = document.blocks.flatMap((block) => {
      if (block.type === 'hero') return [block.primaryCta, block.secondaryCta];
      if (block.type === 'cta') return [block.button];
      if (block.type === 'textImage') return [block.cta];
      if (block.type === 'cards') return block.items.map((item) => item.link);
      return [];
    });
    expect(links.filter(Boolean).every((link) => link!.target.kind === 'anchor')).toBe(true);

    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/€|\bEUR\b|\bXOF\b|\/\s*(?:kg|m(?:³|3))|\bprice\b|\btarif\b/i);
    expect(serialized).not.toMatch(/AggregateOffer|Offer|priceCurrency|lowPrice|highPrice/i);
    expect(serialized).not.toMatch(
      /ETC-|bookingReference|sender|recipient|customerIdentityId|declaredContents|declaredValue|dimensions|actorId|vehicleId|publicToken|latitude|longitude|phone/i,
    );
    expect(serialized).not.toMatch(/\b\d+(?:[.,]\d+)?\s*(?:€|euros?|francs?|kg|m(?:³|3))\b/i);
  });
});


const HELP_TEMPLATE_EXPECTATIONS = [
  ['baggage', 'Bagages', '/bagages'],
  ['how-it-works', 'Comment ça marche', '/comment-ca-marche'],
  ['faq', 'FAQ', '/faq'],
  ['about', 'À propos', '/a-propos'],
] as const;

describe('public help page templates (WEB-2A)', () => {
  it('offers four valid indexable CMS templates on the expected public paths', () => {
    for (const [id, label, path] of HELP_TEMPLATE_EXPECTATIONS) {
      const template = PAGE_TEMPLATES.find((candidate) => candidate.id === id);
      expect(template).toBeDefined();
      expect(template).toMatchObject({ id, label, path });
      const document = pageDocumentSchema.parse(template!.document);
      expect(document.seo.indexable).toBe(true);
      expect(document.seo.title).toBeTruthy();
      expect(document.seo.description).toBeTruthy();
      expect(document.blocks[0]).toMatchObject({ type: 'hero', variant: 'page' });
    }
  });

  it('contains no hard-coded owner contact, legal identity, amount or quantitative baggage promise', () => {
    const serialized = JSON.stringify(
      HELP_TEMPLATE_EXPECTATIONS.map(([id]) =>
        pageDocumentSchema.parse(PAGE_TEMPLATES.find((template) => template.id === id)!.document),
      ),
    );

    expect(serialized).not.toMatch(/https?:\/\/|mailto:|tel:|\+\d{6,}/i);
    expect(serialized).not.toMatch(
      /SIREN|SIRET|RCS|numéro de TVA|capital social|directeur de publication/i,
    );
    expect(serialized).not.toMatch(/\b\d+(?:[.,]\d+)?\s*(?:€|EUR|XOF|kg|kilos?|bagages?)\b/i);
    expect(serialized).not.toMatch(/24\s*\/\s*7|garanti(?:e)?|illimité(?:e)?|bagage gratuit/i);
    expect(serialized).not.toContain('"kind":"url"');
  });

  it('keeps baggage limits explicitly outside the template rather than inventing them', () => {
    const baggage = pageDocumentSchema.parse(
      PAGE_TEMPLATES.find((template) => template.id === 'baggage')!.document,
    );
    const serialized = JSON.stringify(baggage);
    expect(serialized).toContain('ne fixe ni franchise, ni poids maximal, ni supplément');
    expect(serialized).toContain('Seules les conditions communiquées pour votre départ');
  });

  it('has one visible FAQ block whose questions are suitable for FAQPage structured data', () => {
    const faq = pageDocumentSchema.parse(
      PAGE_TEMPLATES.find((template) => template.id === 'faq')!.document,
    );
    const blocks = faq.blocks.filter((block) => block.type === 'faq');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.items).toHaveLength(5);
    expect(new Set(blocks[0]!.items.map((item) => item.question)).size).toBe(5);
  });
});
