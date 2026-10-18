'use client';

import Link from 'next/link';

/** Shown when the content cannot be read (Core API unavailable): never a blank page. */
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="public-site">
      <main id="main" className="public-not-found" tabIndex={-1}>
        <div className="public-container public-not-found__inner">
          <p className="public-kicker">Service momentanément indisponible</p>
          <h1>Cette page ne peut pas être affichée pour le moment.</h1>
          <p>Merci de réessayer dans quelques instants.</p>
          <div className="public-hero__actions">
            <button className="public-button" type="button" onClick={() => reset()}>
              Réessayer
            </button>
            <Link className="public-button public-button--secondary" href="/">
              Retour à l’accueil
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
