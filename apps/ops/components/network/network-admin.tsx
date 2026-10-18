'use client';

import type {
  NetworkCheckpoint,
  NetworkCheckpointType,
  NetworkCountry,
  NetworkRoute,
  NetworkRouteDetail,
  NetworkStop,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { OpsDetailRegion } from '../ops-detail-region';
import { useCan } from '../staff-access';
import { RouteEditor } from './route-editor';

interface NetworkData {
  countries: NetworkCountry[];
  stops: NetworkStop[];
  checkpoints: NetworkCheckpoint[];
  routes: NetworkRoute[];
}

type Run = ReturnType<typeof useAdminFeedback>['run'];

const CHECKPOINT_LABELS: Record<NetworkCheckpointType, string> = {
  BORDER: 'Frontière',
  FERRY_TERMINAL: 'Terminal ferry',
  PORT: 'Port',
  TECHNICAL: 'Technique',
};

function NumberField({
  label,
  name,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="et-input"
        name={name}
        type="number"
        min={min}
        max={max}
        step="any"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function CountrySelect({
  label,
  countries,
  value,
  onChange,
}: {
  label: string;
  countries: readonly NetworkCountry[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="et-select"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choisir un pays</option>
        {countries
          .filter((country) => country.active)
          .map((country) => (
            <option key={country.id} value={country.id}>
              {country.iso2} — {country.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function CountryForm({ run, busy, onDone }: { run: Run; busy: boolean; onDone: () => void }) {
  const [iso2, setIso2] = useState('');
  const [iso3, setIso3] = useState('');
  const [name, setName] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const ok = await run(
      () => auth.admin.network.createCountry({ iso2, iso3, name, active: true }),
      `Pays ${name} créé.`,
    );
    if (ok) {
      setIso2('');
      setIso3('');
      setName('');
      onDone();
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Créer un pays" onSubmit={submit}>
      <h3>Créer un pays</h3>
      <TextField
        label="Code ISO2"
        name="iso2"
        value={iso2}
        onChange={setIso2}
        autoComplete="off"
        maxLength={2}
        pattern="[A-Za-z]{2}"
      />
      <TextField
        label="Code ISO3"
        name="iso3"
        value={iso3}
        onChange={setIso3}
        autoComplete="off"
        maxLength={3}
        pattern="[A-Za-z]{3}"
      />
      <TextField
        label="Nom du pays"
        name="countryName"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <button className="et-button" type="submit" disabled={busy}>
        Créer le pays
      </button>
    </form>
  );
}

function StopForm({
  countries,
  run,
  busy,
  onDone,
}: {
  countries: readonly NetworkCountry[];
  run: Run;
  busy: boolean;
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [countryId, setCountryId] = useState('');
  const [locality, setLocality] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [timezone, setTimezone] = useState('Etc/UTC');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const ok = await run(
      () =>
        auth.admin.network.createStop({
          code,
          name,
          countryId,
          locality,
          latitude: Number(latitude),
          longitude: Number(longitude),
          timezone,
          active: true,
        }),
      `Arrêt ${name} créé.`,
    );
    if (ok) {
      setCode('');
      setName('');
      setLocality('');
      setLatitude('');
      setLongitude('');
      onDone();
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Créer un arrêt" onSubmit={submit}>
      <h3>Créer un arrêt</h3>
      <TextField
        label="Code de l’arrêt"
        name="stopCode"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
      />
      <TextField
        label="Nom de l’arrêt"
        name="stopName"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <CountrySelect
        label="Pays de l’arrêt"
        countries={countries}
        value={countryId}
        onChange={setCountryId}
      />
      <TextField
        label="Localité de l’arrêt"
        name="stopLocality"
        value={locality}
        onChange={setLocality}
        autoComplete="off"
        maxLength={128}
      />
      <NumberField
        label="Latitude de l’arrêt"
        name="stopLatitude"
        value={latitude}
        min={-90}
        max={90}
        onChange={setLatitude}
      />
      <NumberField
        label="Longitude de l’arrêt"
        name="stopLongitude"
        value={longitude}
        min={-180}
        max={180}
        onChange={setLongitude}
      />
      <TextField
        label="Fuseau horaire de l’arrêt"
        name="stopTimezone"
        value={timezone}
        onChange={setTimezone}
        autoComplete="off"
        maxLength={64}
      />
      <button className="et-button" type="submit" disabled={busy}>
        Créer l’arrêt
      </button>
    </form>
  );
}

function CheckpointForm({
  countries,
  run,
  busy,
  onDone,
}: {
  countries: readonly NetworkCountry[];
  run: Run;
  busy: boolean;
  onDone: () => void;
}) {
  const typeId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [countryId, setCountryId] = useState('');
  const [type, setType] = useState<NetworkCheckpointType>('TECHNICAL');
  const [locality, setLocality] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [timezone, setTimezone] = useState('Etc/UTC');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const ok = await run(
      () =>
        auth.admin.network.createCheckpoint({
          code,
          name,
          countryId,
          type,
          locality,
          latitude: Number(latitude),
          longitude: Number(longitude),
          timezone,
          active: true,
        }),
      `Checkpoint ${name} créé.`,
    );
    if (ok) {
      setCode('');
      setName('');
      setLocality('');
      setLatitude('');
      setLongitude('');
      onDone();
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Créer un checkpoint" onSubmit={submit}>
      <h3>Créer un checkpoint</h3>
      <TextField
        label="Code du checkpoint"
        name="checkpointCode"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
      />
      <TextField
        label="Nom du checkpoint"
        name="checkpointName"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <CountrySelect
        label="Pays du checkpoint"
        countries={countries}
        value={countryId}
        onChange={setCountryId}
      />
      <div className="et-field">
        <label htmlFor={typeId}>Type de checkpoint</label>
        <select
          id={typeId}
          className="et-select"
          value={type}
          onChange={(event) => setType(event.target.value as NetworkCheckpointType)}
        >
          {Object.entries(CHECKPOINT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Localité du checkpoint"
        name="checkpointLocality"
        value={locality}
        onChange={setLocality}
        autoComplete="off"
        maxLength={128}
      />
      <NumberField
        label="Latitude du checkpoint"
        name="checkpointLatitude"
        value={latitude}
        min={-90}
        max={90}
        onChange={setLatitude}
      />
      <NumberField
        label="Longitude du checkpoint"
        name="checkpointLongitude"
        value={longitude}
        min={-180}
        max={180}
        onChange={setLongitude}
      />
      <TextField
        label="Fuseau horaire du checkpoint"
        name="checkpointTimezone"
        value={timezone}
        onChange={setTimezone}
        autoComplete="off"
        maxLength={64}
      />
      <button className="et-button" type="submit" disabled={busy}>
        Créer le checkpoint
      </button>
    </form>
  );
}

function RouteForm({
  run,
  busy,
  onCreated,
}: {
  run: Run;
  busy: boolean;
  onCreated: (routeId: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let createdId: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.network.createRoute({ code, name, active: true });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Route ${name} créée.`);
    if (ok && createdId) {
      setCode('');
      setName('');
      onCreated(createdId);
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Créer une route" onSubmit={submit}>
      <h3>Créer une route</h3>
      <TextField
        label="Code de la route"
        name="routeCode"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
      />
      <TextField
        label="Nom de la route"
        name="routeName"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <button className="et-button" type="submit" disabled={busy}>
        Créer la route
      </button>
    </form>
  );
}

function ActiveState({ active }: { active: boolean }) {
  return <span className="et-tag">{active ? 'Actif' : 'Inactif'}</span>;
}

export function NetworkAdmin() {
  const canManage = useCan('network.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [data, setData] = useState<NetworkData | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [routeDetail, setRouteDetail] = useState<NetworkRouteDetail | null>(null);

  const load = useCallback(async () => {
    const [countries, stops, checkpoints, routes] = await Promise.all([
      auth.admin.network.countries({ limit: 100 }),
      auth.admin.network.stops({ limit: 100 }),
      auth.admin.network.checkpoints({ limit: 100 }),
      auth.admin.network.routes({ limit: 100 }),
    ]);
    const failed = [countries, stops, checkpoints, routes].find((result) => !result.ok);
    if (failed && !failed.ok) {
      setError(failed.error.message);
      return;
    }
    if (countries.ok && stops.ok && checkpoints.ok && routes.ok) {
      setData({
        countries: countries.data.items,
        stops: stops.data.items,
        checkpoints: checkpoints.data.items,
        routes: routes.data.items,
      });
    }
  }, [setError]);

  const loadRoute = useCallback(
    async (routeId: string) => {
      const result = await auth.admin.network.route(routeId);
      if (result.ok) setRouteDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedRouteId) void loadRoute(selectedRouteId);
    else setRouteDetail(null);
  }, [loadRoute, selectedRouteId]);

  const reload = () => void load();
  const activate = async (
    kind: 'country' | 'stop' | 'checkpoint' | 'route',
    id: string,
    active: boolean,
    label: string,
  ) => {
    const success = `${label} ${active ? 'activé' : 'désactivé'}.`;
    const ok =
      kind === 'country'
        ? await run(() => auth.admin.network.updateCountry(id, { active }), success)
        : kind === 'stop'
          ? await run(() => auth.admin.network.updateStop(id, { active }), success)
          : kind === 'checkpoint'
            ? await run(() => auth.admin.network.updateCheckpoint(id, { active }), success)
            : await run(() => auth.admin.network.updateRoute(id, { active }), success);
    if (ok) await load();
  };

  if (!data) return <p role="status">Chargement du réseau…</p>;

  return (
    <div className="et-network" data-testid="network-workspace">
      <p>
        Les routes sont des données versionnées. Une version publiée reste consultable et ne peut
        plus être modifiée.
      </p>
      {feedback}

      <section aria-labelledby="countries-title">
        <h2 id="countries-title">Pays</h2>
        {canManage ? <CountryForm run={run} busy={busy} onDone={reload} /> : null}
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Pays du réseau</caption>
            <thead>
              <tr>
                <th scope="col">ISO</th>
                <th scope="col">Nom</th>
                <th scope="col">État</th>
                {canManage ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.countries.map((country) => (
                <tr key={country.id}>
                  <td>
                    {country.iso2} / {country.iso3}
                  </td>
                  <th scope="row">{country.name}</th>
                  <td>
                    <ActiveState active={country.active} />
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        disabled={busy}
                        aria-label={`${country.active ? 'Désactiver' : 'Activer'} le pays ${country.name}`}
                        onClick={() =>
                          void activate(
                            'country',
                            country.id,
                            !country.active,
                            `Pays ${country.name}`,
                          )
                        }
                      >
                        {country.active ? 'Désactiver' : 'Activer'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="stops-title">
        <h2 id="stops-title">Arrêts</h2>
        {canManage ? (
          <StopForm countries={data.countries} run={run} busy={busy} onDone={reload} />
        ) : null}
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Arrêts du réseau</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Nom</th>
                <th scope="col">Localité</th>
                <th scope="col">État</th>
                {canManage ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.stops.map((stop) => (
                <tr key={stop.id}>
                  <th scope="row">
                    <span className="et-tag">{stop.code}</span>
                  </th>
                  <td>{stop.name}</td>
                  <td>{stop.locality}</td>
                  <td>
                    <ActiveState active={stop.active} />
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        disabled={busy}
                        aria-label={`${stop.active ? 'Désactiver' : 'Activer'} l’arrêt ${stop.name}`}
                        onClick={() =>
                          void activate('stop', stop.id, !stop.active, `Arrêt ${stop.name}`)
                        }
                      >
                        {stop.active ? 'Désactiver' : 'Activer'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="checkpoints-title">
        <h2 id="checkpoints-title">Checkpoints</h2>
        {canManage ? (
          <CheckpointForm countries={data.countries} run={run} busy={busy} onDone={reload} />
        ) : null}
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Checkpoints du réseau</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Nom</th>
                <th scope="col">Type</th>
                <th scope="col">État</th>
                {canManage ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.checkpoints.map((checkpoint) => (
                <tr key={checkpoint.id}>
                  <th scope="row">
                    <span className="et-tag">{checkpoint.code}</span>
                  </th>
                  <td>{checkpoint.name}</td>
                  <td>{CHECKPOINT_LABELS[checkpoint.type]}</td>
                  <td>
                    <ActiveState active={checkpoint.active} />
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        disabled={busy}
                        aria-label={`${checkpoint.active ? 'Désactiver' : 'Activer'} le checkpoint ${checkpoint.name}`}
                        onClick={() =>
                          void activate(
                            'checkpoint',
                            checkpoint.id,
                            !checkpoint.active,
                            `Checkpoint ${checkpoint.name}`,
                          )
                        }
                      >
                        {checkpoint.active ? 'Désactiver' : 'Activer'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="routes-title">
        <h2 id="routes-title">Routes</h2>
        {canManage ? (
          <RouteForm
            run={run}
            busy={busy}
            onCreated={(routeId) => {
              void load().then(() => setSelectedRouteId(routeId));
            }}
          />
        ) : null}
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Routes commerciales</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Nom</th>
                <th scope="col">État</th>
                <th scope="col">Consultation</th>
                {canManage ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.routes.map((route) => (
                <tr
                  key={route.id}
                  className={
                    selectedRouteId === route.id ? 'ops-table-row--selected' : undefined
                  }
                >
                  <th scope="row">
                    <span className="et-tag">{route.code}</span>
                  </th>
                  <td>{route.name}</td>
                  <td>
                    <ActiveState active={route.active} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Consulter la route ${route.code}`}
                      aria-controls="route-detail-panel"
                      aria-expanded={selectedRouteId === route.id && Boolean(routeDetail)}
                      onClick={() => setSelectedRouteId(route.id)}
                    >
                      Consulter
                    </button>
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        disabled={busy}
                        aria-label={`${route.active ? 'Désactiver' : 'Activer'} la route ${route.name}`}
                        onClick={() =>
                          void activate('route', route.id, !route.active, `Route ${route.name}`)
                        }
                      >
                        {route.active ? 'Désactiver' : 'Activer'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selectedRouteId && !routeDetail ? <p role="status">Chargement de la route…</p> : null}
        {routeDetail ? (
          <OpsDetailRegion
            id="route-detail-panel"
            focusKey={selectedRouteId}
            onClose={() => setSelectedRouteId(null)}
          >
            <RouteEditor
              route={routeDetail}
              stops={data.stops}
              checkpoints={data.checkpoints}
              canManage={canManage}
              busy={busy}
              run={run}
              onReload={async () => {
                await loadRoute(routeDetail.id);
                await load();
              }}
            />
          </OpsDetailRegion>
        ) : null}
      </section>
    </div>
  );
}
