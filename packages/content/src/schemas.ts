import { z } from 'zod';

/**
 * CMS-1: the structured content model of the public website.
 *
 * Content is data, never markup. There is no HTML, script, style or free
 * attribute anywhere: text is rendered as React text, links are typed
 * targets, and rich text is a small tree of paragraphs, headings and lists
 * with bold, italic and link marks. Every string and every list is bounded.
 *
 * Prices are deliberately absent: Pricing (PR-08) is the only source of
 * fares. A `routes` block can ask the website to show the "from" price of
 * each direction, read from the public search API at render time.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();
/**
 * A media id, stored in its canonical lowercase form: usage lookups and
 * comparisons with PostgreSQL uuid values are exact.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());

/** Public paths: `/`, `/paris-dakar`, `/aide/bagages`. Lowercase, digits, dashes. */
export const CONTENT_PATH_PATTERN =
  /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3})?$/;

/** Paths owned by the website itself (metadata routes, preview, assets). */
export const RESERVED_CONTENT_PATHS = [
  '/apercu',
  '/api',
  '/icon',
  '/media',
  '/opengraph-image',
  '/robots',
  '/sitemap',
  '/twitter-image',
] as const;

export const contentPathSchema = z
  .string()
  .trim()
  .max(120)
  .regex(CONTENT_PATH_PATTERN, 'chemin public invalide (minuscules, chiffres et tirets)')
  .refine(
    (path) =>
      !RESERVED_CONTENT_PATHS.some(
        (reserved) => path === reserved || path.startsWith(`${reserved}/`),
      ),
    { message: 'chemin réservé par le site' },
  );

const anchorSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,40}$/, 'ancre invalide');

/** Absolute HTTPS URLs only: no javascript:, data:, mailto: or plain http. */
const httpsUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: 'URL https absolue attendue' },
  );

export const APP_TARGETS = ['booking', 'client', 'tracking'] as const;

export const linkTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), path: contentPathSchema }).strict(),
  z.object({ kind: z.literal('app'), app: z.enum(APP_TARGETS) }).strict(),
  z.object({ kind: z.literal('url'), url: httpsUrlSchema }).strict(),
  z.object({ kind: z.literal('anchor'), id: anchorSchema }).strict(),
]);

export const linkSchema = z.object({ label: text(60), target: linkTargetSchema }).strict();

export const spanSchema = z
  .object({
    text: z.string().min(1).max(2000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    link: linkTargetSchema.optional(),
  })
  .strict();

const spansSchema = z.array(spanSchema).min(1).max(50);

export const richNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), spans: spansSchema }).strict(),
  z
    .object({
      kind: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      text: text(160),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(spansSchema).min(1).max(30),
    })
    .strict(),
]);

export const richTextSchema = z.array(richNodeSchema).min(1).max(50);

export const CONTENT_ICONS = [
  'ticket',
  'pin',
  'luggage',
  'shield',
  'bus',
  'clock',
  'support',
  'route',
  'seat',
  'phone',
  'mail',
] as const;

/** Built-in decorative illustrations (original SVG, no external asset). */
export const CONTENT_ILLUSTRATIONS = ['none', 'route', 'tracking', 'coach'] as const;

const sectionHead = {
  anchor: anchorSchema.optional(),
  kicker: optionalText(60),
};

/** A stop of the network, by its code (same rule as the stop table). */
export const stopCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, { message: 'code d’arrêt invalide' });

/** Two different stops, by code: a direction of travel. */
const directionSchema = {
  fromCode: stopCodeSchema,
  toCode: stopCodeSchema,
};

const differentStops = (value: { fromCode: string; toCode: string }) =>
  value.fromCode !== value.toCode;

