import Link from 'next/link';
import { CrewShell } from '../components/crew-shell';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <CrewShell
      title="EURO TERANGA Crew"
      subtitle="Embarquement, checkpoints, frontières et incidents — même lorsque le réseau disparaît."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <section className="crew-home-card">
        <div>
          <p className="crew-home-card__eyebrow">Prêt pour le terrain</p>
          <h2>Une seule interface pour l’équipage.</h2>
          <p>
            Les actions sont conservées localement hors ligne puis synchronisées avec le Core API
            dès que la connexion revient.
          </p>
        </div>
        <Link className="et-button crew-home-card__cta" href="/session">
          Ouvrir l’espace équipage
        </Link>
      </section>
      <div className="crew-home-grid">
        <article><strong>Embarquement</strong><span>Scanner les QR voyageurs avec file hors ligne.</span></article>
        <article><strong>Route</strong><span>Enregistrer checkpoints et événements frontière.</span></article>
        <article><strong>Incidents</strong><span>Déclarer rapidement une anomalie sur le trajet.</span></article>
      </div>
    </CrewShell>
  );
}
