import type {
  ContentBlock,
  ContentLink,
  Navigation,
  RichText,
  SiteSettings,
  Span,
} from '@euroteranga/content';
import type { ReactNode } from 'react';
import { Icon } from './icons.js';
import { CoachIllustration, RouteIllustration, TrackingIllustration } from './illustrations.js';
import { resolveHref, type AppLinks } from './links.js';
import { formatPrice, type FromPrice } from './money.js';

export type RouteDirection = 'PAR-DKR' | 'DKR-PAR';

/** A public image resolved from the media library (MEDIA-1). */
export interface SiteMedia {
  src: string;
  alt: string;
  width: number;
  height: number;
  srcSet?: string;
  /** Point kept visible when the image is cropped, in percent. */
  focalX?: number;
  focalY?: number;
  /** Library caption, shown when the block has none. */
  caption?: string | null;
  credit?: string | null;
}

/** An active image as the public media API describes it. */
export interface PublicMediaRecord {
  altText: string;
  caption: string | null;
  credit: string | null;
  width: number;
  height: number;
  focalX: number;
  focalY: number;
  renditions: ReadonlyArray<{ width: number; path: string }>;
}

/** Default `src` for browsers without srcset support: a mid-size rendition. */
const DEFAULT_RENDITION_WIDTH = 960;

/** Responsive WebP image of a public media record; `url` makes rendition paths absolute. */
export function siteMediaOf(media: PublicMediaRecord, url: (path: string) => string): SiteMedia {
  const renditions = [...media.renditions].sort((a, b) => a.width - b.width);
  const fallback =
    renditions.filter((rendition) => rendition.width <= DEFAULT_RENDITION_WIDTH).at(-1) ??
    renditions[0];
  return {
    src: fallback ? url(fallback.path) : '',
    srcSet: renditions.map((rendition) => `${url(rendition.path)} ${rendition.width}w`).join(', '),
    alt: media.altText,
    width: media.width,
    height: media.height,
    focalX: media.focalX,
    focalY: media.focalY,
    caption: media.caption,
    credit: media.credit,
  };
}

/** Everything a page needs that is not in its own document. */
export interface SiteContext {
  settings: SiteSettings;
  navigation: Navigation;
  apps: AppLinks;
  /** Lowest current fare per direction, read from Pricing (never from the CMS). */
  fromPrices: Partial<Record<RouteDirection, FromPrice | null>>;
  media?: (id: string) => SiteMedia | null;
  year: number;
}

function ContentAnchor({
  link,
  ctx,
  className,
}: {
  link: ContentLink;
  ctx: SiteContext;
  className?: string;
}) {
  return (
    <a className={className} href={resolveHref(link.target, ctx.apps)}>
      {link.label}
    </a>
  );
}

function SpanText({ span, ctx }: { span: Span; ctx: SiteContext }) {
  let node: ReactNode = span.text;
  if (span.italic) node = <em>{node}</em>;
  if (span.bold) node = <strong>{node}</strong>;
  if (span.link) node = <a href={resolveHref(span.link, ctx.apps)}>{node}</a>;
  return <>{node}</>;
}

