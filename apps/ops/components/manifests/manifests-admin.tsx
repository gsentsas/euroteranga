'use client';

import type { PassengerManifest, PassengerManifestSummary } from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { useTripReferenceParam } from '../trips/trip-link';

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

function Detail({
  manifest,
  canExport,
  onExport,
}: {
  manifest: PassengerManifest;
  canExport: boolean;
  onExport: () => Promise<void>;
}) {
  return (
    <section className="et-network-panel ops-ground-detail" aria-labelledby="manifest-detail-title">
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">
            Version immuable · <span className="et-code">{manifest.reference}</span>
          </p>
          <h2 id="manifest-detail-title">Version {manifest.version}</h2>
        </div>
        {canExport ? (
          <button type="button" className="et-button et-button--secondary" onClick={onExport}>
            Exporter en CSV
          </button>
        ) : null}
      </div>
      <dl className="ops-ground-facts">
        <div>
          <dt>Voyage</dt>
          <dd className="et-code">{manifest.tripReference}</dd>
        </div>
        <div>
          <dt>Généré le</dt>
          <dd>{formatAt(manifest.generatedAt)}</dd>
        </div>
        <div>
          <dt>Passagers enregistrés</dt>
          <dd>{manifest.passengerCount}</dd>
        </div>
        <div>
          <dt>Passagers embarqués</dt>
          <dd>{manifest.boardedCount}</dd>
        </div>
        <div>
          <dt>Véhicule capturé</dt>
          <dd>
            {manifest.snapshot.trip.vehicle.code ?? 'Non affecté'} ·{' '}
            {manifest.snapshot.trip.vehicle.registrationPlate ?? 'immatriculation absente'}
          </dd>
        </div>
        <div className="ops-ground-facts__wide">
          <dt>Empreinte SHA-256</dt>
          <dd className="et-code">{manifest.contentHash}</dd>
        </div>
      </dl>
      <p className="ops-ground-guardrail">
        Cette version est un instantané historique : elle ne se modifie pas et ne vaut ni
        autorisation réglementaire ni décision de départ.
      </p>
      <div className="et-table-wrap">
        <table className="et-table" data-testid="manifest-passengers">
          <caption>Passagers capturés dans cette version immuable</caption>
          <thead>
            <tr>
              <th scope="col">Siège</th>
              <th scope="col">Passager</th>
              <th scope="col">Réservation</th>
              <th scope="col">Trajet</th>
              <th scope="col">Check-in</th>
              <th scope="col">Embarquement</th>
            </tr>
          </thead>
          <tbody>
            {manifest.snapshot.passengers.map((passenger) => (
              <tr key={passenger.passengerReference}>
                <th scope="row">{passenger.seat.label}</th>
                <td>
                  {passenger.familyName} {passenger.givenName}
                  <br />
                  <span className="et-code">{passenger.passengerReference}</span>
                </td>
                <td className="et-code">{passenger.bookingReference}</td>
                <td>
                  {passenger.origin.code} → {passenger.destination.code}
                </td>
                <td>{formatAt(passenger.checkIn.checkedInAt)}</td>
                <td>
                  {passenger.boarding ? (
                    formatAt(passenger.boarding.boardedAt)
                  ) : (
                    <OpsStatusBadge tone="neutral">Non</OpsStatusBadge>
                  )}
                </td>
              </tr>
            ))}
            {manifest.snapshot.passengers.length === 0 ? (
              <tr>
                <td colSpan={6}>Aucun passager enregistré au moment de cette génération.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Read-only history plus explicit generation/export actions, each API-authorized. */
export function ManifestsAdmin() {
  const canGenerate = useCan('manifest.generate');
  const canExport = useCan('manifest.export');
  // `/manifests?voyage=REF` (trip cockpit) opens directly on that trip.
  const linkedTrip = useTripReferenceParam();
  const [tripReference, setTripReference] = useState(linkedTrip);
  const [appliedTrip, setAppliedTrip] = useState(linkedTrip);
  const [items, setItems] = useState<PassengerManifestSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [detail, setDetail] = useState<PassengerManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (reference: string, cursor?: number) => {
    const result = await auth.admin.manifests.list({
      tripReference: reference,
      limit: 25,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setItems((current) =>
      cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
    );
    setNextCursor(result.data.nextCursor);
  };

  useEffect(() => {
    if (linkedTrip) void load(linkedTrip);
    // Only the trip of the incoming link is loaded automatically.
  }, [linkedTrip]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const reference = tripReference.trim().toUpperCase();
    if (!reference) return;
    setAppliedTrip(reference);
    setDetail(null);
    setError(null);
    setNotice(null);
    void load(reference);
  };

  const select = async (reference: string) => {
    setError(null);
    const result = await auth.admin.manifests.detail(reference);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const generate = async () => {
    const reference = (appliedTrip || tripReference).trim().toUpperCase();
    if (!reference || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.manifests.generate(reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAppliedTrip(reference);
      setDetail(result.data);
      setNotice(`Version ${result.data.version} générée (${result.data.reference}).`);
      await load(reference);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.manifests.exportCsv(detail.reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const url = URL.createObjectURL(result.data.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const latest = items?.reduce<PassengerManifestSummary | null>(
    (current, item) => (!current || item.version > current.version ? item : current),
    null,
  );

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-manifests-workspace"
      data-testid="manifest-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Documents de bord</p>
          <h2>Manifestes passagers versionnés</h2>
          <p>
            Chaque génération capture une nouvelle version historique des seuls passagers déjà
            enregistrés.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Ce document opérationnel ne constitue ni une autorisation réglementaire ni une décision de
        départ.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form
        className="et-form et-network-form ops-ground-panel ops-ground-scan"
        aria-label="Rechercher un voyage"
        onSubmit={search}
      >
        <p className="ops-operations-section-kicker">Voyage</p>
        <TextField
          label="Référence du voyage"
          name="tripReference"
          value={tripReference}
          onChange={setTripReference}
          autoComplete="off"
          maxLength={32}
        />
        <div className="et-actions">
          <button type="submit" className="et-button" disabled={!tripReference.trim()}>
            Afficher l’historique
          </button>
          {canGenerate ? (
            <button
              type="button"
              className="et-button et-button--secondary"
              disabled={busy || !(appliedTrip || tripReference.trim())}
              onClick={() => void generate()}
            >
              Générer une nouvelle version
            </button>
          ) : null}
        </div>
      </form>

      {items ? (
        <section
          className="ops-operations-kpis"
          aria-label={`Indicateurs des manifestes ${appliedTrip}`}
        >
          <OpsKpiCard
            label="Versions affichées"
            value={items.length}
            helper={
              nextCursor
                ? 'Éléments chargés · versions précédentes disponibles'
                : 'Historique complet chargé'
            }
            icon="manifest"
            tone="info"
          />
          <OpsKpiCard
            label="Version la plus récente"
            value={latest ? `v${latest.version}` : '—'}
            helper={
              latest ? `Générée le ${formatAt(latest.generatedAt)}` : 'Aucune version générée'
            }
            icon="document"
            tone={latest ? 'info' : 'neutral'}
          />
          <OpsKpiCard
            label="Enregistrés capturés"
            value={latest ? latest.passengerCount : '—'}
            helper="Dans la version la plus récente"
            icon="users"
            tone="neutral"
          />
          <OpsKpiCard
            label="Embarqués capturés"
            value={latest ? latest.boardedCount : '—'}
            helper="Instantané, pas une autorisation de départ"
            icon="bus"
            tone="neutral"
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {items.length} versions chargées.
        </p>
      ) : null}

      {items ? (
        <section
          className="ops-operations-section ops-operations-section--primary"
          aria-labelledby="manifest-history-title"
        >
          <div className="et-actions">
            <div>
              <p className="ops-operations-section-kicker">Historique immuable</p>
              <h2 id="manifest-history-title">Historique {appliedTrip}</h2>
            </div>
          </div>
          {items.length > 0 ? (
            <div className="et-table-wrap">
              <table className="et-table" data-testid="manifest-history">
                <caption>Versions générées pour ce voyage</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Référence</th>
                    <th scope="col">Générée le</th>
                    <th scope="col">Enregistrés</th>
                    <th scope="col">Embarqués</th>
                    <th scope="col">Fiche</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.reference}
                      className={
                        detail?.reference === item.reference ? 'ops-table-row--selected' : undefined
                      }
                    >
                      <th scope="row">v{item.version}</th>
                      <td className="et-code">{item.reference}</td>
                      <td>{formatAt(item.generatedAt)}</td>
                      <td>{item.passengerCount}</td>
                      <td>{item.boardedCount}</td>
                      <td>
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          aria-label={`Détail de la version ${item.version}`}
                          aria-controls="manifest-detail-panel"
                          aria-expanded={detail?.reference === item.reference}
                          onClick={() => void select(item.reference)}
                        >
                          Détail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <OpsEmptyState
              title="Aucune version générée pour ce voyage."
              description="Un manifeste ne capture que les passagers déjà enregistrés au moment de la génération."
            />
          )}
          {nextCursor ? (
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => void load(appliedTrip, nextCursor)}
            >
              Charger les versions précédentes
            </button>
          ) : null}
        </section>
      ) : (
        <OpsEmptyState
          title="Aucun voyage sélectionné"
          description="Saisissez la référence d’un voyage pour consulter l’historique de ses manifestes."
        />
      )}
      {detail ? (
        <OpsDetailRegion
          id="manifest-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
          <Detail manifest={detail} canExport={canExport} onExport={exportCsv} />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