export const heroBlockSchema = z
  .object({
    type: z.literal('hero'),
    ...sectionHead,
    eyebrow: optionalText(80),
    title: text(140),
    /** Second line of the title, highlighted (UI-PUBLIC-1). */
    titleAccent: optionalText(80),
    lead: optionalText(400),
    primaryCta: linkSchema.optional(),
    secondaryCta: linkSchema.optional(),
    note: optionalText(240),
    /** Background photograph (media library); a navy backdrop without it. */
    mediaId: uuid.optional(),
    /** Show the Paris ↔ Dakar journey card next to the title. */
    journeyCard: z.boolean().default(true),
    /**
     * Trip search form in the hero, pre-filled with this direction. It
     * opens the booking application with ?from=&to=&date=&passengers=.
     */
    search: z
      .object(directionSchema)
      .strict()
      .refine(differentStops, { message: 'deux arrêts différents', path: ['toCode'] })
      .optional(),
  })
  .strict();

export const richTextBlockSchema = z
  .object({
    type: z.literal('richText'),
    ...sectionHead,
    title: optionalText(160),
    body: richTextSchema,
  })
  .strict();

export const textImageBlockSchema = z
  .object({
    type: z.literal('textImage'),
    ...sectionHead,
    title: text(160),
    body: richTextSchema,
    mediaId: uuid.optional(),
    illustration: z.enum(CONTENT_ILLUSTRATIONS).default('none'),
    imageSide: z.enum(['start', 'end']).default('end'),
    cta: linkSchema.optional(),
    /** `navy`: a dark, photographic card (e.g. the Teranga story). */
    tone: z.enum(['light', 'navy']).default('light'),
  })
  .strict();

export const imageBlockSchema = z
  .object({
    type: z.literal('image'),
    ...sectionHead,
    mediaId: uuid,
    caption: optionalText(240),
    layout: z.enum(['wide', 'contained']).default('contained'),
  })
  .strict();

export const ctaBlockSchema = z
  .object({
    type: z.literal('cta'),
    ...sectionHead,
    title: text(160),
    text: optionalText(400),
    button: linkSchema,
    tone: z.enum(['light', 'dark']).default('light'),
    illustration: z.enum(CONTENT_ILLUSTRATIONS).default('none'),
  })
  .strict();

const cardSchema = z
  .object({
    icon: z.enum(CONTENT_ICONS).optional(),
    title: text(100),
    text: text(400),
    link: linkSchema.optional(),
    /** A photograph of the media library above the card (services). */
    mediaId: uuid.optional(),
  })
  .strict();

export const CARD_VARIANTS = ['features', 'services', 'steps', 'trust', 'highlights'] as const;

export const cardsBlockSchema = z
  .object({
    type: z.literal('cards'),
    ...sectionHead,
    /** `highlights`: a compact row of icons and short texts (reassurance). */
    variant: z.enum(CARD_VARIANTS).default('features'),
    title: text(160),
    intro: optionalText(400),
    items: z.array(cardSchema).min(1).max(12),
  })
  .strict();

export const faqBlockSchema = z
  .object({
    type: z.literal('faq'),
    ...sectionHead,
    title: text(160),
    items: z
      .array(z.object({ question: text(200), answer: richTextSchema }).strict())
      .min(1)
      .max(40),
  })
  .strict();

export const ROUTE_DIRECTIONS = ['PAR-DKR', 'DKR-PAR'] as const;

