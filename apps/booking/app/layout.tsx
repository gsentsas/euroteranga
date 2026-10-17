import '@euroteranga/ui/tokens.css';
import './booking.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Réserver — EURO TERANGA',
  description: 'Réservez votre voyage EURO TERANGA entre Paris et Dakar.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
