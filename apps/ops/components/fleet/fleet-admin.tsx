'use client';

import type {
  AdminVehicle,
  AdminVehicleDetail,
  NetworkCountry,
  VehicleStatus,
  VehicleStatusTransitionInput,
} from '@euroteranga/auth-client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { assignedLabel } from '../seat-maps/seat-map-format';
import { SeatMapAssignmentForm } from '../seat-maps/seat-map-assignment-form';
import {
  usePublishedSeatMapVersions,
  type PublishedVersionOption,
} from '../seat-maps/use-published-versions';
import { useCan } from '../staff-access';
import {
  EMPTY_VEHICLE,
  toVehicleInput,
  VehicleFields,
  type VehicleFormValues,
} from './vehicle-fields';

type Run = ReturnType<typeof useAdminFeedback>['run'];

export const STATUS_LABELS: Record<VehicleStatus, string> = {
  PLANNED: 'Planifié',
  ACTIVE: 'En service',
  OUT_OF_SERVICE: 'Hors service',
  RETIRED: 'Retiré',
};

/** Display copy of the lifecycle; the API and PostgreSQL enforce it. */
const NEXT_STATUSES: Record<VehicleStatus, Array<VehicleStatusTransitionInput['status']>> = {
  PLANNED: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['OUT_OF_SERVICE', 'RETIRED'],
  OUT_OF_SERVICE: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

function registrationOf(vehicle: AdminVehicle): string {
  if (!vehicle.registrationPlate) return '—';
  return vehicle.registrationCountry
    ? `${vehicle.registrationPlate} (${vehicle.registrationCountry.iso2})`
    : vehicle.registrationPlate;
}

function CreateVehicleForm({
  countries,
  run,
  busy,
  onCreated,
}: {
  countries: readonly NetworkCountry[] | null;
  run: Run;
  busy: boolean;
  onCreated: (vehicleId: string) => void;
}) {
  const [values, setValues] = useState<VehicleFormValues>(EMPTY_VEHICLE);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let createdId: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.fleet.createVehicle(toVehicleInput(values));
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Véhicule ${values.code.trim().toUpperCase()} enregistré (planifié).`);
    if (ok && createdId) {
      setValues(EMPTY_VEHICLE);
      onCreated(createdId);
    }
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label="Enregistrer un véhicule"
      onSubmit={submit}
    >
      <h2>Enregistrer un véhicule</h2>
      <VehicleFields
        values={values}
        onChange={setValues}
        countries={countries}
        context="du nouveau véhicule"
      />
      <button className="et-button" type="submit" disabled={busy}>
        Enregistrer le véhicule
      </button>
    </form>
  );
}

function EditVehicleForm({
  vehicle,
  countries,
  run,
  busy,
  onSaved,
}: {
  vehicle: AdminVehicleDetail;
  countries: readonly NetworkCountry[] | null;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<VehicleFormValues>(EMPTY_VEHICLE);
  useEffect(() => {
    setValues({
      code: vehicle.code,
      manufacturer: vehicle.manufacturer,
      model: vehicle.model,
      modelYear: vehicle.modelYear === null ? '' : String(vehicle.modelYear),
      vin: vehicle.vin ?? '',
      registrationPlate: vehicle.registrationPlate ?? '',
      registrationCountryId: vehicle.registrationCountryId ?? '',
    });
  }, [vehicle]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const ok = await run(
      () => auth.admin.fleet.updateVehicle(vehicle.id, toVehicleInput(values)),
      `Véhicule ${vehicle.code} modifié.`,
    );
    if (ok) await onSaved();
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label={`Modifier le véhicule ${vehicle.code}`}
      onSubmit={submit}
    >
      <h3>Données administratives</h3>
      <VehicleFields
        values={values}
        onChange={setValues}
        countries={countries}
        context="du véhicule"
      />
      <button className="et-button" type="submit" disabled={busy}>
        Enregistrer les modifications
      </button>
    </form>
  );
}

function StatusForm({
  vehicle,
  run,
  busy,
  onChanged,
}: {
  vehicle: AdminVehicleDetail;
  run: Run;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const selectId = useId();
  const reasonId = useId();
  const options = NEXT_STATUSES[vehicle.status];
  const [target, setTarget] = useState<VehicleStatusTransitionInput['status'] | ''>('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setTarget('');
    setReason('');
  }, [vehicle.status]);

  if (options.length === 0) {
    return <p>Ce véhicule est retiré : son statut est définitif.</p>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !target) return;
    const ok = await run(
      () =>
        auth.admin.fleet.changeVehicleStatus(vehicle.id, {
          status: target,
          reason,
          // Refused by the API if someone changed the status meanwhile.
          expectedStatus: vehicle.status,
        }),
      `Statut du véhicule ${vehicle.code} : ${STATUS_LABELS[target]}.`,
    );
    if (ok) await onChanged();
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label={`Changer le statut du véhicule ${vehicle.code}`}
      onSubmit={submit}
    >
      <h3>Changer le statut</h3>
      <div className="et-field">
        <label htmlFor={selectId}>Nouveau statut</label>
        <select
          id={selectId}
          className="et-select"
          required
          value={target}
          onChange={(event) =>
            setTarget(event.target.value as VehicleStatusTransitionInput['status'] | '')
          }
        >
          <option value="">Choisir</option>
          {options.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      <div className="et-field">
        <label htmlFor={reasonId}>Motif du changement</label>
        <textarea
          id={reasonId}
          className="et-input"
          required
          minLength={3}
          maxLength={500}
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {target === 'RETIRED' ? (
        <p className="et-hint">
          Le retrait est définitif : le véhicule ne pourra plus être modifié.
        </p>
      ) : null}
      <button className="et-button" type="submit" disabled={busy || !target}>
        Appliquer le changement de statut
      </button>
    </form>
  );
}

function VehicleDetail({
  vehicle,
  countries,
  canManage,
  canAssignSeatMap,
  seatMapOptions,
  run,
  busy,
  onReload,
}: {
  vehicle: AdminVehicleDetail;
  countries: readonly NetworkCountry[] | null;
  canManage: boolean;
  /** fleet.manage + seatmap.read. */
  canAssignSeatMap: boolean;
  seatMapOptions: readonly PublishedVersionOption[];
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  return (
    <section aria-labelledby="vehicle-detail-title" className="et-network-panel">
      <h2 id="vehicle-detail-title">Véhicule {vehicle.code}</h2>
      <dl data-testid="vehicle-detail">
        <dt>Statut</dt>
        <dd data-testid="vehicle-status">{STATUS_LABELS[vehicle.status]}</dd>
        <dt>Constructeur et modèle</dt>
        <dd>
          {vehicle.manufacturer} {vehicle.model}
          {vehicle.modelYear ? ` (${vehicle.modelYear})` : ''}
        </dd>
        <dt>VIN</dt>
        <dd>{vehicle.vin ?? '—'}</dd>
        <dt>Immatriculation</dt>
        <dd>{registrationOf(vehicle)}</dd>
        <dt>Plan de sièges actuel</dt>
        <dd data-testid="vehicle-seat-map">{assignedLabel(vehicle.seatMapVersion)}</dd>
        {vehicle.retiredAt ? (
          <>
            <dt>Retiré le</dt>
            <dd>{dateFormat.format(new Date(vehicle.retiredAt))}</dd>
          </>
        ) : null}
      </dl>

      <h3>Historique des statuts</h3>
      {vehicle.statusHistory.length ? (
        <ol aria-label={`Historique des statuts du véhicule ${vehicle.code}`}>
          {vehicle.statusHistory.map((entry) => (
            <li key={`${entry.occurredAt}-${entry.to ?? ''}`}>
              <time dateTime={entry.occurredAt}>
                {dateFormat.format(new Date(entry.occurredAt))}
              </time>{' '}
              : {entry.from ? STATUS_LABELS[entry.from] : '?'} →{' '}
              {entry.to ? STATUS_LABELS[entry.to] : '?'}
              {entry.reason ? ` — ${entry.reason}` : ''}
            </li>
          ))}
        </ol>
      ) : (
        <p>Aucun changement de statut depuis l’enregistrement.</p>
      )}

      {canAssignSeatMap && vehicle.status !== 'RETIRED' ? (
        <SeatMapAssignmentForm
          formLabel={`Plan de sièges du véhicule ${vehicle.code}`}
          selectLabel="Plan de sièges à configurer"
          submitLabel="Enregistrer le plan de sièges"
          currentId={vehicle.seatMapVersionId}
          currentLabel={assignedLabel(vehicle.seatMapVersion)}
          options={seatMapOptions}
          run={run}
          busy={busy}
          success={(label) => `Plan de sièges du véhicule ${vehicle.code} : ${label}.`}
          assign={(seatMapVersionId, expected) =>
            auth.admin.fleet.assignVehicleSeatMap(vehicle.id, {
              seatMapVersionId,
              expectedSeatMapVersionId: expected,
            })
          }
          onSaved={onReload}
        />
      ) : null}
      {canManage && vehicle.status !== 'RETIRED' ? (
        <>
          <StatusForm vehicle={vehicle} run={run} busy={busy} onChanged={onReload} />
          <EditVehicleForm
            vehicle={vehicle}
            countries={countries}
            run={run}
            busy={busy}
            onSaved={onReload}
          />
        </>
      ) : null}
      {canManage && vehicle.status === 'RETIRED' ? (
        <p>Ce véhicule est retiré : son statut est définitif.</p>
      ) : null}
    </section>
  );
}

/** Vehicle registry (fleet.read) and administration (fleet.manage). */
export function FleetAdmin() {
  const canManage = useCan('fleet.manage');
  const canReadNetwork = useCan('network.read');
  const canAssignSeatMap = useCan('fleet.manage', 'seatmap.read');
  const seatMapOptions = usePublishedSeatMapVersions(canAssignSeatMap);
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [vehicles, setVehicles] = useState<AdminVehicle[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [countries, setCountries] = useState<NetworkCountry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminVehicleDetail | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.fleet.vehicles(cursor ? { cursor } : {});
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setVehicles((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [setError],
  );

  const loadDetail = useCallback(
    async (vehicleId: string) => {
      const result = await auth.admin.fleet.vehicle(vehicleId);
      if (result.ok) setDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Registration countries come from the network catalogue (network.read).
  useEffect(() => {
    if (!canManage || !canReadNetwork) return;
    void auth.admin.network.countries({ limit: 100 }).then((result) => {
      if (result.ok) setCountries(result.data.items.filter((country) => country.active));
    });
  }, [canManage, canReadNetwork]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  if (!vehicles) return <p role="status">Chargement de la flotte…</p>;

  return (
    <div className="et-network" data-testid="fleet-workspace">
      <p>
        Registre des véhicules exploités. Un véhicule est enregistré comme planifié ; son statut
        change uniquement par une transition motivée, et le retrait est définitif.
      </p>
      {feedback}
      {canManage ? (
        <CreateVehicleForm
          countries={countries}
          run={run}
          busy={busy}
          onCreated={(vehicleId) => {
            void load().then(() => setSelectedId(vehicleId));
          }}
        />
      ) : null}

      <section aria-labelledby="vehicles-title">
        <h2 id="vehicles-title">Véhicules</h2>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Véhicules de la flotte</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Constructeur et modèle</th>
                <th scope="col">Immatriculation</th>
                <th scope="col">Statut</th>
                <th scope="col">Fiche</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((vehicle) => (
                <tr key={vehicle.id}>
                  <th scope="row">
                    <span className="et-tag">{vehicle.code}</span>
                  </th>
                  <td>
                    {vehicle.manufacturer} {vehicle.model}
                  </td>
                  <td>{registrationOf(vehicle)}</td>
                  <td>{STATUS_LABELS[vehicle.status]}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Consulter le véhicule ${vehicle.code}`}
                      onClick={() => setSelectedId(vehicle.id)}
                    >
                      Consulter
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {vehicles.length === 0 ? <p>Aucun véhicule enregistré.</p> : null}
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

      {selectedId && !detail ? <p role="status">Chargement du véhicule…</p> : null}
      {detail ? (
        <VehicleDetail
          vehicle={detail}
          countries={countries}
          canManage={canManage}
          canAssignSeatMap={canAssignSeatMap}
          seatMapOptions={seatMapOptions}
          run={run}
          busy={busy}
          onReload={reload}
        />
      ) : null}
    </div>
  );
}
