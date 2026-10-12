import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { RegisterForm } from '../../components/register-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Créer un compte — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell
      product="Client"
      title="Créer un compte"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <p>
        Créez votre identité de connexion. Aucune autre information personnelle n’est demandée à
        cette étape.
      </p>
      <RegisterForm />
    </FoundationShell>
  );
}
