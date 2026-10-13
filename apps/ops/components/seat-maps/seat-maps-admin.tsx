'use client';

import type { AdminSeatMap, AdminSeatMapSummary } from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { useCan } from '../staff-access';
import { SeatMapDraftEditor } from './seat-map-editor';
import { seatsLabel, VERSION_STATUS_LABELS } from './seat-map-format';
import { SeatMapCellsTable, SeatMapPreview } from './seat-map-preview';

type Run = ReturnType<typeof useAdminFeedback>['run'];

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
    const ok = await run(async () => {
      const result = await auth.admin.seatMaps.createSeatMap({ code, name, active: true });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Plan de sièges ${code.trim().toUpperCase()} créé.`);
    if (ok && createdId) {
      setCode('');
      setName('');
      onCreated(createdId);
    }
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label="Créer un plan de sièges"
      onSubmit={submit}
    >
      <h2>Créer un plan de sièges</h2>
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
      <button className="et-button" type="submit" disabled={busy}>
        Créer le plan
      </button>
    </form>
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
  const draft = seatMap.versions.find((version) => version.status === 'DRAFT');
  const history = seatMap.versions.filter((version) => version.status !== 'DRAFT');
  const createDraft = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.createVersion(seatMap.id),
      `Nouvelle version brouillon du plan ${seatMap.code} créée.`,
    );
    if (ok) await onReload();
  };
  const toggle = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.updateSeatMap(seatMap.id, { active: !seatMap.active }),
      `Plan ${seatMap.code} ${seatMap.active ? 'désactivé' : 'activé'}.`,
    );
    if (ok) await onReload();
  };
  return (
    <section aria-labelledby="seat-map-detail-title" className="et-network-panel">
      <h2 id="seat-map-detail-title">
        Plan {seatMap.code} — {seatMap.name}
      </h2>
      <p>
        {seatMap.active
          ? 'Actif'
          : 'Désactivé (les versions publiées restent valables pour leurs usages)'}
      </p>
      {canManage ? (
        <div className="et-actions">
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

      <h3>Versions</h3>
      <ol className="et-network-versions" aria-label={`Versions du plan ${seatMap.code}`}>
        {seatMap.versions.map((version) => (
          <li key={version.id}>
            <strong>Version {version.version}</strong>{' '}
            <span className="et-tag">{VERSION_STATUS_LABELS[version.status]}</span> — capacité{' '}
            {seatsLabel(version.seatCount)}
            {version.status !== 'DRAFT'
              ? ` — ${version.vehicleCount} véhicule(s), ${version.tripCount} voyage(s)`
              : ''}
          </li>
        ))}
      </ol>
      {seatMap.versions.length === 0 ? <p>Aucune version.</p> : null}

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

      {history.map((version) => (
        <details key={version.id}>
          <summary>
            Disposition de la version {version.version} ({VERSION_STATUS_LABELS[version.status]},
            lecture seule)
          </summary>
          <SeatMapPreview cells={version.cells} label={`de la version ${version.version}`} />
          <SeatMapCellsTable
            cells={version.cells}
            caption={`Cellules de la version ${version.version}`}
          />
        </details>
      ))}
    </section>
  );
}

/** Seat-map catalogue (seatmap.read) and edition (seatmap.manage). */
export function SeatMapsAdmin() {
  const canManage = useCan('seatmap.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [maps, setMaps] = useState<AdminSeatMapSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminSeatMap | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.seatMaps.seatMaps(cursor ? { cursor } : {});
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMaps((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [setError],
  );
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

  if (!maps) return <p role="status">Chargement des plans de sièges…</p>;

  return (
    <div className="et-network" data-testid="seat-maps-workspace">
      <p>
        Un plan de sièges décrit la configuration physique d’un véhicule. Ses versions publiées sont
        historiques et immuables ; la capacité est le nombre de sièges. Aucun siège n’est vendu ici.
      </p>
      {feedback}
      {canManage ? (
        <CreateSeatMapForm
          run={run}
          busy={busy}
          onCreated={(id) => {
            void load().then(() => setSelectedId(id));
          }}
        />
      ) : null}
      <section aria-labelledby="seat-maps-title">
        <h2 id="seat-maps-title">Plans</h2>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Plans de sièges</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Nom</th>
                <th scope="col">Version publiée</th>
                <th scope="col">État</th>
                <th scope="col">Fiche</th>
              </tr>
            </thead>
            <tbody>
              {maps.map((map) => {
                const published = map.versions.find((version) => version.status === 'PUBLISHED');
                return (
                  <tr key={map.id}>
                    <th scope="row">
                      <span className="et-tag">{map.code}</span>
                    </th>
                    <td>{map.name}</td>
                    <td>
                      {published
                        ? `v${published.version} — ${seatsLabel(published.seatCount)}`
                        : '—'}
                    </td>
                    <td>{map.active ? 'Actif' : 'Désactivé'}</td>
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
          </table>
        </div>
        {maps.length === 0 ? <p>Aucun plan de sièges.</p> : null}
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
    </div>
  );
}
