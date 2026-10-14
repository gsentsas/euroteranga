'use client';

import {
  type PassengerDocument,
  type PassengerDocumentStatus,
  type PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';

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
      className="et-network-panel"
      aria-labelledby={`passenger-document-${document.reference}`}
      data-testid="passenger-document-detail"
    >
      <div className="et-actions">
        <h2 id={`passenger-document-${document.reference}`}>Document {document.reference}</h2>
        <span className="et-tag">{STATUS_LABELS[document.status]}</span>
      </div>
      <p>
        Le statut est purement technique : il ne conclut ni à la validité juridique du document, ni
        à l’autorisation de voyager.
      </p>
      <dl className="et-booking-admin-summary">
        <dt>Voyageur</dt>
        <dd>
          {document.passenger.givenName} {document.passenger.familyName} ·{' '}
          <span className="et-code">{document.passenger.reference}</span>
        </dd>
        <dt>Réservation(s)</dt>
        <dd>{document.bookingReferences.join(', ') || '—'}</dd>
        <dt>Type</dt>
        <dd>{TYPE_LABELS[document.type]}</dd>
        <dt>Créé le</dt>
        <dd>{formatAt(document.createdAt)}</dd>
        <dt>Taille</dt>
        <dd>{document.sizeBytes.toLocaleString('fr-FR')} octets</dd>
        <dt>MIME</dt>
        <dd className="et-code">{document.mimeType}</dd>
        <dt>Expiration déclarée</dt>
        <dd>{document.expiresAt ?? '—'}</dd>
      </dl>
      {document.status === 'ACCEPTED' ? (
        <button type="button" className="et-button" disabled={busy} onClick={() => void download()}>
          Télécharger le fichier privé
        </button>
      ) : (
        <p>Aucun téléchargement n’est disponible pour un fichier en quarantaine ou refusé.</p>
      )}
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

  return (
    <div className="et-network" data-testid="passenger-documents-workspace">
      <p>
        Consultation sécurisée des documents voyageurs. « Accepté techniquement » signifie
        uniquement que le fichier a passé le pipeline de sécurité ; aucune approbation de voyage
        n’est disponible dans cette version.
      </p>
      <FormAlert message={error} />
      <form
        className="et-form et-network-form"
        aria-label="Filtrer les documents passagers"
        onSubmit={filter}
      >
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

      {detail ? <Detail document={detail} download={download} busy={busy} /> : null}
      <section aria-labelledby="passenger-documents-list-title">
        <h2 id="passenger-documents-list-title">Documents passagers</h2>
        {!documents ? <p role="status">Chargement des documents…</p> : null}
        {documents ? (
          <div className="et-table-wrap">
            <table>
              <caption>Fichiers privés et statuts techniques</caption>
              <thead>
                <tr>
                  <th>Voyageur</th>
                  <th>Réservation</th>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Statut</th>
                  <th>Créé le</th>
                  <th>Taille</th>
                  <th>MIME</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((item) => (
                  <tr key={item.reference}>
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}
                      <br />
                      <span className="et-code">{item.passenger.reference}</span>
                    </td>
                    <td>{item.bookingReferences.join(', ')}</td>
                    <td className="et-code">{item.reference}</td>
                    <td>{TYPE_LABELS[item.type]}</td>
                    <td>{STATUS_LABELS[item.status]}</td>
                    <td>{formatAt(item.createdAt)}</td>
                    <td>{item.sizeBytes.toLocaleString('fr-FR')}</td>
                    <td className="et-code">{item.mimeType}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
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
        {documents?.length === 0 ? <p>Aucun document.</p> : null}
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
    </div>
  );
}
