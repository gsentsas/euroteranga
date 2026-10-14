import type { Metadata } from 'next';
import { OpsShell } from '../../components/ops-shell';
import { PassengerDocumentsAdmin } from '../../components/passenger-documents/passenger-documents-admin';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Documents passagers — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Documents passagers" subtitle="Fichiers privés et statuts techniques">
      <RequirePermission permission="passenger.document.read">
        <PassengerDocumentsAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
