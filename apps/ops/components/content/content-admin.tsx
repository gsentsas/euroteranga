'use client';

import type { ContentEntrySummary } from '@euroteranga/auth-client';
import { contentPathSchema, DEFAULT_HOME_PAGE, PAGE_TEMPLATES } from '@euroteranga/content';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { useCan } from '../staff-access';
import { KIND_LABELS } from './content-editor';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export const editorHref = (id: string) => `/contenus/edition?entree=${encodeURIComponent(id)}`;

function statusOf(entry: ContentEntrySummary): string {
  if (entry.archivedAt) return 'Archivée';
  const parts: string[] = [];
  parts.push(
    entry.published ? `En ligne (révision ${entry.published.revision})` : 'Jamais publiée',
  );
  if (entry.draft) parts.push(`brouillon en cours (révision ${entry.draft.revision})`);
  return parts.join(', ');
}

function CreatePageForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { run, busy, feedback } = useAdminFeedback();
  const [path, setPath] = useState('/');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState('');
  /** A page created whose template could not be applied: it exists, open it. */
  const [createdWithoutTemplate, setCreatedWithoutTemplate] = useState<string | null>(null);
  const template = PAGE_TEMPLATES.find((candidate) => candidate.id === templateId);
  const pathCheck = contentPathSchema.safeParse(path);
  const pathError =
    path.length > 1 && !pathCheck.success ? pathCheck.error.issues[0]?.message : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !pathCheck.success) return;
    setCreatedWithoutTemplate(null);
    let createdId: string | null = null;
    let templateFailed = false;
    const ok = await run(async () => {
      const result = await auth.admin.content.create({
        kind: 'PAGE',
        path: pathCheck.data,
        title: title.trim(),
        description: description.trim(),
      });
      if (!result.ok || !template) {
        if (result.ok) createdId = result.data.id;
        return result;
      }
      createdId = result.data.id;
      // UI-PUBLIC-2: the template brings its sections only. The SEO of the
      // created draft (non indexed) is kept: indexing stays an SEO decision.
      const saved = await auth.admin.content.saveDraft(result.data.id, {
        document: {
          ...(result.data.draft?.document ?? {}),
          title: title.trim(),
          blocks: template.document.blocks,
        } as Record<string, unknown>,
        note: `Modèle « ${template.label} »`,
        expectedDraftUpdatedAt: result.data.draft?.updatedAt ?? null,
      });
      if (saved.ok) return saved;
      // The page exists with its path: creating it again would be refused.
      templateFailed = true;
      return {
        ok: false as const,
        error: {
          ...saved.error,
          message: `La page ${pathCheck.data} a été créée, mais le modèle n’a pas pu être appliqué : ${saved.error.message}`,
        },
      };
    }, `Page ${pathCheck.data} créée (brouillon, non indexée).`);
    if (ok && createdId) onCreated(createdId);
    else if (templateFailed && createdId) setCreatedWithoutTemplate(createdId);
  };

  return (
    <form className="et-form et-network-form" aria-label="Créer une page" onSubmit={submit}>
      <h2>Créer une page</h2>
      {feedback}
      {createdWithoutTemplate ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => onCreated(createdWithoutTemplate)}
        >
          Ouvrir la page créée
        </button>
      ) : null}
      <div className="et-field">
        <label htmlFor="content-new-template">Modèle</label>
        <select
          id="content-new-template"
          className="et-select"
          value={templateId}
          aria-describedby="content-new-template-hint"
          onChange={(event) => {
            const chosen = PAGE_TEMPLATES.find((candidate) => candidate.id === event.target.value);
            setTemplateId(event.target.value);
            if (!chosen) return;
            setPath(chosen.path);
            setTitle(chosen.document.title);
            setDescription(chosen.document.seo.description);
          }}
        >
          <option value="">Page vide</option>
          {PAGE_TEMPLATES.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        <p id="content-new-template-hint" className="et-hint">
          {template
            ? template.description
            : 'Un modèle prépare les sections ; dates, prix, itinéraires et autocars restent lus en direct.'}
        </p>
      </div>
      <div className="et-field">
        <label htmlFor="content-new-path">Chemin public</label>
        <input
          id="content-new-path"
          className="et-input"
          required
          maxLength={120}
          value={path}
          aria-invalid={pathError ? true : undefined}
          aria-describedby="content-new-path-hint"
          onChange={(event) => setPath(event.target.value)}
        />
        <p id="content-new-path-hint" className="et-hint">
          {pathError ?? 'Exemple : /paris-dakar ou /aide/bagages (minuscules, chiffres, tirets).'}
        </p>
      </div>
      <div className="et-field">
        <label htmlFor="content-new-title">Titre</label>
        <input
          id="content-new-title"
          className="et-input"
          required
          maxLength={140}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="et-field">
        <label htmlFor="content-new-description">Description pour les moteurs de recherche</label>
        <textarea
          id="content-new-description"
          className="et-input"
          required
          maxLength={170}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <p className="et-hint">
        Une nouvelle page est un brouillon non indexé : elle n’est visible qu’une fois publiée.
      </p>
      <button className="et-button" type="submit" disabled={busy || !pathCheck.success}>
        Créer la page
      </button>
    </form>
  );
}

