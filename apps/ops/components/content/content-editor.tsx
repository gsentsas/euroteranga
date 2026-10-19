'use client';

import type {
  ApiError,
  ApiResult,
  ContentEntryDetail,
  ContentRevision,
  ContentRevisionSummary,
} from '@euroteranga/auth-client';
import {
  documentSchemaOf,
  editorIssues,
  missingOwnerInputs,
  siteSettingsSchema,
  type ContentKind,
  type EditorIssue,
} from '@euroteranga/content';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { useCan } from '../staff-access';
import { ContentPreview, type PreviewSite } from './content-preview';
import { DocumentForm } from './document-forms';
import { ContentEditorProvider, fieldId } from './editor-context';

export const KIND_LABELS: Record<ContentKind, string> = {
  PAGE: 'Page',
  SITE_SETTINGS: 'Paramètres du site',
  NAVIGATION: 'Navigation',
};

const STATUS_LABELS: Record<ContentRevisionSummary['status'], string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'En ligne',
  SUPERSEDED: 'Remplacée',
};

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = (value: string) => dateFormat.format(new Date(value));

const FIELD_NAMES: Record<string, string> = {
  title: 'titre',
  description: 'description',
  seo: 'référencement',
  text: 'texte',
  label: 'texte du lien',
  target: 'destination',
  path: 'chemin',
  url: 'adresse',
  id: 'ancre',
  body: 'texte',
  answer: 'réponse',
  question: 'question',
  lead: 'introduction',
  intro: 'introduction',
  value: 'valeur',
  mediaId: 'image',
  button: 'bouton',
  primaryCta: 'bouton principal',
  secondaryCta: 'bouton secondaire',
  cta: 'lien',
  link: 'lien',
  anchor: 'ancre',
  kicker: 'surtitre',
  contact: 'contact',
  legal: 'mentions légales',
  social: 'réseaux sociaux',
  apps: 'applications',
  footer: 'pied de page',
  header: 'menu',
  headerCta: 'bouton de l’en-tête',
  brandName: 'nom affiché',
  links: 'liens',
  caption: 'légende',
  email: 'e-mail',
  items: 'élément',
};

/** "blocks.2.items.0.title" → "Section 3 › élément 1 › titre". */
function readablePath(path: string): string {
  if (path === '(document)' || path === '') return 'Document';
  const segments = path.split('.');
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    if (/^\d+$/.test(segment)) {
      const position = Number(segment) + 1;
      parts[parts.length - 1] =
        segments[index - 1] === 'blocks'
          ? `Section ${position}`
          : `${parts.at(-1) ?? ''} ${position}`;
      return;
    }
    parts.push(segment === 'blocks' ? 'sections' : (FIELD_NAMES[segment] ?? segment));
  });
  const text = parts.join(' › ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Focuses the field of an issue, or its closest existing parent. */
function focusIssue(path: string) {
  const segments = path
    .split('.')
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  for (let length = segments.length; length > 0; length -= 1) {
    const element = document.getElementById(fieldId(segments.slice(0, length)));
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.focus({ preventScroll: true });
      return;
    }
  }
}

function workingDocument(entry: ContentEntryDetail): unknown {
  return structuredClone(entry.draft?.document ?? entry.published?.document ?? {});
}

function RevisionLine({
  label,
  revision,
}: {
  label: string;
  revision: ContentRevisionSummary | null;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {revision ? (
          <>
            Révision {revision.revision}
            {revision.status === 'PUBLISHED' && revision.publishedAt
              ? `, publiée le ${formatDate(revision.publishedAt)}${revision.publishedBy ? ` par ${revision.publishedBy.email}` : ''}`
              : `, enregistrée le ${formatDate(revision.updatedAt)}${revision.author ? ` par ${revision.author.email}` : ''}`}
            {revision.note ? ` — « ${revision.note} »` : ''}
          </>
        ) : (
          'Aucune'
        )}
      </dd>
    </>
  );
}

