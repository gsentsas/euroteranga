import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { journeyLinks, publicEnv } from '../lib/env';

export const metadata: Metadata = { title: 'Page introuvable — EURO TERANGA' };

export default function NotFound() {
  return (
    <JourneyShell
      area="Réservation"
      title="Cette page n’existe pas."
      subtitle="Le lien est peut-être incomplet ou a expiré."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      links={journeyLinks}
      current="booking"
    >
      <p>
        <Link className="et-button" href="/">
          Revenir à l’accueil de l’espace
        </Link>
      </p>
    </JourneyShell>
  );
}
