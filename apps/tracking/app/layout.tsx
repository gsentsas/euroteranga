import '@euroteranga/ui/tokens.css';
import './tracking.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'EURO TERANGA Tracking',
  description: 'Suivi sécurisé des voyages EURO TERANGA.',
  // Foundation skeletons must not be indexed as if they were live services.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
