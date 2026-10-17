import '@euroteranga/ui/tokens.css';
import './tracking.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Suivi de voyage — EURO TERANGA',
  description: 'Consultez les informations de suivi publiées pour votre voyage EURO TERANGA.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
