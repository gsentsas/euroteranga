import '@euroteranga/ui/tokens.css';
import '@euroteranga/site/site.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  SITE_NAME,
  openGraphBase,
  robotsOf,
  siteSeo,
  twitterBase,
} from '../lib/seo';

// Rendered on the server for each request: the indexing decision and the
// canonical origin follow the running environment (see lib/seo.ts).
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  const seo = siteSeo();
  return {
    metadataBase: seo.siteUrl,
    title: { default: DEFAULT_TITLE, template: `%s — ${SITE_NAME}` },
    description: DEFAULT_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: { ...openGraphBase(), title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION },
    twitter: { ...twitterBase(), title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION },
    robots: robotsOf(seo),
    formatDetection: { telephone: false, address: false, email: false },
  };
}

export const viewport: Viewport = { themeColor: '#073b31' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
