'use client';

import type {
  AdminSeatMap,
  AdminSeatMapSummary,
  AdminSeatMapVersion,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { OpsDrawer } from '../ops-drawer';
import { OpsIcon } from '../ops-icons';
import {
  OpsDataTable,
  OpsFilterBar,
  OpsKpiCard,
  OpsSearchInput,
  OpsStatusBadge,
  OpsTabs,
  OpsVersionBadge,
} from '../ops-ui';
import { useCan } from '../staff-access';
import { SeatMapDraftEditor } from './seat-map-editor';
import { seatsLabel, VERSION_STATUS_LABELS } from './seat-map-format';
import { SeatMapCellsTable, SeatMapPreview } from './seat-map-preview';

type Run = ReturnType<typeof useAdminFeedback>['run'];
type FilterState = 'all' | 'active' | 'inactive';
type CapacityFilter = 'all' | 'none' | 'under50' | '50plus';
type SortMode = 'updated' | 'code' | 'capacity';

const formatDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

const publishedVersion = (map: AdminSeatMapSummary | AdminSeatMap) =>
  map.versions.find((version) => version.status === 'PUBLISHED');

const draftVersion = (map: AdminSeatMapSummary | AdminSeatMap) =>
  map.versions.find((version) => version.status === 'DRAFT');

async function fetchAllSeatMaps() {
  const items: AdminSeatMapSummary[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();

  for (;;) {
    const result = await auth.admin.seatMaps.seatMaps({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) return result;

    items.push(...result.data.items);
    const next = result.data.nextCursor;
    if (!next) return { ok: true as const, data: items };
    if (seen.has(next)) throw new Error('Pagination des plans de sièges incohérente.');
    seen.add(next);
    cursor = next;
  }
}

function CreateSeatMapForm({
  run,
  busy,
  onCreated,
}: {
  run: Run;
  busy: boolean;
  onCreated: (id: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    let createdId: string | null = null;
    const normalizedCode = code.trim().toUpperCase();
    const ok = await run(async () => {
      const result = await auth.admin.seatMaps.createSeatMap({ code, name, active: true });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Plan de sièges ${normalizedCode} créé.`);

    if (ok && createdId) {
      setCode('');
      setName('');
      onCreated(createdId);
    }
  };

  return (
    <form
      className="et-form ops-seatmap-create"
      aria-label="Créer un plan de sièges"
      onSubmit={submit}
    >
      <div className="ops-seatmap-create__intro">
        <span className="ops-seatmap-create__icon" aria-hidden="true">
          <OpsIcon name="seat" />
        </span>
        <div>
          <h3>Nouveau plan</h3>
          <p>
            Créez l’identité stable du plan. La disposition physique sera ajoutée dans une version
            brouillon.
          </p>
        </div>
      </div>
      <TextField
        label="Code du plan"
        name="code"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
        hint="Identifiant stable, par exemple COACH_TEST_A."
      />
      <TextField
        label="Nom du plan"
        name="name"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <button className="et-button" type="submit" disabled={busy || !code.trim() || !name.trim()}>
        Créer le plan
      </button>
    </form>
  );
}

function VersionStatus({ version }: { version: AdminSeatMapVersion }) {
  const tone =
    version.status === 'PUBLISHED' ? 'success' : version.status === 'DRAFT' ? 'warning' : 'neutral';
  return <OpsStatusBadge tone={tone}>{VERSION_STATUS_LABELS[version.status]}</OpsStatusBadge>;
}

function SeatMapHistory({ seatMap }: { seatMap: AdminSeatMap }) {
  const events = seatMap.versions
    .flatMap((version) => {
      const entries: Array<{ at: string; title: string; detail: string }> = [
        {
          at: version.createdAt,
          title: `Version ${version.version} créée`,
          detail: `${seatsLabel(version.seatCount)} dans la disposition actuelle de cette version.`,
        },
      ];
      if (version.publishedAt) {
        entries.push({
          at: version.publishedAt,
          title: `Version ${version.version} publiée`,
          detail: 'La version est devenue historique et immuable.',
        });
      }
      if (version.retiredAt) {
        entries.push({
          at: version.retiredAt,
          title: `Version ${version.version} retirée`,
          detail: 'Elle reste valide pour les usages historiques existants.',
        });
      }
      return entries;
    })
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (!events.length) return <p className="ops-seatmap-empty">Aucun événement de version.</p>;

  return (
    <ol className="ops-seatmap-timeline" aria-label={`Historique du plan ${seatMap.code}`}>
      {events.map((event) => (
        <li key={`${event.at}-${event.title}`}>
          <span className="ops-seatmap-timeline__dot" aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            <span>{formatDate(event.at)}</span>
            <p>{event.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SeatMapDetail({
  seatMap,
  canManage,
  run,
  busy,
  onReload,
}: {
  seatMap: AdminSeatMap;
  canManage: boolean;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const [tab, setTab] = useState('overview');
  const draft = draftVersion(seatMap) as AdminSeatMapVersion | undefined;
  const published = publishedVersion(seatMap) as AdminSeatMapVersion | undefined;
  const visualVersion = published ?? draft ?? seatMap.versions[0];

  useEffect(() => {
    setTab('overview');
  }, [seatMap.id]);

  const createDraft = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.createVersion(seatMap.id),
      `Nouvelle version brouillon du plan ${seatMap.code} créée.`,
    );
    if (ok) {
      setTab('versions');
      await onReload();
    }
  };

  const toggle = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.updateSeatMap(seatMap.id, { active: !seatMap.active }),
      `Plan ${seatMap.code} ${seatMap.active ? 'désactivé' : 'activé'}.`,
    );
    if (ok) await onReload();
  };

  return (
    <section aria-label={`Plan ${seatMap.code} — ${seatMap.name}`} className="ops-seatmap-detail">
      <div className="ops-seatmap-detail__status">
        <OpsStatusBadge tone={seatMap.active ? 'success' : 'neutral'}>
          {seatMap.active ? 'Actif' : 'Désactivé'}
        </OpsStatusBadge>
        {published ? <OpsVersionBadge>v{published.version}</OpsVersionBadge> : null}
      </div>

      <OpsTabs
        label={`Navigation du plan ${seatMap.code}`}
        selected={tab}
        onSelect={setTab}
        tabs={[
          { id: 'overview', label: 'Aperçu' },
          { id: 'details', label: 'Détails' },
          { id: 'versions', label: 'Versions' },
          { id: 'history', label: 'Historique' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="ops-seatmap-tab-panel" role="tabpanel">
          {visualVersion ? (
            <>
              <div className="ops-seatmap-section-heading">
                <div>
                  <span>Disposition physique</span>
                  <h3>
                    Version {visualVersion.version} · {seatsLabel(visualVersion.seatCount)}
                  </h3>
                </div>
                <VersionStatus version={visualVersion} />
              </div>
              <SeatMapPreview
                cells={visualVersion.cells}
                label={`de la version ${visualVersion.version}`}
              />
              <div className="ops-seatmap-usage-grid">
                <article>
                  <span>Capacité</span>
                  <strong>{visualVersion.seatCount}</strong>
                  <small>sièges physiques</small>
                </article>
                <article>
                  <span>Véhicules</span>
                  <strong>{visualVersion.vehicleCount}</strong>
                  <small>utilisant cette version</small>
                </article>
                <article>
                  <span>Voyages</span>
                  <strong>{visualVersion.tripCount}</strong>
                  <small>portant cette version</small>
                </article>
              </div>
            </>
          ) : (
            <div className="ops-seatmap-empty">
              <OpsIcon name="seat" />
              <strong>Aucune version</strong>
              <p>Créez une version brouillon pour définir la configuration physique.</p>
            </div>
          )}
        </div>
      ) : null}

      {tab === 'details' ? (
        <div className="ops-seatmap-tab-panel" role="tabpanel">
          <dl className="ops-seatmap-properties">
            <div>
              <dt>Code</dt>
              <dd>{seatMap.code}</dd>
            </div>
            <div>
              <dt>Nom</dt>
              <dd>{seatMap.name}</dd>
            </div>
            <div>
              <dt>État</dt>
              <dd>{seatMap.active ? 'Actif' : 'Désactivé'}</dd>
            </div>
            <div>
              <dt>Créé le</dt>
              <dd>{formatDate(seatMap.createdAt)}</dd>
            </div>
            <div>
              <dt>Dernière mise à jour</dt>
              <dd>{formatDate(seatMap.updatedAt)}</dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>{seatMap.versions.length}</dd>
            </div>
          </dl>
          <p className="ops-seatmap-domain-note">
            La capacité n’est jamais saisie manuellement : elle correspond au nombre de cellules de
            type siège.
          </p>
        </div>
      ) : null}

      {tab === 'versions' ? (
        <div className="ops-seatmap-tab-panel" role="tabpanel">
          <ol className="ops-seatmap-version-list" aria-label={`Versions du plan ${seatMap.code}`}>
            {seatMap.versions.map((version) => (
              <li key={version.id}>
                <div className="ops-seatmap-version-list__heading">
                  <div>
                    <strong>Version {version.version}</strong>
                    <span>{formatDate(version.updatedAt)}</span>
                  </div>
                  <VersionStatus version={version} />
                </div>
                <p>
                  capacité {seatsLabel(version.seatCount)}
                  {version.status !== 'DRAFT'
                    ? ` — ${version.vehicleCount} véhicule(s), ${version.tripCount} voyage(s)`
                    : ''}
                </p>
                {version.status !== 'DRAFT' ? (
                  <details>
                    <summary>Consulter la disposition</summary>
                    <SeatMapPreview
                      cells={version.cells}
                      label={`de la version ${version.version}`}
                    />
                    <SeatMapCellsTable
                      cells={version.cells}
                      caption={`Cellules de la version ${version.version}`}
                    />
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
          {seatMap.versions.length === 0 ? (
            <p className="ops-seatmap-empty">Aucune version.</p>
          ) : null}

          {draft && canManage ? (
            <SeatMapDraftEditor
              seatMap={seatMap}
              draft={draft}
              run={run}
              busy={busy}
              onSaved={onReload}
            />
          ) : null}
          {draft && !canManage ? (
            <SeatMapCellsTable
              cells={draft.cells}
              caption={`Cellules du brouillon version ${draft.version}`}
            />
          ) : null}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="ops-seatmap-tab-panel" role="tabpanel">
          <SeatMapHistory seatMap={seatMap} />
        </div>
      ) : null}

      {canManage ? (
        <div className="ops-seatmap-detail__actions">
          <button
            type="button"
            className="et-button et-button--secondary"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {seatMap.active
              ? `Désactiver le plan ${seatMap.code}`
              : `Activer le plan ${seatMap.code}`}
          </button>
          {!draft ? (
            <button
              type="button"
              className="et-button"
              disabled={busy}
              onClick={() => void createDraft()}
            >
              Créer une version brouillon
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Seat-map catalogue (seatmap.read) and edition (seatmap.manage). */
export function SeatMapsAdmin() {
  const canManage = useCan('seatmap.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();

  const [maps, setMaps] = useState<AdminSeatMapSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminSeatMap | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<FilterState>('all');
  const [capacityFilter, setCapacityFilter] = useState<CapacityFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('updated');

  const load = useCallback(async () => {
    try {
      const result = await fetchAllSeatMaps();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMaps(result.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Chargement des plans impossible.');
    }
  }, [setError]);

  const loadDetail = useCallback(
    async (id: string) => {
      const result = await auth.admin.seatMaps.seatMap(id);
      if (result.ok) setDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  const kpis = useMemo(() => {
    if (!maps) return { active: 0, published: 0, seats: 0, drafts: 0 };
    return maps.reduce(
      (acc, map) => {
        if (map.active) acc.active += 1;
        for (const version of map.versions) {
          if (version.status === 'PUBLISHED') {
            acc.published += 1;
            acc.seats += version.seatCount;
          }
          if (version.status === 'DRAFT') acc.drafts += 1;
        }
        return acc;
      },
      { active: 0, published: 0, seats: 0, drafts: 0 },
    );
  }, [maps]);

  const visibleMaps = useMemo(() => {
    if (!maps) return [];
    const normalized = query.trim().toLocaleLowerCase('fr-FR');

    return maps
      .filter((map) => {
        if (
          normalized &&
          !`${map.code} ${map.name}`.toLocaleLowerCase('fr-FR').includes(normalized)
        ) {
          return false;
        }
        if (stateFilter === 'active' && !map.active) return false;
        if (stateFilter === 'inactive' && map.active) return false;

        const capacity = publishedVersion(map)?.seatCount ?? null;
        if (capacityFilter === 'none' && capacity !== null) return false;
        if (capacityFilter === 'under50' && (capacity === null || capacity >= 50)) return false;
        if (capacityFilter === '50plus' && (capacity === null || capacity < 50)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortMode === 'code') return a.code.localeCompare(b.code, 'fr');
        if (sortMode === 'capacity') {
          return (publishedVersion(b)?.seatCount ?? -1) - (publishedVersion(a)?.seatCount ?? -1);
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [capacityFilter, maps, query, sortMode, stateFilter]);

  if (!maps) return <p role="status">Chargement des plans de sièges…</p>;

  return (
    <div className="ops-seatmaps" data-testid="seat-maps-workspace">
      <div className="ops-seatmaps__intro">
        <p>
          Un plan de sièges décrit la configuration physique d’un véhicule. Ses versions publiées
          sont historiques et immuables ; la capacité est le nombre de sièges. Aucun siège n’est
          vendu ici.
        </p>
        {canManage ? (
          <button className="et-button" type="button" onClick={() => setCreateOpen(true)}>
            <span aria-hidden="true">+</span> Nouveau plan
          </button>
        ) : null}
      </div>

      {feedback}

      <section className="ops-seatmaps__kpis" aria-label="Indicateurs des plans de sièges">
        <OpsKpiCard
          label="Plans actifs"
          value={kpis.active}
          helper={`${maps.length} plan(s) au total`}
          icon="seat"
          tone="success"
        />
        <OpsKpiCard
          label="Versions publiées"
          value={kpis.published}
          helper="Versions actuellement publiées"
          icon="check"
          tone="info"
        />
        <OpsKpiCard
          label="Sièges configurés"
          value={kpis.seats}
          helper="Somme des capacités publiées"
          icon="bus"
          tone="info"
        />
        <OpsKpiCard
          label="Brouillons"
          value={kpis.drafts}
          helper="Versions encore modifiables"
          icon="document"
          tone="warning"
        />
      </section>

      <section className="ops-seatmaps__catalogue" aria-labelledby="seat-maps-title">
        <div className="ops-seatmaps__catalogue-heading">
          <div>
            <span>Catalogue</span>
            <h2 id="seat-maps-title">Plans de sièges</h2>
          </div>
          <p aria-live="polite">
            {visibleMaps.length} résultat{visibleMaps.length > 1 ? 's' : ''}
          </p>
        </div>

        <OpsFilterBar label="Filtres des plans de sièges">
          <OpsSearchInput
            label="Rechercher un plan"
            value={query}
            placeholder="Rechercher un plan, un code…"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
          <label className="ops-seatmap-filter">
            <span>État</span>
            <select
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as FilterState)}
            >
              <option value="all">Tous les états</option>
              <option value="active">Actifs</option>
              <option value="inactive">Désactivés</option>
            </select>
          </label>
          <label className="ops-seatmap-filter">
            <span>Capacité</span>
            <select
              value={capacityFilter}
              onChange={(event) => setCapacityFilter(event.target.value as CapacityFilter)}
            >
              <option value="all">Toutes</option>
              <option value="none">Sans version publiée</option>
              <option value="under50">Moins de 50 sièges</option>
              <option value="50plus">50 sièges et plus</option>
            </select>
          </label>
          <label className="ops-seatmap-filter">
            <span>Trier par</span>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
            >
              <option value="updated">Dernière mise à jour</option>
              <option value="code">Code</option>
              <option value="capacity">Capacité</option>
            </select>
          </label>
        </OpsFilterBar>

        <div className="ops-seatmap-desktop-table">
          <OpsDataTable caption="Plans de sièges">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Nom</th>
                <th scope="col">Version publiée</th>
                <th scope="col">Capacité</th>
                <th scope="col">État</th>
                <th scope="col">Mise à jour</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleMaps.map((map) => {
                const published = publishedVersion(map);
                return (
                  <tr key={map.id}>
                    <th scope="row">
                      <div className="ops-seatmap-plan-cell">
                        <span className="ops-seatmap-plan-cell__icon" aria-hidden="true">
                          <OpsIcon name="seat" />
                        </span>
                        <div>
                          <strong>{map.code}</strong>
                          <span>{map.versions.length} version(s)</span>
                        </div>
                      </div>
                    </th>
                    <td>{map.name}</td>
                    <td>
                      {published ? <OpsVersionBadge>v{published.version}</OpsVersionBadge> : '—'}
                    </td>
                    <td>{published ? seatsLabel(published.seatCount) : '—'}</td>
                    <td>
                      <OpsStatusBadge tone={map.active ? 'success' : 'neutral'}>
                        {map.active ? 'Actif' : 'Désactivé'}
                      </OpsStatusBadge>
                    </td>
                    <td>{formatDate(map.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter le plan ${map.code}`}
                        onClick={() => setSelectedId(map.id)}
                      >
                        Consulter
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </OpsDataTable>
        </div>

        <div className="ops-seatmap-mobile-list" aria-label="Plans de sièges">
          {visibleMaps.map((map) => {
            const published = publishedVersion(map);
            return (
              <article key={map.id} className="ops-seatmap-card">
                <div className="ops-seatmap-card__heading">
                  <span className="ops-seatmap-plan-cell__icon" aria-hidden="true">
                    <OpsIcon name="seat" />
                  </span>
                  <div>
                    <strong>{map.code}</strong>
                    <span>{map.name}</span>
                  </div>
                  <OpsStatusBadge tone={map.active ? 'success' : 'neutral'}>
                    {map.active ? 'Actif' : 'Désactivé'}
                  </OpsStatusBadge>
                </div>
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>{published ? `v${published.version}` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Capacité</dt>
                    <dd>{published ? seatsLabel(published.seatCount) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Mise à jour</dt>
                    <dd>{formatDate(map.updatedAt)}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  aria-label={`Consulter le plan ${map.code}`}
                  onClick={() => setSelectedId(map.id)}
                >
                  Consulter
                </button>
              </article>
            );
          })}
        </div>

        {visibleMaps.length === 0 ? (
          <div className="ops-seatmap-empty">
            <OpsIcon name="search" />
            <strong>Aucun plan correspondant</strong>
            <p>Modifiez la recherche ou les filtres.</p>
          </div>
        ) : null}
      </section>

      <OpsDrawer
        open={createOpen}
        title="Nouveau plan de sièges"
        subtitle="Créer l’identité stable du plan"
        onClose={() => setCreateOpen(false)}
      >
        <CreateSeatMapForm
          run={run}
          busy={busy}
          onCreated={(id) => {
            setCreateOpen(false);
            void load().then(() => setSelectedId(id));
          }}
        />
      </OpsDrawer>

      <OpsDrawer
        open={Boolean(selectedId)}
        title={detail ? detail.code : 'Plan de sièges'}
        subtitle={detail?.name ?? 'Chargement du plan…'}
        onClose={() => setSelectedId(null)}
      >
        {selectedId && !detail ? <p role="status">Chargement du plan…</p> : null}
        {detail ? (
          <SeatMapDetail
            seatMap={detail}
            canManage={canManage}
            run={run}
            busy={busy}
            onReload={reload}
          />
        ) : null}
      </OpsDrawer>
    </div>
  );
}
