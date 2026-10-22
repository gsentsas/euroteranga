'use client';

import type {
  DepartureBlockerCode,
  DepartureGate,
  DeparturePermitRequirementInput,
  DepartureReadinessResponse,
  RegulatoryPermitScopeType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

const GATE_LABELS: Record<DepartureGate, string> = {
  TRIP: 'Voyage',
  VEHICLE: 'Véhicule',
  PASSENGERS: 'Passagers',
  MANIFEST: 'Manifeste',
  PERMITS: 'Permis opérationnels',
};

const BLOCKER_LABELS: Record<DepartureBlockerCode, string> = {
  TRIP_NOT_SCHEDULED: 'Le voyage n’est pas planifié pour un départ.',
  VEHICLE_NOT_ASSIGNED: 'Aucun véhicule n’est affecté.',
  VEHICLE_NOT_ACTIVE: 'Le véhicule affecté n’est plus en service.',
  VEHICLE_SEAT_MAP_MISMATCH: 'Le plan de sièges actuel du véhicule ne correspond plus au voyage.',
  SUPPORT_VEHICLE_NOT_ACTIVE: 'Le véhicule d’appoint n’est plus en service.',
  SUPPORT_VEHICLE_ROLE_INVALID: 'Le véhicule d’appoint n’est plus configuré comme CARGO_SUPPORT.',
  SUPPORT_VEHICLE_CAPACITY_MISSING:
    'La charge utile ou le volume du véhicule d’appoint n’est plus configuré.',
  PASSENGER_NOT_CHECKED_IN: 'Un passager confirmé n’est pas enregistré.',
  PASSENGER_NOT_BOARDED: 'Un passager confirmé n’est pas embarqué.',
  PASSENGER_READINESS_STALE: 'Les conditions PR-14 d’un passager ne sont plus valides.',
  MANIFEST_MISSING: 'Aucun manifeste passagers n’a été généré.',
  MANIFEST_STALE: 'Le dernier manifeste ne reflète plus la population courante.',
  PERMIT_POLICY_MISSING: 'Aucune politique explicite de permis n’a été publiée pour ce voyage.',
  PERMIT_POLICY_STALE: 'La politique de permis publiée ne correspond plus au voyage courant.',
  PERMIT_REQUIREMENT_UNSATISFIED: 'Une exigence explicite de permis n’est pas satisfaite.',
};

const SCOPE_LABELS: Record<RegulatoryPermitScopeType, string> = {
  OPERATOR: 'Opérateur',
  COUNTRY: 'Pays',
  VEHICLE: 'Véhicule du voyage',
  ROUTE_VERSION: 'Version de route du voyage',
  TRIP: 'Voyage',
};

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

function statusLabel(status: DepartureReadinessResponse['trip']['status']) {
  switch (status) {
    case 'DRAFT':
      return 'Brouillon';
    case 'SCHEDULED':
      return 'Planifié';
    case 'IN_PROGRESS':
      return 'En cours';
    case 'COMPLETED':
      return 'Terminé';
    case 'CANCELLED':
      return 'Annulé';
  }
}

function ReadinessPanel({ data }: { data: DepartureReadinessResponse }) {
  return (
    <section className="et-network-panel" aria-labelledby="departure-readiness-title">
      <div className="et-actions">
        <h2 id="departure-readiness-title">Readiness du départ</h2>
        <span className="et-tag">{data.readiness.status === 'READY' ? 'PRÊT' : 'BLOQUÉ'}</span>
        <span className="et-code">{data.readiness.engineVersion}</span>
      </div>
      <dl className="et-booking-admin-summary">
        <dt>Voyage</dt>
        <dd className="et-code">{data.trip.reference}</dd>
        <dt>État opérationnel</dt>
        <dd>{statusLabel(data.trip.status)}</dd>
        <dt>Départ réel</dt>
        <dd>{formatAt(data.trip.actualDepartureAt)}</dd>
        <dt>Arrivée réelle</dt>
        <dd>{formatAt(data.trip.actualArrivalAt)}</dd>
        <dt>Empreinte readiness</dt>
        <dd className="et-code">{data.fingerprint}</dd>
      </dl>

      <div className="et-table-wrap">
        <table data-testid="departure-gates">
          <caption>Gates calculées exclusivement par le serveur</caption>
          <thead>
            <tr>
              <th>Gate</th>
              <th>État</th>
              <th>Blocages</th>
            </tr>
          </thead>
          <tbody>
            {data.readiness.gates.map((gate) => (
              <tr key={gate.gate}>
                <td>{GATE_LABELS[gate.gate]}</td>
                <td>{gate.status === 'PASS' ? 'OK' : 'Bloqué'}</td>
                <td>{gate.blockers.map((code) => BLOCKER_LABELS[code]).join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.readiness.blockers.length ? (
        <div className="et-alert" role="status" data-testid="departure-blockers">
          <strong>Actions requises avant autorisation :</strong>
          <ul>
            {data.readiness.blockers.map((blocker, index) => (
              <li
                key={`${blocker.gate}-${blocker.code}-${blocker.reference ?? blocker.sequence ?? index}`}
              >
                {BLOCKER_LABELS[blocker.code]}
                {blocker.reference ? ` (${blocker.reference})` : ''}
                {blocker.sequence ? ` — exigence ${blocker.sequence}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="et-booking-admin-summary">
        <dt>Passagers confirmés</dt>
        <dd>{data.readiness.passengers.total}</dd>
        <dt>Check-in</dt>
        <dd>{data.readiness.passengers.checkedIn}</dd>
        <dt>Embarqués</dt>
        <dd>{data.readiness.passengers.boarded}</dd>
        <dt>Toujours conformes PR-14</dt>
        <dd>{data.readiness.passengers.currentReady}</dd>
        <dt>Manifeste courant</dt>
        <dd>
          {data.readiness.manifest
            ? `${data.readiness.manifest.reference} · v${data.readiness.manifest.version}`
            : 'Absent'}
        </dd>
        <dt>Politique permis</dt>
        <dd>
          {data.readiness.permitPolicy
            ? `v${data.readiness.permitPolicy.version} · ${data.readiness.permitPolicy.requirementCount} exigence(s)`
            : 'Non publiée'}
        </dd>
      </dl>

      {data.readiness.permitPolicy?.requirements.length ? (
        <div className="et-table-wrap">
          <table data-testid="departure-permit-requirements">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Périmètre</th>
                <th>Résultat</th>
                <th>Permis utilisé</th>
              </tr>
            </thead>
            <tbody>
              {data.readiness.permitPolicy.requirements.map((requirement) => (
                <tr key={requirement.sequence}>
                  <td>{requirement.sequence}</td>
                  <td className="et-code">{requirement.permitType}</td>
                  <td>
                    {SCOPE_LABELS[requirement.scopeType]}
                    {requirement.countryIso2 ? ` ${requirement.countryIso2}` : ''}
                  </td>
                  <td>{requirement.satisfied ? 'Satisfaite' : 'Manquante'}</td>
                  <td className="et-code">{requirement.permitReference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3>Autorisation de départ</h3>
      {data.latestAuthorization ? (
        <dl className="et-booking-admin-summary">
          <dt>Référence</dt>
          <dd className="et-code">{data.latestAuthorization.reference}</dd>
          <dt>Version</dt>
          <dd>{data.latestAuthorization.version}</dd>
          <dt>Créée le</dt>
          <dd>{formatAt(data.latestAuthorization.authorizedAt)}</dd>
          <dt>Correspond aux faits actuels</dt>
          <dd>
            {data.latestAuthorization.current ? 'Oui' : 'Non — nouvelle autorisation requise'}
          </dd>
        </dl>
      ) : (
        <p>Aucune autorisation de départ n’a encore été créée.</p>
      )}
    </section>
  );
}

function PolicyEditor({
  disabled,
  onPublish,
}: {
  disabled: boolean;
  onPublish: (requirements: DeparturePermitRequirementInput[]) => Promise<void>;
}) {
  const [requirements, setRequirements] = useState<DeparturePermitRequirementInput[]>([]);
  const update = (index: number, patch: Partial<DeparturePermitRequirementInput>) =>
    setRequirements((current) =>
      current.map((item, cursor) =>
        cursor === index ? ({ ...item, ...patch } as DeparturePermitRequirementInput) : item,
      ),
    );
  const add = () =>
    setRequirements((current) => [...current, { permitType: '', scopeType: 'TRIP' }]);
  return (
    <section className="et-network-panel" aria-labelledby="departure-policy-title">
      <h2 id="departure-policy-title">Politique explicite de permis</h2>
      <p>
        L’absence de politique bloque le départ. Publier cette liste vide signifie explicitement «
        aucun permis opérationnel requis » pour ce voyage. Aucune règle juridique n’est déduite par
        l’application.
      </p>
      {requirements.map((requirement, index) => (
        <div className="et-form et-network-form" key={index}>
          <label className="et-field">
            Type de permis
            <input
              className="et-input"
              required
              value={requirement.permitType}
              onChange={(event) => update(index, { permitType: event.target.value.toUpperCase() })}
              maxLength={64}
            />
          </label>
          <label className="et-field">
            Périmètre
            <select
              className="et-select"
              value={requirement.scopeType}
              onChange={(event) => {
                const scopeType = event.target.value as RegulatoryPermitScopeType;
                setRequirements((current) =>
                  current.map((item, cursor) => {
                    if (cursor !== index) return item;
                    if (scopeType === 'COUNTRY') {
                      return { ...item, scopeType, countryIso2: item.countryIso2 ?? '' };
                    }
                    const { countryIso2: _countryIso2, ...withoutCountry } = item;
                    return { ...withoutCountry, scopeType };
                  }),
                );
              }}
            >
              {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {requirement.scopeType === 'COUNTRY' ? (
            <label className="et-field">
              Code ISO2
              <input
                className="et-input"
                required
                maxLength={2}
                value={requirement.countryIso2 ?? ''}
                onChange={(event) =>
                  update(index, { countryIso2: event.target.value.toUpperCase() })
                }
              />
            </label>
          ) : null}
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() =>
              setRequirements((current) => current.filter((_, cursor) => cursor !== index))
            }
          >
            Retirer l’exigence
          </button>
        </div>
      ))}
      <div className="et-actions">
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={add}
          disabled={disabled}
        >
          Ajouter une exigence
        </button>
        <button
          type="button"
          className="et-button"
          disabled={
            disabled ||
            requirements.some(
              (item) =>
                !item.permitType.trim() ||
                (item.scopeType === 'COUNTRY' && !item.countryIso2?.trim()),
            )
          }
          onClick={() => void onPublish(requirements)}
        >
          Publier une nouvelle version
        </button>
      </div>
    </section>
  );
}

export function DepartureAdmin() {
  const canAuthorize = useCan('departure.authorize');
  const canManage = useCan('departure.manage');
  const [tripReference, setTripReference] = useState('');
  const [appliedTrip, setAppliedTrip] = useState('');
  const [data, setData] = useState<DepartureReadinessResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (reference: string) => {
    const result = await auth.admin.departure.readiness(reference);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setData(result.data);
    return true;
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const reference = tripReference.trim().toUpperCase();
    if (!reference || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (await load(reference)) setAppliedTrip(reference);
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (
    work: () =>
      | ReturnType<typeof auth.admin.departure.authorize>
      | ReturnType<typeof auth.admin.departure.depart>
      | ReturnType<typeof auth.admin.departure.complete>,
    success: string,
  ) => {
    if (!appliedTrip || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(success);
      await load(appliedTrip);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (requirements: DeparturePermitRequirementInput[]) => {
    if (!appliedTrip || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.departure.publishPermitPolicy(appliedTrip, { requirements });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        `Politique v${result.data.version} publiée avec ${result.data.requirementCount} exigence(s).`,
      );
      await load(appliedTrip);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="et-network" data-testid="departure-workspace">
      <p>
        La readiness est recalculée par le Core API à partir des faits actuels. L’interface ne peut
        ni forcer un gate, ni ignorer un blocker, ni transformer un permis intrinsèquement valide en
        autorisation de départ.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form
        className="et-form et-network-form"
        aria-label="Ouvrir le dispatch d’un voyage"
        onSubmit={search}
      >
        <TextField
          label="Référence du voyage"
          name="departureTripReference"
          value={tripReference}
          onChange={setTripReference}
          autoComplete="off"
          maxLength={32}
        />
        <div className="et-actions">
          <button className="et-button" type="submit" disabled={busy || !tripReference.trim()}>
            Vérifier la readiness
          </button>
          {appliedTrip ? (
            <button
              className="et-button et-button--secondary"
              type="button"
              disabled={busy}
              onClick={() => void load(appliedTrip)}
            >
              Recalculer
            </button>
          ) : null}
        </div>
      </form>

      {data ? <ReadinessPanel data={data} /> : null}

      {data && canManage && data.trip.status === 'SCHEDULED' ? (
        <PolicyEditor disabled={busy} onPublish={publish} />
      ) : null}

      {data ? (
        <section className="et-network-panel" aria-labelledby="departure-actions-title">
          <h2 id="departure-actions-title">Actions de dispatch</h2>
          <div className="et-actions">
            {canAuthorize && data.trip.status === 'SCHEDULED' ? (
              <button
                className="et-button"
                type="button"
                disabled={busy || data.readiness.status !== 'READY'}
                onClick={() =>
                  void mutate(
                    () => auth.admin.departure.authorize(appliedTrip),
                    'Autorisation de départ enregistrée.',
                  )
                }
              >
                Autoriser le départ
              </button>
            ) : null}
            {canManage && data.trip.status === 'SCHEDULED' ? (
              <button
                className="et-button"
                type="button"
                disabled={
                  busy || data.readiness.status !== 'READY' || !data.latestAuthorization?.current
                }
                onClick={() =>
                  void mutate(
                    () => auth.admin.departure.depart(appliedTrip),
                    'Départ réel enregistré.',
                  )
                }
              >
                Enregistrer le départ
              </button>
            ) : null}
            {canManage && data.trip.status === 'IN_PROGRESS' ? (
              <button
                className="et-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () => auth.admin.departure.complete(appliedTrip),
                    'Voyage clôturé à l’arrivée.',
                  )
                }
              >
                Clôturer le voyage
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
