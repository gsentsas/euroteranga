import type { Metadata } from 'next';
import Link from 'next/link';
import { DEFAULT_SITE_SETTINGS } from '@euroteranga/content';

const BOOKING_URL = process.env.PUBLIC_BOOKING_URL ?? DEFAULT_SITE_SETTINGS.apps.bookingUrl;

// Next.js adds `noindex` to not-found responses by itself.
export const metadata: Metadata = { title: 'Page introuvable' };

export default function NotFound() {
  return (
    <div className="public-site">
      <main id="main" className="public-not-found" tabIndex={-1}>
        <div className="public-container public-not-found__inner">
          <p className="public-kicker">Erreur 404</p>
          <h1>Cette page n’existe pas ou a été déplacée.</h1>
          <p>
            Le lien est peut-être incomplet. Vous pouvez revenir à l’accueil ou rechercher
            directement votre prochain départ.
          </p>
          <div className="public-hero__actions">
            <Link className="public-button" href="/">
              Retour à l’accueil
            </Link>
            <a className="public-button public-button--secondary" href={BOOKING_URL}>
              Rechercher un voyage
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