/** The editor of one content entry: draft, validation, preview, publication and history. */
export function ContentEditor({ entryId }: { entryId: string }) {
  const canManage = useCan('content.manage');
  const canManageSeo = useCan('seo.manage');
  const [entry, setEntry] = useState<ContentEntryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const [baseline, setBaseline] = useState('');
  const [formKey, setFormKey] = useState(0);
  const [localErrors, setLocalErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [serverIssues, setServerIssues] = useState<EditorIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  const [note, setNote] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ContentRevision | null>(null);
  const [site, setSite] = useState<PreviewSite>({ settings: null, navigation: null, home: null });
  const [pagePaths, setPagePaths] = useState<string[]>([]);
  // Kept across saves, which remount the form to resynchronize its fields.
  const [openSections, setOpenSections] = useState<ReadonlySet<number>>(new Set());

  const applyEntry = useCallback((next: ContentEntryDetail) => {
    const working = workingDocument(next);
    setEntry(next);
    setDocument(working);
    setBaseline(JSON.stringify(working));
    setLocalErrors(new Map());
    setServerIssues([]);
    setConflict(false);
    setViewing(null);
    setNote('');
    setFormKey((key) => key + 1);
  }, []);

  const load = useCallback(async () => {
    const result = await auth.admin.content.entry(entryId);
    if (result.ok) {
      setLoadError(null);
      applyEntry(result.data);
    } else {
      setLoadError(result.error.message);
    }
  }, [applyEntry, entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  // What the website shows today around the edited document (public reads).
  useEffect(() => {
    void Promise.all([auth.content.site(), auth.content.page('/')]).then(([siteResult, home]) => {
      setSite({
        settings: siteResult.ok ? siteResult.data.settings : null,
        navigation: siteResult.ok ? siteResult.data.navigation : null,
        home: home.ok ? home.data.document : null,
      });
    });
    void auth.admin.content.list({ kind: 'PAGE', limit: 100 }).then((result) => {
      if (result.ok) setPagePaths(result.data.items.map((item) => item.key).sort());
    });
  }, []);

  const dirty = entry !== null && JSON.stringify(document) !== baseline;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const warnInternalNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.href === window.location.href
      )
        return;
      if (!window.confirm('Vous avez des modifications non enregistrées. Quitter cette page ?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', warnInternalNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', warnInternalNavigation, true);
    };
  }, [dirty]);

  const issues = useMemo(() => {
    const map = new Map<string, string>();
    if (!entry) return map;
    const result = documentSchemaOf(entry.kind).safeParse(document);
    if (!result.success) {
      for (const issue of editorIssues(result.error.issues)) {
        if (!map.has(issue.path)) map.set(issue.path, issue.message);
      }
    }
    for (const issue of serverIssues) if (!map.has(issue.path)) map.set(issue.path, issue.message);
    for (const [path, message] of localErrors) map.set(path, message);
    return map;
  }, [entry, document, serverIssues, localErrors]);

  const onChange = useCallback((update: (previous: unknown) => unknown) => {
    setServerIssues([]);
    setDocument((previous: unknown) => update(previous));
  }, []);

  const onLocalError = useCallback((key: string, message: string | null) => {
    setLocalErrors((previous) => {
      if ((previous.get(key) ?? null) === message) return previous;
      const copy = new Map(previous);
      if (message === null) copy.delete(key);
      else copy.set(key, message);
      return copy;
    });
  }, []);

  const handleError = (failure: ApiError) => {
    if (failure.code === 'CONTENT_DRAFT_CONFLICT') setConflict(true);
    if (failure.details?.issues) setServerIssues(failure.details.issues);
    setError(failure.message);
  };

  const act = async (
    action: () => Promise<ApiResult<ContentEntryDetail>>,
    success: (entry: ContentEntryDetail) => string,
  ) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!result.ok) {
        handleError(result.error);
        return false;
      }
      applyEntry(result.data);
      setNotice(success(result.data));
      return true;
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="ops-content-editor">
        <FormAlert message={loadError} />
        <p>
          <Link href="/contenus">Retour aux contenus</Link>
        </p>
      </div>
    );
  }
  if (!entry) return <p role="status">Chargement du contenu…</p>;

  const archived = entry.archivedAt !== null;
  const readOnly = !canManage || archived;
  const draft = entry.draft;
  const blocked = issues.size > 0;
  const name = entry.kind === 'PAGE' ? entry.key : KIND_LABELS[entry.kind];
  const missing =
    entry.kind === 'SITE_SETTINGS'
      ? (() => {
          const parsed = siteSettingsSchema.safeParse(document);
          return parsed.success ? missingOwnerInputs(parsed.data) : [];
        })()
      : [];

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || blocked) return;
    void act(
      () =>
        auth.admin.content.saveDraft(entry.id, {
          document: document as Record<string, unknown>,
          ...(note.trim() ? { note: note.trim() } : {}),
          expectedDraftUpdatedAt: draft?.updatedAt ?? null,
        }),
      (saved) =>
        `Brouillon enregistré (révision ${saved.draft?.revision ?? '?'}). Il n’est pas encore en ligne.`,
    );
  };

  const publish = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || dirty || blocked) return;
    void act(
      () => auth.admin.content.publish(entry.id, draft.updatedAt),
      (published) =>
        `Révision ${published.published?.revision ?? '?'} publiée : elle est en ligne.`,
    );
  };

  const discard = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    void act(
      () => auth.admin.content.discardDraft(entry.id, draft.updatedAt),
      () => 'Brouillon abandonné : la version en ligne est inchangée.',
    );
  };

  const restore = (revision: number) =>
    void act(
      () => auth.admin.content.restore(entry.id, revision),
      (restored) =>
        `Révision ${revision} restaurée comme brouillon (révision ${restored.draft?.revision ?? '?'}). Publiez-la pour la remettre en ligne.`,
    );

  const archive = (event: FormEvent) => {
    event.preventDefault();
    if (archiveReason.trim().length < 3) return;
    void act(
      () => auth.admin.content.archive(entry.id, archiveReason.trim()),
      () => 'Page archivée : elle n’est plus servie par le site (404).',
    ).then((ok) => {
      if (ok) setArchiveReason('');
    });
  };

  const view = async (revision: number) => {
    const result = await auth.admin.content.revision(entry.id, revision);
    if (result.ok) setViewing(result.data);
    else setError(result.error.message);
  };

  const issueList = [...issues.entries()];

  return (
    <div className="ops-content-editor" data-testid="content-editor">
      <p>
        <Link href="/contenus">← Tous les contenus</Link>
      </p>
      <header className="ops-content-editor__head">
        <div>
          <p className="ops-page-kicker">{KIND_LABELS[entry.kind]}</p>
          <h2>{name}</h2>
        </div>
        <div className="ops-content-badges">
          {entry.published ? (
            <span className="ops-content-badge ops-content-badge--live">En ligne</span>
          ) : (
            <span className="ops-content-badge">Jamais publiée</span>
          )}
          {draft ? (
            <span className="ops-content-badge ops-content-badge--draft">Brouillon en cours</span>
          ) : null}
          {dirty ? (
            <span className="ops-content-badge ops-content-badge--dirty" role="status">
              Modifications non enregistrées
            </span>
          ) : null}
          {archived ? (
            <span className="ops-content-badge ops-content-badge--error">Archivée</span>
          ) : null}
        </div>
      </header>
      <dl className="ops-content-meta">
        <RevisionLine label="En ligne" revision={entry.published} />
        <RevisionLine label="Brouillon" revision={draft} />
      </dl>
      {!canManage ? (
        <p className="et-hint">
          Lecture seule : modifier un contenu demande la permission content.manage.
        </p>
      ) : null}
      {archived ? (
        <p className="ops-content-warning">
          Cette page est archivée depuis le {formatDate(entry.archivedAt!)} : désarchivez-la pour la
          modifier.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="ops-content-warning" data-testid="content-owner-missing">
          {missing.length} information{missing.length > 1 ? 's' : ''} de l’exploitant à compléter
          (contact, mentions légales). Elles ne sont pas affichées tant qu’elles ne sont pas
          renseignées.
        </p>
      ) : null}

      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {conflict ? (
        <div className="ops-content-warning" role="alert">
          <p>
            Quelqu’un a modifié ce contenu pendant votre saisie. Rechargez la dernière version : vos
            modifications non enregistrées seront perdues.
          </p>
          <button type="button" className="et-button" onClick={() => void load()}>
            Recharger la dernière version
          </button>
        </div>
      ) : null}

      <div className="ops-content-workspace">
        <form
          className="ops-content-form"
          aria-label={`Modifier : ${name}`}
          onSubmit={save}
          noValidate
        >
          {issueList.length > 0 && !readOnly ? (
            <div
              className="ops-content-issues"
              role="region"
              aria-labelledby="content-issues-title"
            >
              <h3 id="content-issues-title">
                {issueList.length} point{issueList.length > 1 ? 's' : ''} à corriger avant
                d’enregistrer
              </h3>
              <ul>
                {issueList.slice(0, 20).map(([path, message]) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="ops-content-issue-link"
                      onClick={() => focusIssue(path)}
                    >
                      {readablePath(path)} : {message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ContentEditorProvider
            key={formKey}
            value={document}
            onChange={onChange}
            issues={issues}
            onLocalError={onLocalError}
            readOnly={readOnly}
            canManageSeo={canManageSeo}
            pagePaths={pagePaths}
            openSections={openSections}
            setOpenSections={setOpenSections}
          >
            <DocumentForm kind={entry.kind} />
          </ContentEditorProvider>
          {readOnly ? null : (
            <div className="ops-content-actions">
              <div className="et-field">
                <label htmlFor="content-note">
                  Note de version <span className="ops-content-optional">(facultatif)</span>
                </label>
                <input
                  id="content-note"
                  className="et-input"
                  maxLength={200}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <button className="et-button" type="submit" disabled={busy || !dirty || blocked}>
                Enregistrer le brouillon
              </button>
              {!dirty ? <p className="et-hint">Aucune modification à enregistrer.</p> : null}
            </div>
          )}
        </form>

        <div className="ops-content-side">
          <ContentPreview
            kind={entry.kind}
            document={viewing ? viewing.document : document}
            site={site}
          />
          {viewing ? (
            <div className="ops-content-warning" role="status">
              <p>L’aperçu montre la révision {viewing.revision} (lecture seule).</p>
              <button
                type="button"
                className="et-button et-button--secondary"
                onClick={() => setViewing(null)}
              >
                Revenir à la version en cours d’édition
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {canManage && !archived ? (
        <section className="ops-content-section" aria-labelledby="content-publish-title">
          <h3 id="content-publish-title">Publication</h3>
          {draft ? (
            <>
              <form onSubmit={publish} aria-label="Publier le brouillon">
                <OpsConfirmSubmit
                  actionLabel="Publier le brouillon"
                  confirmLabel="Publier maintenant"
                  title={`Publier la révision ${draft.revision}`}
                  description="Le site affichera cette version dans la minute. La version en ligne actuelle reste dans l’historique et peut être restaurée."
                  disabled={busy || dirty || blocked}
                />
              </form>
              {dirty ? <p className="et-hint">Enregistrez d’abord vos modifications.</p> : null}
              <form onSubmit={discard} aria-label="Abandonner le brouillon">
                <OpsConfirmSubmit
                  actionLabel="Abandonner le brouillon"
                  confirmLabel="Abandonner"
                  title={`Abandonner la révision ${draft.revision}`}
                  description="Le brouillon est supprimé ; la version en ligne ne change pas."
                  disabled={busy}
                />
              </form>
            </>
          ) : (
            <p className="et-hint">
              Aucun brouillon : enregistrez des modifications pour pouvoir publier.
            </p>
          )}
        </section>
      ) : null}

      <section className="ops-content-section" aria-labelledby="content-history-title">
        <h3 id="content-history-title">Historique</h3>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Révisions de {name} (30 dernières)</caption>
            <thead>
              <tr>
                <th scope="col">Révision</th>
                <th scope="col">Statut</th>
                <th scope="col">Date</th>
                <th scope="col">Par</th>
                <th scope="col">Note</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entry.history.map((revision) => (
                <tr key={revision.id}>
                  <th scope="row">{revision.revision}</th>
                  <td>{STATUS_LABELS[revision.status]}</td>
                  <td>{formatDate(revision.publishedAt ?? revision.updatedAt)}</td>
                  <td>{(revision.publishedBy ?? revision.author)?.email ?? '—'}</td>
                  <td>{revision.note ?? '—'}</td>
                  <td className="ops-content-history-actions">
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Prévisualiser la révision ${revision.revision}`}
                      onClick={() => void view(revision.revision)}
                    >
                      Aperçu
                    </button>
                    {canManage && !archived && revision.status !== 'DRAFT' ? (
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Restaurer la révision ${revision.revision} comme brouillon`}
                        disabled={busy || Boolean(draft) || dirty}
                        onClick={() => restore(revision.revision)}
                      >
                        Restaurer
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {draft && canManage ? (
          <p className="et-hint">
            Restaurer une révision demande d’abord de publier ou d’abandonner le brouillon.
          </p>
        ) : null}
      </section>

      {canManage && entry.kind === 'PAGE' && entry.key !== '/' ? (
        <section className="ops-content-section" aria-labelledby="content-archive-title">
          <h3 id="content-archive-title">{archived ? 'Désarchiver' : 'Archiver la page'}</h3>
          {archived ? (
            <button
              type="button"
              className="et-button"
              disabled={busy}
              onClick={() =>
                void act(
                  () => auth.admin.content.unarchive(entry.id),
                  () => 'Page désarchivée : sa version publiée est de nouveau servie.',
                )
              }
            >
              Désarchiver la page
            </button>
          ) : (
            <form onSubmit={archive} aria-label="Archiver la page" className="et-form">
              <div className="et-field">
                <label htmlFor="content-archive-reason">Motif de l’archivage</label>
                <textarea
                  id="content-archive-reason"
                  className="et-input"
                  rows={2}
                  minLength={3}
                  maxLength={300}
                  required
                  value={archiveReason}
                  onChange={(event) => setArchiveReason(event.target.value)}
                />
              </div>
              <OpsConfirmSubmit
                actionLabel="Archiver la page"
                confirmLabel="Archiver"
                title={`Archiver ${entry.key}`}
                description="Le site répondra 404 sur ce chemin et la page sortira du plan du site. L’historique est conservé."
                disabled={busy || archiveReason.trim().length < 3}
              />
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
