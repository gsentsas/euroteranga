import { JourneyShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { RegisterForm } from '../../components/register-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Créer un compte — EURO TERANGA' };

export default function Page() {
  return (
    <JourneyShell
      area="Espace client"
      title="Créez votre espace voyage."
      subtitle="Une adresse e-mail et une phrase de passe suffisent pour commencer."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="client"
    >
      <section className="et-auth-panel" aria-labelledby="client-register-panel">
        <h2 id="client-register-panel">Créer mon compte</h2>
        <p>Aucune autre information personnelle n’est demandée à cette étape.</p>
        <RegisterForm />
      </section>
    </JourneyShell>
  );
}