/** Website content (content.read) and creation (content.manage). */
export function ContentAdmin() {
  const router = useRouter();
  const canManage = useCan('content.manage');
  const canManageSeo = useCan('seo.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [pages, setPages] = useState<ContentEntrySummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [singletons, setSingletons] = useState<ContentEntrySummary[]>([]);

  const load = useCallback(
    async (cursor?: string) => {
      const [pageResult, settings, navigation] = await Promise.all([
        auth.admin.content.list({ kind: 'PAGE', limit: 50, ...(cursor ? { cursor } : {}) }),
        cursor ? null : auth.admin.content.list({ kind: 'SITE_SETTINGS' }),
        cursor ? null : auth.admin.content.list({ kind: 'NAVIGATION' }),
      ]);
      if (!pageResult.ok) {
        setError(pageResult.error.message);
        return;
      }
      setPages((previous) =>
        cursor ? [...(previous ?? []), ...pageResult.data.items] : pageResult.data.items,
      );
      setNextCursor(pageResult.data.nextCursor);
      if (settings?.ok && navigation?.ok)
        setSingletons([...settings.data.items, ...navigation.data.items]);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const open = (id: string) => router.push(editorHref(id));

  const createSingleton = (kind: 'SITE_SETTINGS' | 'NAVIGATION') => {
    let createdId: string | null = null;
    const createdLabel = kind === 'NAVIGATION' ? 'Navigation créée' : 'Paramètres du site créés';
    void run(async () => {
      const result = await auth.admin.content.create({ kind });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `${createdLabel} à partir du contenu par défaut (brouillon).`).then((ok) => {
      if (ok && createdId) open(createdId);
    });
  };

  // The home page starts from what the website shows today (the default
  // content), not from an empty page.
  const createHome = () => {
    let createdId: string | null = null;
    void run(async () => {
      const created = await auth.admin.content.create({
        kind: 'PAGE',
        path: '/',
        title: DEFAULT_HOME_PAGE.title,
        description: DEFAULT_HOME_PAGE.seo.description,
      });
      if (!created.ok) return created;
      createdId = created.data.id;
      const seo = canManageSeo ? DEFAULT_HOME_PAGE.seo : created.data.draft?.document.seo;
      return auth.admin.content.saveDraft(created.data.id, {
        document: { ...DEFAULT_HOME_PAGE, seo } as Record<string, unknown>,
        note: 'Contenu actuel du site',
        expectedDraftUpdatedAt: created.data.draft?.updatedAt ?? null,
      });
    }, 'Page d’accueil créée à partir du contenu actuel du site (brouillon).').then((ok) => {
      if (ok && createdId) open(createdId);
      else void load();
    });
  };

  if (!pages) return <p role="status">Chargement des contenus…</p>;

  const home = pages.find((page) => page.key === '/');
  const settings = singletons.find((entry) => entry.kind === 'SITE_SETTINGS');
  const navigation = singletons.find((entry) => entry.kind === 'NAVIGATION');

  return (
    <div className="et-network" data-testid="content-workspace">
      <p>
        Le site public affiche les versions publiées. Une modification est d’abord un brouillon,
        prévisualisé tel que le site l’affichera, puis publiée ; chaque version reste dans
        l’historique et peut être restaurée. Les prix ne se saisissent jamais ici : ils viennent de
        la tarification.
      </p>
      {feedback}

      <section aria-labelledby="content-site-title">
        <h2 id="content-site-title">Site</h2>
        <ul className="ops-content-cards">
          {(
            [
              [
                'SITE_SETTINGS',
                settings,
                'Marque, contact, mentions légales, réseaux, pied de page.',
              ],
              [
                'NAVIGATION',
                navigation,
                'Menu de l’en-tête, bouton principal, colonnes du pied de page.',
              ],
            ] as const
          ).map(([kind, entry, description]) => (
            <li key={kind} className="ops-content-card">
              <h3>{KIND_LABELS[kind]}</h3>
              <p>{description}</p>
              <p className="et-hint">
                {entry ? statusOf(entry) : 'Contenu par défaut (pas encore créé).'}
              </p>
              {entry ? (
                <Link className="et-button et-button--secondary" href={editorHref(entry.id)}>
                  {canManage ? 'Modifier' : 'Consulter'}
                  <span className="et-visually-hidden"> : {KIND_LABELS[kind]}</span>
                </Link>
              ) : canManage ? (
                <button
                  type="button"
                  className="et-button"
                  disabled={busy}
                  onClick={() => createSingleton(kind)}
                >
                  Personnaliser<span className="et-visually-hidden"> : {KIND_LABELS[kind]}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="content-pages-title">
        <h2 id="content-pages-title">Pages</h2>
        {!home ? (
          <div className="ops-content-warning">
            <p>La page d’accueil affiche le contenu par défaut tant qu’elle n’est pas créée ici.</p>
            {canManage ? (
              <button type="button" className="et-button" disabled={busy} onClick={createHome}>
                Créer la page d’accueil à partir du contenu actuel
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Pages du site public</caption>
            <thead>
              <tr>
                <th scope="col">Chemin</th>
                <th scope="col">Titre</th>
                <th scope="col">Statut</th>
                <th scope="col">Modifiée le</th>
                <th scope="col">Fiche</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.id}>
                  <th scope="row">
                    <span className="et-tag">{page.key}</span>
                  </th>
                  <td>{page.title ?? '—'}</td>
                  <td>{statusOf(page)}</td>
                  <td>{dateFormat.format(new Date(page.updatedAt))}</td>
                  <td>
                    <Link className="et-button et-button--secondary" href={editorHref(page.id)}>
                      {canManage && !page.archivedAt ? 'Modifier' : 'Consulter'}
                      <span className="et-visually-hidden"> la page {page.key}</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages.length === 0 ? <p>Aucune page créée.</p> : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Afficher plus
          </button>
        ) : null}
      </section>

      {canManage ? <CreatePageForm onCreated={open} /> : null}
    </div>
  );
}
