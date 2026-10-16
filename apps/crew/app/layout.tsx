import '@euroteranga/ui/tokens.css';
import './crew.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PwaRegistration } from '../components/pwa-registration';

export const metadata: Metadata = {
  title: 'EURO TERANGA Crew',
  description: 'Application terrain équipage EURO TERANGA.',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <PwaRegistration />
        {children}
      </body>
    </html>
  );
}
