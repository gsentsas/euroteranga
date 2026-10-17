import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { VerifyEmailForm } from '../../components/verify-email-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Confirmer votre adresse e-mail — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Espace client"
      title="Confirmez votre adresse e-mail."
      subtitle="Cette étape protège votre compte avant votre première connexion."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="client"
    >
      <section className="et-auth-panel" aria-labelledby="verify-email-panel">
        <h2 id="verify-email-panel">Vérification</h2>
        <VerifyEmailForm />
      </section>
    </JourneyShell>
  );
}
