'use client';

import type { PassengerManifest, PassengerManifestSummary } from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

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
    <section className="et-network-panel" aria-labelledby="manifest-detail-title">
      <div className="et-actions">
        <h2 id="manifest-detail-title">Version {manifest.version}</h2>
        <span className="et-tag">{manifest.reference}</span>
        {canExport ? (
          <button type="button" className="et-button et-button--secondary" onClick={onExport}>
            Exporter en CSV
          </button>
        ) : null}
      </div>
      <dl className="et-booking-admin-summary">
        <dt>Voyage</dt>
        <dd className="et-code">{manifest.tripReference}</dd>
        <dt>Généré le</dt>
        <dd>{formatAt(manifest.generatedAt)}</dd>
        <dt>Passagers enregistrés</dt>
        <dd>{manifest.passengerCount}</dd>
        <dt>Passagers embarqués</dt>
        <dd>{manifest.boardedCount}</dd>
        <dt>Empreinte SHA-256</dt>
        <dd className="et-code">{manifest.contentHash}</dd>
        <dt>Véhicule capturé</dt>
        <dd>
          {manifest.snapshot.trip.vehicle.code ?? 'Non affecté'} ·{' '}
          {manifest.snapshot.trip.vehicle.registrationPlate ?? 'immatriculation absente'}
        </dd>
      </dl>
      <div className="et-table-wrap">
        <table data-testid="manifest-passengers">
          <caption>Passagers capturés dans cette version immuable</caption>
          <thead>
            <tr>
              <th>Siège</th>
              <th>Passager</th>
              <th>Réservation</th>
              <th>Trajet</th>
              <th>Check-in</th>
              <th>Embarquement</th>
            </tr>
          </thead>
          <tbody>
            {manifest.snapshot.passengers.map((passenger) => (
              <tr key={passenger.passengerReference}>
                <td>{passenger.seat.label}</td>
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
                <td>{passenger.boarding ? formatAt(passenger.boarding.boardedAt) : 'Non'}</td>
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
  const [tripReference, setTripReference] = useState('');
  const [appliedTrip, setAppliedTrip] = useState('');
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

  return (
    <div className="et-network" data-testid="manifest-workspace">
      <p>
        Chaque génération capture une nouvelle version historique des seuls passagers déjà
        enregistrés. Ce document opérationnel ne constitue ni une autorisation réglementaire ni une
        décision de départ.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form className="et-form et-network-form" aria-label="Rechercher un voyage" onSubmit={search}>
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
        <section className="et-network-panel" aria-labelledby="manifest-history-title">
          <h2 id="manifest-history-title">Historique {appliedTrip}</h2>
          <div className="et-table-wrap">
            <table data-testid="manifest-history">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Référence</th>
                  <th>Générée le</th>
                  <th>Enregistrés</th>
                  <th>Embarqués</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.reference}>
                    <td>{item.version}</td>
                    <td className="et-code">{item.reference}</td>
                    <td>{formatAt(item.generatedAt)}</td>
                    <td>{item.passengerCount}</td>
                    <td>{item.boardedCount}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        onClick={() => void select(item.reference)}
                      >
                        Détail
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6}>Aucune version générée pour ce voyage.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
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
      ) : null}
      {detail ? <Detail manifest={detail} canExport={canExport} onExport={exportCsv} /> : null}
    </div>
  );
}
