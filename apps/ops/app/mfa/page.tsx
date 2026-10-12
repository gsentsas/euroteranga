import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { MfaVerifyForm } from '../../components/mfa-verify-form';
import { publicEnv } from '../../lib/env';

export const metadata: Metadata = { title: 'Vérification en deux étapes — EURO TERANGA Ops' };

export default function Page() {
  return (
    <FoundationShell
      product="Ops"
      title="Vérification en deux étapes"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <MfaVerifyForm />
    </FoundationShell>
  );
}
