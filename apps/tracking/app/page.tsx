import { JourneyShell } from '@euroteranga/ui';
import { journeyLinks, publicEnv } from '../lib/env';

export default function HomePage() {
  return (
    <JourneyShell
      area="Suivi"
      title="Gardez un œil sur votre trajet."
      subtitle="Le suivi public montre uniquement les informations autorisées pour votre voyage."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      links={journeyLinks}
      current="tracking"
    >
      <section className="tracking-access-card">
        <div>
          <p className="tracking-kicker">Lien sécurisé</p>
          <h2>Accédez au suivi transmis pour votre voyage.</h2>
          <p>
            Ouvrez le lien de suivi reçu avec vos informations de voyage. Aucun trajet ni aucune
            position n’est affiché sans un lien valide.
          </p>
        </div>
        <div className="tracking-access-visual" aria-hidden="true">
          <span className="tracking-access-line" />
          <span className="tracking-access-pin tracking-access-pin--a" />
          <span className="tracking-access-pin tracking-access-pin--b" />
        </div>
      </section>
    </JourneyShell>
  );
}
