import '@euroteranga/ui/tokens.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'EURO TERANGA',
  description: 'EURO TERANGA — transport routier de voyageurs entre l’Europe et l’Afrique.',
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