/** Rich text is a small tree of typed nodes: nothing is ever parsed as HTML. */
export function RichTextView({ value, ctx }: { value: RichText; ctx: SiteContext }) {
  return (
    <div className="public-rich">
      {value.map((node, index) => {
        if (node.kind === 'heading') {
          return node.level === 2 ? (
            <h2 key={index}>{node.text}</h2>
          ) : (
            <h3 key={index}>{node.text}</h3>
          );
        }
        if (node.kind === 'list') {
          const items = node.items.map((spans, item) => (
            <li key={item}>
              {spans.map((span, at) => (
                <SpanText key={at} span={span} ctx={ctx} />
              ))}
            </li>
          ));
          return node.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return (
          <p key={index}>
            {node.spans.map((span, at) => (
              <SpanText key={at} span={span} ctx={ctx} />
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Illustration({ name }: { name: string }) {
  if (name === 'route') return <RouteIllustration />;
  if (name === 'tracking') return <TrackingIllustration />;
  if (name === 'coach') return <CoachIllustration />;
  return null;
}

/** Rendered widths of an image, for the browser to pick a rendition. */
const SIZES = {
  half: '(max-width: 900px) 100vw, 50vw',
  contained: '(max-width: 900px) 100vw, 900px',
  wide: '100vw',
  gallery: '(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw',
} as const;

function Figure({
  mediaId,
  ctx,
  caption,
  priority,
  sizes = 'contained',
}: {
  mediaId: string;
  ctx: SiteContext;
  caption?: string | undefined;
  priority?: boolean;
  sizes?: keyof typeof SIZES;
}) {
  const media = ctx.media?.(mediaId) ?? null;
  // An unknown or archived image is left out rather than shown broken.
  if (!media) return null;
  const legend = caption ?? media.caption ?? null;
  const focal =
    media.focalX !== undefined &&
    media.focalY !== undefined &&
    (media.focalX !== 50 || media.focalY !== 50)
      ? { objectPosition: `${media.focalX}% ${media.focalY}%` }
      : undefined;
  return (
    <figure className="public-figure">
      <img
        src={media.src}
        {...(media.srcSet ? { srcSet: media.srcSet, sizes: SIZES[sizes] } : {})}
        alt={media.alt}
        width={media.width}
        height={media.height}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        {...(focal ? { style: focal } : {})}
      />
      {legend || media.credit ? (
        <figcaption>
          {legend}
          {media.credit ? (
            <span className="public-figure__credit">Crédit photo : {media.credit}</span>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

function SectionHead({
  id,
  kicker,
  title,
  intro,
}: {
  id: string;
  kicker?: string | undefined;
  title?: string | undefined;
  intro?: string | undefined;
}) {
  if (!kicker && !title && !intro) return null;
  return (
    <div className="public-section__head">
      {kicker ? <p className="public-kicker">{kicker}</p> : null}
      {title ? <h2 id={id}>{title}</h2> : null}
      {intro ? <p className="public-section__intro">{intro}</p> : null}
    </div>
  );
}

function priceLabel(price: FromPrice | null | undefined): string | null {
  return price ? formatPrice(price) : null;
}

function Hero({
  block,
  ctx,
  titleId,
}: {
  block: Extract<ContentBlock, { type: 'hero' }>;
  ctx: SiteContext;
  titleId: string;
}) {
  const outbound = priceLabel(ctx.fromPrices['PAR-DKR']);
  return (
    <section
      className="public-hero"
      aria-labelledby={titleId}
      {...(block.anchor ? { id: block.anchor } : {})}
    >
      <div className="public-container public-hero__inner">
        <div>
          {block.eyebrow ? (
            <div className="public-eyebrow">
              <span className="public-eyebrow__dot" aria-hidden="true" />
              {block.eyebrow}
            </div>
          ) : null}
          <h1 id={titleId}>{block.title}</h1>
          {block.lead ? <p className="public-hero__lead">{block.lead}</p> : null}
          {block.primaryCta || block.secondaryCta ? (
            <div className="public-hero__actions">
              {block.primaryCta ? (
                <a
                  className="public-button public-button--gold"
                  href={resolveHref(block.primaryCta.target, ctx.apps)}
                >
                  {block.primaryCta.label} <Icon name="arrow" />
                </a>
              ) : null}
              {block.secondaryCta ? (
                <ContentAnchor
                  className="public-button public-button--secondary"
                  link={block.secondaryCta}
                  ctx={ctx}
                />
              ) : null}
            </div>
          ) : null}
          {block.note ? (
            <p className="public-hero__note">
              <Icon name="shield" />
              {block.note}
            </p>
          ) : null}
          {block.mediaId ? (
            <Figure mediaId={block.mediaId} ctx={ctx} priority sizes="half" />
          ) : null}
        </div>
        {block.journeyCard ? (
          <div className="public-trip-card" role="group" aria-label="Liaison Paris Dakar">
            <div className="public-trip-card__top">
              <div>
                <p className="public-trip-card__label">{outbound ? 'À partir de' : 'Tarifs'}</p>
                <p className="public-trip-card__price">
                  {outbound ? (
                    <>
                      {outbound} <small>/ place</small>
                    </>
                  ) : (
                    <small>affichés à la réservation</small>
                  )}
                </p>
              </div>
              <span className="public-pill">Paris ↔ Dakar</span>
            </div>
            <div className="public-route-line">
              <div className="public-route-stop">
                <span className="public-route-stop__dot" aria-hidden="true" />
                <div>
                  <strong>Paris</strong>
                  <span>France · départ</span>
                </div>
              </div>
              <div className="public-route-stop">
                <span className="public-route-stop__dot" aria-hidden="true" />
                <div>
                  <strong>Dakar</strong>
                  <span>Sénégal · arrivée</span>
                </div>
              </div>
            </div>
            <div className="public-trip-card__features">
              <span className="public-trip-feature">
                <Icon name="ticket" /> Réservation en ligne
              </span>
              <span className="public-trip-feature">
                <Icon name="seat" /> Siège choisi
              </span>
              <span className="public-trip-feature">
                <Icon name="luggage" /> Bagages identifiés
              </span>
              <span className="public-trip-feature">
                <Icon name="pin" /> Suivi du trajet
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const CARD_GRID: Record<string, string> = {
  trust: 'public-trust-grid',
  steps: 'public-steps',
  services: 'public-services',
  features: 'public-trust-grid',
};
const CARD_CLASS: Record<string, string> = {
  trust: 'public-trust-card',
  steps: 'public-step-card',
  services: 'public-service-card',
  features: 'public-trust-card',
};

function Section({
  block,
  index,
  ctx,
  children,
  extraClass,
}: {
  block: ContentBlock;
  index: number;
  ctx: SiteContext;
  children: ReactNode;
  extraClass?: string;
}) {
  void ctx;
  const muted = index % 2 === 0 ? ' public-section--muted' : '';
  const title = 'title' in block ? block.title : undefined;
  return (
    <section
      className={`public-section${muted}${extraClass ? ` ${extraClass}` : ''}`}
      {...(block.anchor ? { id: block.anchor } : {})}
      {...(title
        ? { 'aria-labelledby': `section-${index}-title` }
        : { 'aria-label': block.kicker ?? 'Section' })}
    >
      <div className="public-container">{children}</div>
    </section>
  );
}

export function Block({
  block,
  index,
  ctx,
}: {
  block: ContentBlock;
  index: number;
  ctx: SiteContext;
}) {
  const titleId = `section-${index}-title`;
  switch (block.type) {
    case 'hero':
      return <Hero block={block} ctx={ctx} titleId={titleId} />;
    case 'cards':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} intro={block.intro} />
          <div className={CARD_GRID[block.variant]}>
            {block.items.map((item, at) => (
              <article key={at} className={CARD_CLASS[block.variant]}>
                {item.icon ? (
                  <span className="public-card-icon">
                    <Icon name={item.icon} />
                  </span>
                ) : null}
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                {item.link ? (
                  <ContentAnchor className="public-route-card__link" link={item.link} ctx={ctx} />
                ) : null}
              </article>
            ))}
          </div>
        </Section>
      );
    case 'routes':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} intro={block.intro} />
          <div className="public-route-grid">
            {block.items.map((item, at) => {
              const price = block.showFromPrices
                ? priceLabel(ctx.fromPrices[item.direction])
                : null;
              return (
                <article key={at} className="public-route-card">
                  <div className="public-route-card__direction">{item.label}</div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                  <div className="public-route-card__bottom">
                    {block.showFromPrices ? (
                      <div className="public-route-card__price">
                        {price ? (
                          <>
                            <strong>{price}</strong>
                            <span>à partir de, par place</span>
                          </>
                        ) : (
                          <span>Tarif affiché à la réservation</span>
                        )}
                      </div>
                    ) : (
                      <span />
                    )}
                    {item.link ? (
                      <ContentAnchor
                        className="public-route-card__link"
                        link={item.link}
                        ctx={ctx}
                      />
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </Section>
      );
    case 'cta': {
      if (block.tone === 'dark') {
        return (
          <section
            className="public-section"
            {...(block.anchor ? { id: block.anchor } : {})}
            aria-labelledby={titleId}
          >
            <div className="public-container public-tracking">
              <div className="public-tracking__inner">
                <div>
                  {block.kicker ? <p className="public-kicker">{block.kicker}</p> : null}
                  <h2 id={titleId}>{block.title}</h2>
                  {block.text ? <p>{block.text}</p> : null}
                  <a
                    className="public-button public-button--gold"
                    href={resolveHref(block.button.target, ctx.apps)}
                  >
                    {block.button.label} <Icon name="arrow" />
                  </a>
                </div>
                <Illustration name={block.illustration} />
              </div>
            </div>
          </section>
        );
      }
      return (
        <section
          className="public-section"
          {...(block.anchor ? { id: block.anchor } : {})}
          aria-labelledby={titleId}
        >
          <div className="public-container public-final-cta">
            <div>
              {block.kicker ? <p className="public-kicker">{block.kicker}</p> : null}
              <h2 id={titleId}>{block.title}</h2>
              {block.text ? <p>{block.text}</p> : null}
            </div>
            <a className="public-button" href={resolveHref(block.button.target, ctx.apps)}>
              {block.button.label} <Icon name="arrow" />
            </a>
          </div>
        </section>
      );
    }
    case 'faq':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} />
          <div className="public-faq">
            {block.items.map((item, at) => (
              <details key={at}>
                <summary>{item.question}</summary>
                <RichTextView value={item.answer} ctx={ctx} />
              </details>
            ))}
          </div>
        </Section>
      );
    case 'richText':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} />
          <RichTextView value={block.body} ctx={ctx} />
        </Section>
      );
    case 'textImage':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <div className={`public-text-image public-text-image--${block.imageSide}`}>
            <div>
              <SectionHead id={titleId} kicker={block.kicker} title={block.title} />
              <RichTextView value={block.body} ctx={ctx} />
              {block.cta ? (
                <ContentAnchor className="public-button" link={block.cta} ctx={ctx} />
              ) : null}
            </div>
            <div className="public-text-image__visual">
              {block.mediaId ? (
                <Figure mediaId={block.mediaId} ctx={ctx} sizes="half" />
              ) : (
                <Illustration name={block.illustration} />
              )}
            </div>
          </div>
        </Section>
      );
    case 'image':
      return (
        <Section
          block={block}
          index={index}
          ctx={ctx}
          extraClass={`public-image-block public-image-block--${block.layout}`}
        >
          <Figure
            mediaId={block.mediaId}
            ctx={ctx}
            caption={block.caption}
            sizes={block.layout === 'wide' ? 'wide' : 'contained'}
          />
        </Section>
      );
    case 'stats':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} />
          <dl className="public-stats">
            {block.items.map((item, at) => (
              <div key={at}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      );
    case 'gallery':
      return (
        <Section block={block} index={index} ctx={ctx}>
          <SectionHead id={titleId} kicker={block.kicker} title={block.title} />
          <div className="public-gallery">
            {block.items.map((item, at) => (
              <Figure
                key={at}
                mediaId={item.mediaId}
                ctx={ctx}
                caption={item.caption}
                sizes="gallery"
              />
            ))}
          </div>
        </Section>
      );
    case 'banner':
      return (
        <div className="public-container" {...(block.anchor ? { id: block.anchor } : {})}>
          <p className={`public-banner public-banner--${block.tone}`} role="note">
            {block.text}
            {block.link ? (
              <>
                {' '}
                <ContentAnchor link={block.link} ctx={ctx} />
              </>
            ) : null}
          </p>
        </div>
      );
  }
}

/** The blocks of a page, in order. A page without hero gets its title as H1. */
export function Blocks({
  title,
  blocks,
  ctx,
}: {
  title: string;
  blocks: readonly ContentBlock[];
  ctx: SiteContext;
}) {
  const hasHero = blocks.some((block) => block.type === 'hero');
  return (
    <>
      {hasHero ? null : (
        <div className="public-page-head">
          <div className="public-container">
            <h1>{title}</h1>
          </div>
        </div>
      )}
      {blocks.map((block, index) => (
        <Block key={index} block={block} index={index} ctx={ctx} />
      ))}
    </>
  );
}
