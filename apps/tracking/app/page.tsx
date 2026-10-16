import { FoundationShell } from '@euroteranga/ui';
import { publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <FoundationShell
      product="Tracking"
      title="EURO TERANGA Tracking"
      subtitle="Suivi sécurisé des voyages"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <section className="tracking-card">
        <h2>Accès au suivi</h2>
        <p>
          Ouvrez le lien de suivi sécurisé qui vous a été transmis pour consulter les informations
          publiées pour votre voyage.
        </p>
      </section>
    </FoundationShell>
  );
}
