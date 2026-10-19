import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Page introuvable — EURO TERANGA Crew' };

export default function NotFound() {
  return (
    <main id="main" className="et-main" tabIndex={-1}>
      <h1>Page introuvable</h1>
      <p className="et-subtitle">Cette page n’existe pas ou n’est plus disponible.</p>
      <p>
        <Link className="et-button" href="/">
          Retour à l’accueil
        </Link>
      </p>
    </main>
  );
}
