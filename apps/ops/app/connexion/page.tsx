import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { StaffLoginForm } from '../../components/staff-login-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Connexion opérations — EURO TERANGA Ops' };

export default function Page() {
  return (
    <FoundationShell
      product="Ops"
      title="Connexion opérations"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <StaffLoginForm />
    </FoundationShell>
  );
}
