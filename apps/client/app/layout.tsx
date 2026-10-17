import '@euroteranga/ui/tokens.css';
import './account.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Espace client — EURO TERANGA',
  description: 'Gérez vos réservations et votre voyage dans votre espace client EURO TERANGA.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