export const routesBlockSchema = z
  .object({
    type: z.literal('routes'),
    ...sectionHead,
    title: text(160),
    intro: optionalText(400),
    items: z
      .array(
        z
          .object({
            direction: z.enum(ROUTE_DIRECTIONS),
            label: text(60),
            title: text(100),
            text: text(400),
            link: linkSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    /** "From" prices come from Pricing (public search API), never from the CMS. */
    showFromPrices: z.boolean().default(true),
  })
  .strict();

/**
 * Next departures, read from the public trip search (Trips, Booking and
 * Pricing): dates, availability and fares are never written in the CMS.
 */
export const departuresBlockSchema = z
  .object({
    type: z.literal('departures'),
    ...sectionHead,
    title: text(160),
    intro: optionalText(400),
    routes: z
      .array(
        z
          .object({
            ...directionSchema,
            /** Photograph of the destination (media library). */
            mediaId: uuid.optional(),
          })
          .strict()
          .refine(differentStops, { message: 'deux arrêts différents', path: ['toCode'] }),
      )
      .min(1)
      .max(4),
    /** Departures shown, all directions together, soonest first. */
    limit: z.number().int().min(1).max(6).default(3),
    cta: linkSchema.optional(),
  })
  .strict();

export const statsBlockSchema = z
  .object({
    type: z.literal('stats'),
    ...sectionHead,
    title: optionalText(160),
    items: z
      .array(z.object({ value: text(24), label: text(80) }).strict())
      .min(1)
      .max(6),
  })
  .strict();

export const galleryBlockSchema = z
  .object({
    type: z.literal('gallery'),
    ...sectionHead,
    title: optionalText(160),
    items: z
      .array(z.object({ mediaId: uuid, caption: optionalText(160) }).strict())
      .min(1)
      .max(12),
  })
  .strict();

export const bannerBlockSchema = z
  .object({
    type: z.literal('banner'),
    ...sectionHead,
    tone: z.enum(['info', 'warning', 'success']).default('info'),
    text: text(300),
    link: linkSchema.optional(),
  })
  .strict();

export const blockSchema = z.discriminatedUnion('type', [
  heroBlockSchema,
  richTextBlockSchema,
  textImageBlockSchema,
  imageBlockSchema,
  ctaBlockSchema,
  cardsBlockSchema,
  faqBlockSchema,
  routesBlockSchema,
  departuresBlockSchema,
  statsBlockSchema,
  galleryBlockSchema,
  bannerBlockSchema,
]);

export const BLOCK_TYPES = blockSchema.options.map((option) => option.shape.type.value);

export const seoSchema = z
  .object({
    /** Search-result title; defaults to the page title. */
    title: optionalText(70),
    description: text(170),
    /** Listed in the sitemap and indexable (when the site itself is). */
    indexable: z.boolean().default(true),
    socialMediaId: uuid.optional(),
  })
  .strict();

export const pageDocumentSchema = z
  .object({
    title: text(140),
    seo: seoSchema,
    blocks: z.array(blockSchema).max(40),
  })
  .strict()
  .superRefine((page, ctx) => {
    const anchors = new Set<string>();
    page.blocks.forEach((block, index) => {
      if (!block.anchor) return;
      if (anchors.has(block.anchor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'anchor'],
          message: 'ancre déjà utilisée sur la page',
        });
      }
      anchors.add(block.anchor);
    });
    const heroes = page.blocks.filter((block) => block.type === 'hero').length;
    if (heroes > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['blocks'],
        message: 'une seule section hero par page',
      });
    }
  });

/** Missing owner information stays `null`: it is shown as "to complete" in OPS, never invented. */
const ownerText = (max: number) => text(max).nullable();

export const SOCIAL_NETWORKS = [
  'facebook',
  'instagram',
  'tiktok',
  'linkedin',
  'x',
  'youtube',
  'whatsapp',
] as const;

const appUrlSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username;
      } catch {
        return false;
      }
    },
    { message: 'URL http(s) absolue attendue' },
  );

