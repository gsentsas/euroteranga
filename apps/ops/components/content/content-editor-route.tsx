'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ContentEditor } from './content-editor';

/** `/contenus/edition?entree=<id>`: the entry id comes from the query string. */
export function ContentEditorRoute() {
  const entryId = useSearchParams().get('entree');
  if (!entryId) {
    return (
      <p>
        Aucun contenu choisi. <Link href="/contenus">Voir les contenus du site</Link>
      </p>
    );
  }
  return <ContentEditor key={entryId} entryId={entryId} />;
}
