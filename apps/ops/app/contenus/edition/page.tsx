import type { Metadata } from 'next';
import { Suspense } from 'react';
import '../../content.css';
import { ContentEditorRoute } from '../../../components/content/content-editor-route';
import { OpsShell } from '../../../components/ops-shell';
import { RequirePermission } from '../../../components/staff-access';

export const metadata: Metadata = { title: 'Modifier un contenu — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Modifier un contenu" subtitle="Brouillon, aperçu, publication et historique">
      <RequirePermission permission="content.read">
        <Suspense fallback={<p role="status">Chargement du contenu…</p>}>
          <ContentEditorRoute />
        </Suspense>
      </RequirePermission>
    </OpsShell>
  );
}
