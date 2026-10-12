import '@euroteranga/ui/tokens.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'EURO TERANGA Client',
  description: 'Espace client EURO TERANGA — environnement de fondation.',
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
