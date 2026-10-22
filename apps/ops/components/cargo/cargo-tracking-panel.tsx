'use client';

import type { RoadFreightQr, RoadFreightTrackingTokenSummary } from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Sans expiration';

export function CargoTrackingPanel({
  shipmentReference,
  canManage,
}: {
  shipmentReference: string;
  canManage: boolean;
}) {
  const [qr, setQr] = useState<RoadFreightQr | null>(null);
  const [tokens, setTokens] = useState<RoadFreightTrackingTokenSummary[]>([]);
  const [issuedPath, setIssuedPath] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [qrResult, tokenResult] = await Promise.all([
      auth.admin.cargo.qr(shipmentReference),
      auth.admin.cargo.trackingTokens(shipmentReference),
    ]);
    if (!qrResult.ok) {
      setError(qrResult.error.message);
      return;
    }
    if (!tokenResult.ok) {
      setError(tokenResult.error.message);
      return;
    }
    setQr(qrResult.data);
    setTokens(tokenResult.data.items);
  }, [shipmentReference]);

  useEffect(() => {
    setIssuedPath(null);
    setRevokeReason('');
    setError(null);
    setNotice(null);
    void load();
  }, [load]);

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setIssuedPath(null);
    try {
      const result = await auth.admin.cargo.issueTrackingToken(shipmentReference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setIssuedPath(`/cargo/${result.data.token}`);
      setNotice(
        'Lien créé. Copiez-le maintenant : le token secret ne sera plus affiché dans la liste.',
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tokenId: string) => {
    if (busy || revokeReason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.cargo.revokeTrackingToken(
        shipmentReference,
        tokenId,
        revokeReason.trim(),
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRevokeReason('');
      setNotice('Lien public révoqué.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitRevoke = (event: FormEvent, tokenId: string) => {
    event.preventDefault();
    void revoke(tokenId);
  };

  return (
    <section
      className="et-network-panel"
      aria-label="QR et suivi public du fret"
      data-testid="cargo-tracking-panel"
    >
      <div className="et-actions">
        <h3>QR & suivi public</h3>
        <span className="et-tag">Sans PII</span>
      </div>
      <p>
        Le QR identifie uniquement le fret. Les liens publics affichent une progression limitée,
        sans coordonnées personnelles, prix, contenu déclaré ni position GPS précise.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {qr ? (
        <figure className="et-baggage-qr">
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URI */}
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`}
            alt={`QR code du fret ${shipmentReference}`}
            width={180}
            height={180}
          />
          <figcaption className="et-code">{shipmentReference}</figcaption>
        </figure>
      ) : null}

      {canManage ? (
        <div className="et-actions">
          <button type="button" className="et-button" disabled={busy} onClick={() => void issue()}>
            Créer un lien de suivi public
          </button>
        </div>
      ) : null}

      {issuedPath ? (
        <div className="ops-content-item" data-testid="cargo-issued-tracking-link">
          <strong>Lien relatif à transmettre</strong>
          <p className="et-code">{issuedPath}</p>
          <p className="et-hint">
            Utilisez ce chemin sur le domaine Tracking EURO TERANGA. Le token brut n’est affiché
            qu’une seule fois.
          </p>
        </div>
      ) : null}

      <div className="et-table-wrap">
        <table>
          <caption>Liens de suivi créés</caption>
          <thead>
            <tr>
              <th>Créé le</th>
              <th>Expiration</th>
              <th>État</th>
              <th>Révocation</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{formatAt(token.createdAt)}</td>
                <td>{formatAt(token.expiresAt)}</td>
                <td>{token.revokedAt ? 'Révoqué' : 'Actif'}</td>
                <td>
                  {token.revokedAt ? (
                    <>
                      {formatAt(token.revokedAt)}
                      {token.revocationReason ? ` · ${token.revocationReason}` : ''}
                    </>
                  ) : canManage ? (
                    <form onSubmit={(event) => submitRevoke(event, token.id)}>
                      <TextField
                        label="Motif"
                        name={`cargoTrackingRevoke-${token.id}`}
                        value={revokeReason}
                        onChange={setRevokeReason}
                        required={false}
                        autoComplete="off"
                        maxLength={255}
                      />
                      <button
                        type="submit"
                        className="et-button et-button--secondary"
                        disabled={busy || revokeReason.trim().length < 3}
                      >
                        Révoquer
                      </button>
                    </form>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tokens.length === 0 ? <p>Aucun lien public créé.</p> : null}
    </section>
  );
}
