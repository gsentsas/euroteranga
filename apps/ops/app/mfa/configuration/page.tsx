import { FoundationShell } from '@euroteranga/ui';
import type { Metadata } from 'next';
import { MfaEnrollment } from '../../../components/mfa-enrollment';
import { publicEnv } from '../../../lib/env';

export const metadata: Metadata = {
  title: 'Activer la double authentification — EURO TERANGA Ops',
};

export default function Page() {
  return (
    <FoundationShell
      product="Ops"
      title="Activer la double authentification"
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
    >
      <MfaEnrollment />
    </FoundationShell>
  );
}
