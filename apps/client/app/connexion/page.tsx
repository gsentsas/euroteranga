import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { LoginForm } from '../../components/login-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Connexion — EURO TERANGA Client' };

export default function Page() {
  return (
    <FoundationShell product="Client" title="Connexion" environment={publicEnv.NEXT_PUBLIC_APP_ENV}>
      <LoginForm />
    </FoundationShell>
  );
}
