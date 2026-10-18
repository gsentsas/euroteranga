import { contentPathSchema } from '@euroteranga/content';
import { SitePage } from '@euroteranga/site';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadPage, loadSiteContext } from '../../lib/content';
import { DEFAULT_TITLE, jsonLd, robotsOf, siteSeo } from '../../lib/seo';

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
  return {
    // The home page title is complete; other pages use the "%s — EURO TERANGA" template.
    title: path === '/' ? { absolute: searchTitle || DEFAULT_TITLE } : searchTitle,
    description: seo.description,
    alternates: { canonical: path },
    openGraph: { title: searchTitle, description: seo.description, url: path },
    twitter: { title: searchTitle, description: seo.description },
    // A page can opt out of indexing even when the site itself is indexable.
    robots: seo.indexable ? robotsOf(site) : { index: false, follow: true },
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
  const ctx = await loadSiteContext({
    prices: document.blocks.some(
      (block) =>
        (block.type === 'routes' && block.showFromPrices) ||
        (block.type === 'hero' && block.journeyCard),
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
