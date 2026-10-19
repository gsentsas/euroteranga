import { contentPathSchema, mediaIdsOf } from '@euroteranga/content';
import { SitePage, type SiteMedia } from '@euroteranga/site';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadMedia, loadPage, loadSiteContext } from '../../lib/content';
import {
  DEFAULT_TITLE,
  jsonLd,
  openGraphBase,
  robotsOf,
  siteSeo,
  twitterBase,
} from '../../lib/seo';

type Params = { params: Promise<{ slug?: string[] }> };

/** `/` or `/a/b`; anything that is not a valid public content path is a 404. */
async function pathOf(params: Params['params']): Promise<string | null> {
  const { slug } = await params;
  const path = `/${(slug ?? []).join('/')}`;
  return contentPathSchema.safeParse(path).success ? path : null;
}

async function pageOrNotFound(params: Params['params']) {
  const path = await pathOf(params);
  if (!path) notFound();
  const page = await loadPage(path);
  if (page.status === 'missing') notFound();
  if (page.status === 'unavailable') throw new Error('content unavailable');
  return { path, page };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const path = await pathOf(params);
  if (!path) return {};
  const page = await loadPage(path);
  if (page.status !== 'ok') return {};
  const { seo, title } = page.document;
  const searchTitle = seo.title ?? title;
  const site = siteSeo();
  // MEDIA-1: the page's social image, when chosen and still active.
  const social = seo.socialMediaId
    ? ((await loadMedia([seo.socialMediaId])).get(seo.socialMediaId) ?? null)
    : null;
  const socialImage = social ? socialImageOf(social) : null;
  return {
    // The home page title is complete; other pages use the "%s — EURO TERANGA" template.
    title: path === '/' ? { absolute: searchTitle || DEFAULT_TITLE } : searchTitle,
    description: seo.description,
    alternates: { canonical: path },
    openGraph: {
      ...openGraphBase(),
      ...(socialImage ? { images: [socialImage] } : {}),
      title: searchTitle,
      description: seo.description,
      url: path,
    },
    twitter: {
      ...twitterBase(),
      ...(socialImage ? { images: [socialImage.url] } : {}),
      title: searchTitle,
      description: seo.description,
    },
    // A page can opt out of indexing even when the site itself is indexable.
    robots: seo.indexable ? robotsOf(site) : { index: false, follow: true },
  };
}

/** The largest rendition up to 1600 px wide, as an Open Graph image. */
function socialImageOf(media: SiteMedia) {
  const candidates = (media.srcSet ?? '')
    .split(', ')
    .map((entry) => {
      const [url = '', width = ''] = entry.split(' ');
      return { url, width: Number(width.replace(/w$/, '')) };
    })
    .filter((candidate) => candidate.url && candidate.width > 0 && candidate.width <= 1600);
  const best = candidates.at(-1);
  if (!best) return null;
  return {
    url: best.url,
    width: best.width,
    height: Math.round((best.width * media.height) / media.width),
    alt: media.alt,
  };
}

/** Organization and WebSite on the home page only: no rating, review, offer or price. */
function StructuredData({ brandName, description }: { brandName: string; description: string }) {
  const seo = siteSeo();
  const url = seo.siteUrl.toString();
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${url}#organization`,
      name: brandName,
      url,
      logo: new URL('/icon.svg', seo.siteUrl).toString(),
      description,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${url}#website`,
      name: brandName,
      url,
      inLanguage: 'fr-FR',
      publisher: { '@id': `${url}#organization` },
    },
  ];
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}

export default async function ContentPage({ params }: Params) {
  const { path, page } = await pageOrNotFound(params);
  const document = page.document;
  const hero = document.blocks.find((block) => block.type === 'hero');
  const ctx = await loadSiteContext({
    prices: document.blocks.some(
      (block) =>
        (block.type === 'routes' && block.showFromPrices) ||
        (block.type === 'hero' && block.journeyCard && !block.search),
    ),
    mediaIds: mediaIdsOf(document),
    ...(hero?.search ? { search: hero.search } : {}),
    departureRoutes: document.blocks.flatMap((block) =>
      block.type === 'departures' ? block.routes : [],
    ),
  });
  return (
    <>
      {path === '/' ? (
        <StructuredData brandName={ctx.settings.brandName} description={document.seo.description} />
      ) : null}
      <SitePage title={document.title} blocks={document.blocks} ctx={ctx} />
    </>
  );
}
