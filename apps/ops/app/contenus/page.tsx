import type { Metadata } from 'next';
import '../content.css';
import { ContentAdmin } from '../../components/content/content-admin';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Contenus du site — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Contenus du site" subtitle="Pages, navigation et paramètres du site public">
      <RequirePermission permission="content.read">
        <ContentAdmin />
      </RequirePermission>
    </OpsShell>
  );
}
