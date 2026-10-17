import { JourneyShell } from '@euroteranga/ui';
import Link from 'next/link';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <JourneyShell
      area="Espace client"
      title="Votre voyage, au même endroit."
      subtitle="Retrouvez vos réservations, voyageurs, documents et étapes de préparation avant le départ."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="client"
    >
      <div className="et-client-home">
        <section className="et-client-welcome">
          <p className="et-client-eyebrow">Votre espace personnel</p>
          <h2>Reprenez votre voyage là où vous l’avez laissé.</h2>
          <p>
            Connectez-vous pour consulter vos réservations et suivre les actions utiles avant le
            départ.
          </p>
          <div className="et-actions">
            <Link className="et-button et-client-link-button" href="/connexion">
              Se connecter
            </Link>
            <Link
              className="et-button et-button--secondary et-client-link-button"
              href="/inscription"
            >
              Créer un compte
            </Link>
          </div>
        </section>
        <div className="et-journey-grid">
          <article className="et-journey-feature">
            <strong>Réservations</strong>
            <p>Retrouvez vos trajets, sièges et statuts de paiement.</p>
          </article>
          <article className="et-journey-feature">
            <strong>Voyageurs</strong>
            <p>Préparez les informations des passagers rattachés à votre réservation.</p>
          </article>
          <article className="et-journey-feature">
            <strong>Préparation</strong>
            <p>Suivez les éléments de conformité, bagages et check-in disponibles.</p>
          </article>
        </div>
      </div>
    </JourneyShell>
  );
}