export const siteSettingsSchema = z
  .object({
    brandName: text(60),
    slogan: optionalText(160),
    contact: z
      .object({
        email: z.email().max(200).nullable(),
        phone: ownerText(40),
        address: ownerText(300),
        hours: ownerText(200),
      })
      .strict(),
    legal: z
      .object({
        companyName: ownerText(160),
        legalForm: ownerText(80),
        registeredAddress: ownerText(300),
        shareCapital: ownerText(60),
        registrationNumber: ownerText(80),
        vatNumber: ownerText(40),
        publicationDirector: ownerText(120),
        hostName: ownerText(160),
        hostAddress: ownerText(300),
        hostContact: ownerText(120),
      })
      .strict(),
    social: z
      .array(z.object({ network: z.enum(SOCIAL_NETWORKS), url: httpsUrlSchema }).strict())
      .max(8),
    apps: z
      .object({ bookingUrl: appUrlSchema, clientUrl: appUrlSchema, trackingUrl: appUrlSchema })
      .strict(),
    footer: z.object({ intro: text(300), notice: optionalText(300) }).strict(),
  })
  .strict();

export const navigationSchema = z
  .object({
    header: z.array(linkSchema).max(7),
    headerCta: linkSchema.optional(),
    footer: z
      .array(z.object({ title: text(40), links: z.array(linkSchema).min(1).max(8) }).strict())
      .max(4),
  })
  .strict();

export type ContentPath = z.infer<typeof contentPathSchema>;
export type LinkTarget = z.infer<typeof linkTargetSchema>;
export type ContentLink = z.infer<typeof linkSchema>;
export type Span = z.infer<typeof spanSchema>;
export type RichNode = z.infer<typeof richNodeSchema>;
export type RichText = z.infer<typeof richTextSchema>;
export type ContentBlock = z.infer<typeof blockSchema>;
export type ContentBlockType = ContentBlock['type'];
export type PageDocument = z.infer<typeof pageDocumentSchema>;
export type PageDocumentInput = z.input<typeof pageDocumentSchema>;
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type Navigation = z.infer<typeof navigationSchema>;

export const CONTENT_KINDS = ['PAGE', 'SITE_SETTINGS', 'NAVIGATION'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Fixed key of the two singleton entries. */
export const SINGLETON_KEYS = { SITE_SETTINGS: 'site', NAVIGATION: 'navigation' } as const;

export function documentSchemaOf(kind: ContentKind) {
  if (kind === 'PAGE') return pageDocumentSchema;
  if (kind === 'SITE_SETTINGS') return siteSettingsSchema;
  return navigationSchema;
}

/** Owner information still missing from the site settings (OWNER_INPUT_REQUIRED). */
export function missingOwnerInputs(settings: SiteSettings): string[] {
  const missing: string[] = [];
  for (const [group, values] of [
    ['contact', settings.contact],
    ['legal', settings.legal],
  ] as const) {
    for (const [field, value] of Object.entries(values)) {
      if (value === null) missing.push(`${group}.${field}`);
    }
  }
  return missing;
}

/** Where a page references media: the field path and the media id (MEDIA-1). */
export function mediaReferencesOf(page: PageDocument): Array<{ path: string; mediaId: string }> {
  const references: Array<{ path: string; mediaId: string }> = [];
  if (page.seo.socialMediaId) {
    references.push({ path: 'seo.socialMediaId', mediaId: page.seo.socialMediaId });
  }
  page.blocks.forEach((block, index) => {
    if ('mediaId' in block && block.mediaId) {
      references.push({ path: `blocks.${index}.mediaId`, mediaId: block.mediaId });
    }
    if (block.type === 'gallery' || block.type === 'cards') {
      block.items.forEach((item, at) => {
        if (item.mediaId) {
          references.push({ path: `blocks.${index}.items.${at}.mediaId`, mediaId: item.mediaId });
        }
      });
    }
    if (block.type === 'departures') {
      block.routes.forEach((route, at) => {
        if (route.mediaId) {
          references.push({ path: `blocks.${index}.routes.${at}.mediaId`, mediaId: route.mediaId });
        }
      });
    }
  });
  return references;
}

/** Media referenced by a page (MEDIA-1 checks them; CMS-1 only lists them). */
export function mediaIdsOf(page: PageDocument): string[] {
  return [...new Set(mediaReferencesOf(page).map((reference) => reference.mediaId))];
}
