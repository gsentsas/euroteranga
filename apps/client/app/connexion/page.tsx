import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { LoginForm } from '../../components/login-form';
import { journeyLinks, publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Connexion — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Espace client"
      title="Bon retour parmi nous."
      subtitle="Connectez-vous pour retrouver vos réservations et préparer votre voyage."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      links={journeyLinks}
      current="client"
    >
      <section className="et-auth-panel" aria-labelledby="client-login-panel">
        <h2 id="client-login-panel">Connexion</h2>
        <LoginForm />
      </section>
    </JourneyShell>
  );
}
