import type { Metadata } from 'next';
import '../content.css';
import '../media.css';
import { MediaLibrary } from '../../components/media/media-library';
import { OpsShell } from '../../components/ops-shell';
import { RequirePermission } from '../../components/staff-access';

export const metadata: Metadata = { title: 'Médiathèque — EURO TERANGA Ops' };

export default function Page() {
  return (
    <OpsShell title="Médiathèque" subtitle="Images du site public">
      <RequirePermission permission="media.read">
        <MediaLibrary />
      </RequirePermission>
    </OpsShell>
  );
}
