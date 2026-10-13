import '@euroteranga/ui/tokens.css';
import './network.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RefineProvider } from './refine-provider';

export const metadata: Metadata = {
  title: 'EURO TERANGA Ops',
  description: 'Back-office des opérations EURO TERANGA — environnement de fondation.',
  // Foundation skeletons must not be indexed as if they were live services.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <RefineProvider>{children}</RefineProvider>
      </body>
    </html>
  );
}
