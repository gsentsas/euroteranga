'use client';

import type { AdminFareTable, AdminFareTableSummary, NetworkRoute } from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { useCan } from '../staff-access';
import { FareDraftEditor, FareEntriesTable } from './fare-editor';
import { FARE_VERSION_STATUS_LABELS, faresLabel } from './pricing-format';

type Run = ReturnType<typeof useAdminFeedback>['run'];

function CreateFareTableForm({
  routes,
  run,
  busy,
  onCreated,
}: {
  routes: readonly NetworkRoute[];
  run: Run;
  busy: boolean;
  onCreated: (id: string) => void;
}) {
  const routeId = useId();
  const unitId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [route, setRoute] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [minorUnit, setMinorUnit] = useState('2');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let createdId: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.pricing.createFareTable({
        code,
        name,
        routeId: route,
        currencyCode,
        currencyMinorUnit: Number(minorUnit),
        active: true,
      });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Grille tarifaire ${code.trim().toUpperCase()} créée.`);
    if (ok && createdId) {
      setCode('');
      setName('');
      setCurrencyCode('');
      onCreated(createdId);
    }
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label="Créer une grille tarifaire"
      onSubmit={submit}
    >
      <h2>Créer une grille tarifaire</h2>
      <TextField
        label="Code de la grille"
        name="code"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
        hint="Identifiant stable, par exemple ROUTE_TEST_EUR."
      />
      <TextField
        label="Nom de la grille"
        name="name"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <div className="et-field">
        <label htmlFor={routeId}>Route tarifée</label>
        <select
          id={routeId}
          className="et-select"
          required
          value={route}
          onChange={(event) => setRoute(event.target.value)}
        >
          <option value="">Choisir une route</option>
          {routes.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.code} — {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Code devise"
        name="currencyCode"
        value={currencyCode}
        onChange={setCurrencyCode}
        autoComplete="off"
        maxLength={3}
        hint="Trois lettres, par exemple EUR ou XOF. Immuable : changer de devise impose une nouvelle grille."
      />
      <div className="et-field">
        <label htmlFor={unitId}>Décimales de la devise</label>
        <select
          id={unitId}
          className="et-select"
          value={minorUnit}
          onChange={(event) => setMinorUnit(event.target.value)}
        >
          {['0', '1', '2', '3'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <p className="et-hint">2 pour EUR (centimes), 0 pour XOF. Immuable.</p>
      </div>
      <button className="et-button" type="submit" disabled={busy}>
        Créer la grille
      </button>
    </form>
  );
}

function CreateDraftForm({
  fareTable,
  run,
  busy,
  onCreated,
}: {
  fareTable: AdminFareTable;
  run: Run;
  busy: boolean;
  onCreated: () => Promise<void>;
}) {
  const selectId = useId();
  const published = fareTable.route.versions;
  const [routeVersionId, setRouteVersionId] = useState('');
  useEffect(() => {
    const current = published.find((version) => version.status === 'PUBLISHED') ?? published[0];
    setRouteVersionId(current?.id ?? '');
  }, [published]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !routeVersionId) return;
    const ok = await run(
      () => auth.admin.pricing.createVersion(fareTable.id, routeVersionId),
      `Nouvelle version brouillon de la grille ${fareTable.code} créée.`,
    );
    if (ok) await onCreated();
  };
  if (published.length === 0) {
    return <p>Aucune version publiée de la route : rien à tarifer pour l’instant.</p>;
  }
  return (
    <form
      className="et-form et-network-form"
      aria-label="Créer une version brouillon"
      onSubmit={submit}
    >
      <div className="et-field">
        <label htmlFor={selectId}>Version de route tarifée</label>
        <select
          id={selectId}
          className="et-select"
          value={routeVersionId}
          onChange={(event) => setRouteVersionId(event.target.value)}
        >
          {published.map((version) => (
            <option key={version.id} value={version.id}>
              {`Version ${version.version}${version.status === 'RETIRED' ? ' (retirée)' : ''}`}
            </option>
          ))}
        </select>
      </div>
      <button className="et-button" type="submit" disabled={busy}>
        Créer une version brouillon
      </button>
    </form>
  );
}

function FareTableDetail({
  fareTable,
  canManage,
  run,
  busy,
  onReload,
}: {
  fareTable: AdminFareTable;
  canManage: boolean;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const draft = fareTable.versions.find((version) => version.status === 'DRAFT');
  const history = fareTable.versions.filter((version) => version.status !== 'DRAFT');
  const toggle = async () => {
    const ok = await run(
      () => auth.admin.pricing.updateFareTable(fareTable.id, { active: !fareTable.active }),
      `Grille ${fareTable.code} ${fareTable.active ? 'désactivée' : 'activée'}.`,
    );
    if (ok) await onReload();
  };
  return (
    <section aria-labelledby="fare-table-detail-title" className="et-network-panel">
      <h2 id="fare-table-detail-title">
        Grille {fareTable.code} — {fareTable.name}
      </h2>
      <dl data-testid="fare-table-detail">
        <dt>Route</dt>
        <dd>
          {fareTable.route.code} — {fareTable.route.name}
        </dd>
        <dt>Devise</dt>
        <dd>
          {fareTable.currencyCode} ({fareTable.currencyMinorUnit} décimale
          {fareTable.currencyMinorUnit > 1 ? 's' : ''})
        </dd>
        <dt>État</dt>
        <dd>
          {fareTable.active
            ? 'Active'
            : 'Désactivée (les voyages déjà tarifés conservent leur version)'}
        </dd>
      </dl>
      {canManage ? (
        <div className="et-actions">
          <button
            type="button"
            className="et-button et-button--secondary"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {fareTable.active
              ? `Désactiver la grille ${fareTable.code}`
              : `Activer la grille ${fareTable.code}`}
          </button>
        </div>
      ) : null}
      {canManage && !draft ? (
        <CreateDraftForm fareTable={fareTable} run={run} busy={busy} onCreated={onReload} />
      ) : null}

      <h3>Versions</h3>
      <ol className="et-network-versions" aria-label={`Versions de la grille ${fareTable.code}`}>
        {fareTable.versions.map((version) => (
          <li key={version.id}>
            <strong>Version {version.version}</strong>{' '}
            <span className="et-tag">{FARE_VERSION_STATUS_LABELS[version.status]}</span> — route
            version {version.routeVersion.version}, {faresLabel(version.entryCount)}
            {version.status !== 'DRAFT' ? ` — ${version.tripCount} voyage(s)` : ''}
          </li>
        ))}
      </ol>
      {fareTable.versions.length === 0 ? <p>Aucune version.</p> : null}

      {draft && canManage ? (
        <FareDraftEditor
          fareTable={fareTable}
          draft={draft}
          run={run}
          busy={busy}
          onSaved={onReload}
        />
      ) : null}
      {draft && !canManage ? (
        <FareEntriesTable
          fareTable={fareTable}
          version={draft}
          caption={`Tarifs du brouillon version ${draft.version}`}
        />
      ) : null}

      {history.map((version) => (
        <details key={version.id}>
          <summary>
            Tarifs de la version {version.version} ({FARE_VERSION_STATUS_LABELS[version.status]},
            lecture seule)
          </summary>
          <FareEntriesTable
            fareTable={fareTable}
            version={version}
            caption={`Tarifs de la version ${version.version}`}
          />
        </details>
      ))}
    </section>
  );
}

/** Fare-table catalogue (pricing.read) and edition (pricing.manage). */
export function PricingAdmin() {
  const canManage = useCan('pricing.manage');
  const canReadRoutes = useCan('network.read');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [tables, setTables] = useState<AdminFareTableSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [routes, setRoutes] = useState<NetworkRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminFareTable | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.pricing.fareTables(cursor ? { cursor } : {});
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTables((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [setError],
  );
  const loadDetail = useCallback(
    async (id: string) => {
      const result = await auth.admin.pricing.fareTable(id);
      if (result.ok) setDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!canManage || !canReadRoutes) return;
    void auth.admin.network.routes({ limit: 100 }).then((result) => {
      if (result.ok) setRoutes(result.data.items.filter((route) => route.active));
    });
  }, [canManage, canReadRoutes]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  if (!tables) return <p role="status">Chargement des grilles tarifaires…</p>;

  return (
    <div className="et-network" data-testid="pricing-workspace">
      <p>
        Une grille tarifaire fixe le tarif de base d’un trajet entre deux arrêts d’une version de
        route, en unités mineures exactes d’une devise. Ses versions publiées sont historiques et
        immuables. Aucune réservation, réduction ni paiement n’est géré ici.
      </p>
      {feedback}
      {canManage ? (
        <CreateFareTableForm
          routes={routes}
          run={run}
          busy={busy}
          onCreated={(id) => {
            void load().then(() => setSelectedId(id));
          }}
        />
      ) : null}
      <section aria-labelledby="fare-tables-title">
        <h2 id="fare-tables-title">Grilles</h2>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Grilles tarifaires</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Route</th>
                <th scope="col">Devise</th>
                <th scope="col">Version publiée</th>
                <th scope="col">État</th>
                <th scope="col">Fiche</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((table) => {
                const published = table.versions.find((version) => version.status === 'PUBLISHED');
                return (
                  <tr key={table.id}>
                    <th scope="row">
                      <span className="et-tag">{table.code}</span> {table.name}
                    </th>
                    <td>{table.route.code}</td>
                    <td>{table.currencyCode}</td>
                    <td>
                      {published
                        ? `v${published.version} — ${faresLabel(published.entryCount)}`
                        : '—'}
                    </td>
                    <td>{table.active ? 'Active' : 'Désactivée'}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter la grille ${table.code}`}
                        onClick={() => setSelectedId(table.id)}
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
        {tables.length === 0 ? <p>Aucune grille tarifaire.</p> : null}
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
      {selectedId && !detail ? <p role="status">Chargement de la grille…</p> : null}
      {detail ? (
        <FareTableDetail
          fareTable={detail}
          canManage={canManage}
          run={run}
          busy={busy}
          onReload={reload}
        />
      ) : null}
    </div>
  );
}
