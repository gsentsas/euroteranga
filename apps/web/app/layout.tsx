import '@euroteranga/ui/tokens.css';
import './public.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'EURO TERANGA',
  description:
    'EURO TERANGA — transport longue distance Paris ↔ Dakar, réservation en ligne et suivi du trajet.',
  openGraph: {
    title: 'EURO TERANGA — Paris ↔ Dakar',
    description:
      'Voyage longue distance entre Paris et Dakar avec réservation en ligne et suivi du trajet.',
    type: 'website',
    locale: 'fr_FR',
    siteName: 'EURO TERANGA',
  },
  // The pilot remains intentionally non-indexed until commercial go-live.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
