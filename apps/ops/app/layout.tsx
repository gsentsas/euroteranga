import '@euroteranga/ui/tokens.css';
import './network.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RefineProvider } from './refine-provider';

export const metadata: Metadata = {
  title: 'EURO TERANGA Ops',
  description: 'Centre de contrôle interne des opérations EURO TERANGA.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body className="ops-app">
        <RefineProvider>{children}</RefineProvider>
      </body>
    </html>
  );
}
