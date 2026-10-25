'use client';

import {
  type PassengerDocument,
  type PassengerDocumentStatus,
  type PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';

const TYPE_LABELS: Record<PassengerDocumentType, string> = {
  PASSPORT: 'Passeport',
  NATIONAL_ID: 'Carte nationale d’identité',
  RESIDENCE_PERMIT: 'Titre de séjour',
  VISA: 'Visa',
  PARENTAL_AUTHORIZATION: 'Autorisation parentale',
  OTHER: 'Autre',
};

const STATUS_LABELS: Record<PassengerDocumentStatus, string> = {
  QUARANTINED: 'En quarantaine',
  ACCEPTED: 'Accepté techniquement',
  REJECTED: 'Refusé',
};

/**
 * ACCEPTED is shown as information, never as success: it only means the file
 * passed the technical pipeline, not that it is legally valid for the trip.
 */
const STATUS_TONES: Record<PassengerDocumentStatus, 'info' | 'warning' | 'danger'> = {
  QUARANTINED: 'warning',
  ACCEPTED: 'info',
  REJECTED: 'danger',
};

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

function Detail({
  document,
  download,
  busy,
}: {
  document: PassengerDocument;
  download: () => Promise<void>;
  busy: boolean;
}) {
  return (
    <section
      className="et-network-panel ops-ground-detail"
      aria-labelledby={`passenger-document-${document.reference}`}
      data-testid="passenger-document-detail"
    >
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">Fichier privé · lecture seule</p>
          <h2 id={`passenger-document-${document.reference}`}>Document {document.reference}</h2>
        </div>
        <OpsStatusBadge
          tone={STATUS_TONES[document.status]}
          className="ops-status-badge--technical"
        >
          {STATUS_LABELS[document.status]}
        </OpsStatusBadge>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Le statut est purement technique : il ne conclut ni à la validité juridique du document, ni
        à l’autorisation de voyager.
      </p>
      <dl className="ops-ground-facts">
        <div>
          <dt>Voyageur</dt>
          <dd>
            {document.passenger.givenName} {document.passenger.familyName} ·{' '}
            <span className="et-code">{document.passenger.reference}</span>
          </dd>
        </div>
        <div>
          <dt>Réservation(s)</dt>
          <dd className="et-code">{document.bookingReferences.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{TYPE_LABELS[document.type]}</dd>
        </div>
        <div>
          <dt>Statut technique</dt>
          <dd>{STATUS_LABELS[document.status]}</dd>
        </div>
        <div>
          <dt>Créé le</dt>
          <dd>{formatAt(document.createdAt)}</dd>
        </div>
        <div>
          <dt>Taille</dt>
          <dd>{document.sizeBytes.toLocaleString('fr-FR')} octets</dd>
        </div>
        <div>
          <dt>MIME</dt>
          <dd className="et-code">{document.mimeType}</dd>
        </div>
        <div>
          <dt>Expiration déclarée</dt>
          <dd>{document.expiresAt ?? '—'}</dd>
        </div>
      </dl>
      <div className="ops-ground-form">
        <p className="ops-operations-section-kicker">Téléchargement sécurisé</p>
        {document.status === 'ACCEPTED' ? (
          <>
            <p className="ops-ground-form__hint">
              Le fichier est transmis par l’API authentifiée, sans lien public ni adresse de
              stockage.
            </p>
            <button
              type="button"
              className="et-button"
              disabled={busy}
              onClick={() => void download()}
            >
              Télécharger le fichier privé
            </button>
          </>
        ) : (
          <p className="ops-ground-form__hint">
            Aucun téléchargement n’est disponible pour un fichier en quarantaine ou refusé.
          </p>
        )}
      </div>
    </section>
  );
}

/** Read-only passenger.document.read surface. PR-12 will own compliance. */
export function PassengerDocumentsAdmin() {
  const typeId = useId();
  const statusId = useId();
  const [type, setType] = useState<PassengerDocumentType | ''>('');
  const [status, setStatus] = useState<PassengerDocumentStatus | ''>('');
  const [bookingReference, setBookingReference] = useState('');
  const [passengerReference, setPassengerReference] = useState('');
  const [applied, setApplied] = useState({ bookingReference: '', passengerReference: '' });
  const [documents, setDocuments] = useState<PassengerDocument[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<PassengerDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.passengerDocuments.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.passengerReference ? { passengerReference: applied.passengerReference } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDocuments((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied, status, type],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (reference: string) => {
    setError(null);
    const result = await auth.admin.passengerDocuments.detail(reference);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const download = async () => {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.passengerDocuments.download(detail.reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const url = URL.createObjectURL(result.data.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.data.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setBusy(false);
    }
  };

  const filter = (event: FormEvent) => {
    event.preventDefault();
    setApplied({
      bookingReference: bookingReference.trim().toUpperCase(),
      passengerReference: passengerReference.trim().toUpperCase(),
    });
  };

  const visible = documents ?? [];
  const acceptedCount = visible.filter((item) => item.status === 'ACCEPTED').length;
  const quarantinedCount = visible.filter((item) => item.status === 'QUARANTINED').length;
  const rejectedCount = visible.filter((item) => item.status === 'REJECTED').length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-passenger-documents-workspace"
      data-testid="passenger-documents-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Documents passagers</p>
          <h2>Fichiers privés et statuts techniques</h2>
          <p>
            Consultation sécurisée et en lecture seule des documents voyageurs. « Accepté
            techniquement » signifie uniquement que le fichier a passé le pipeline de sécurité ;
            aucune approbation de voyage n’est disponible dans cette version.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        La validation technique d’un fichier n’est ni une validation réglementaire ni une
        autorisation de voyage.
      </p>
      <FormAlert message={error} />

      {documents ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des documents affichés">
          <OpsKpiCard
            label="Documents affichés"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Tous les documents filtrés sont chargés'
            }
            icon="document"
            tone="info"
          />
          <OpsKpiCard
            label="Acceptés techniquement"
            value={acceptedCount}
            helper="Pipeline de sécurité passé, sans valeur réglementaire"
            icon="shield"
            tone="info"
          />
          <OpsKpiCard
            label="En quarantaine"
            value={quarantinedCount}
            helper="Analyse technique en cours"
            icon="audit"
            tone={quarantinedCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Refusés"
            value={rejectedCount}
            helper="Refusés par le pipeline technique"
            icon="alert"
            tone={rejectedCount > 0 ? 'danger' : 'neutral'}
          />
        </section>
      ) : null}
      {documents && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres documents sont disponibles. Les indicateurs ne portent que
          sur les {documents.length} documents chargés.
        </p>
      ) : null}

      <form
        className="et-form et-network-form ops-ground-panel"
        aria-label="Filtrer les documents passagers"
        onSubmit={filter}
      >
        <p className="ops-operations-section-kicker">Filtres</p>
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={typeId}>Type</label>
            <select
              id={typeId}
              className="et-select"
              value={type}
              onChange={(event) => setType(event.target.value as PassengerDocumentType | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(TYPE_LABELS) as PassengerDocumentType[]).map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="et-field">
            <label htmlFor={statusId}>Statut technique</label>
            <select
              id={statusId}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as PassengerDocumentStatus | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(STATUS_LABELS) as PassengerDocumentStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Référence réservation"
            name="bookingReference"
            value={bookingReference}
            onChange={setBookingReference}
            autoComplete="off"
            maxLength={16}
          />
          <TextField
            label="Référence voyageur"
            name="passengerReference"
            value={passengerReference}
            onChange={setPassengerReference}
            autoComplete="off"
            maxLength={16}
          />
        </div>
        <button type="submit" className="et-button">
          Filtrer
        </button>
      </form>

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="passenger-documents-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Registre des fichiers</p>
            <h2 id="passenger-documents-list-title">Documents passagers</h2>
          </div>
        </div>
        {!documents && !error ? <OpsLoadingState title="Chargement des documents…" /> : null}
        {documents && documents.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Fichiers privés et statuts techniques</caption>
              <thead>
                <tr>
                  <th scope="col">Voyageur · réservation</th>
                  <th scope="col">Document</th>
                  <th scope="col">Type</th>
                  <th scope="col">Statut technique</th>
                  <th scope="col">Créé le</th>
                  <th scope="col">Fichier (MIME · taille)</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((item) => (
                  <tr
                    key={item.reference}
                    className={
                      detail?.reference === item.reference ? 'ops-table-row--selected' : undefined
                    }
                  >
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}
                      <br />
                      <span className="et-code">{item.passenger.reference}</span>
                      <br />
                      <span className="et-code">{item.bookingReferences.join(', ')}</span>
                    </td>
                    <th scope="row" className="et-code">
                      {item.reference}
                    </th>
                    <td>{TYPE_LABELS[item.type]}</td>
                    <td>
                      <OpsStatusBadge
                        tone={STATUS_TONES[item.status]}
                        className="ops-status-badge--technical"
                      >
                        {STATUS_LABELS[item.status]}
                      </OpsStatusBadge>
                    </td>
                    <td>{formatAt(item.createdAt)}</td>
                    <td>
                      <span className="et-code">{item.mimeType}</span>
                      <br />
                      {item.sizeBytes.toLocaleString('fr-FR')} octets
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter le document ${item.reference}`}
                        aria-controls="passenger-document-detail-panel"
                        aria-expanded={detail?.reference === item.reference}
                        onClick={() => void select(item.reference)}
                      >
                        Consulter
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {documents?.length === 0 ? (
          <OpsEmptyState
            title="Aucun document."
            description="Aucun fichier ne correspond aux filtres actuellement appliqués."
          />
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Charger la suite
          </button>
        ) : null}
      </section>

      {detail ? (
        <OpsDetailRegion
          id="passenger-document-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
          <Detail document={detail} download={download} busy={busy} />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
