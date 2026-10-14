'use client';

import type {
  ComplianceEvaluationDetail,
  ComplianceOutcome,
  ComplianceQueueItem,
  ComplianceReviewDecision,
  ComplianceStatus,
  PassengerDocumentStatus,
  PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

export const STATUS_LABELS: Record<ComplianceStatus, string> = {
  NOT_EVALUATED: 'Non évalué',
  STALE: 'Obsolète : à réévaluer',
  REVIEW_REQUIRED: 'Revue requise',
  COMPLIANT_BY_RULES: 'Conforme selon les règles publiées',
  NON_COMPLIANT_BY_RULES: 'Non conforme selon les règles publiées',
  COMPLIANT: 'Conforme après revue',
  NON_COMPLIANT: 'Non conforme après revue',
  NEEDS_INFORMATION: 'Informations complémentaires requises',
};

const OUTCOME_LABELS: Record<ComplianceOutcome, string> = {
  PASS: 'Satisfaite',
  FAIL: 'Non satisfaite',
  REVIEW_REQUIRED: 'Revue requise',
  NOT_APPLICABLE: 'Non applicable',
};

const DECISION_LABELS: Record<ComplianceReviewDecision, string> = {
  COMPLIANT: 'Conforme',
  NON_COMPLIANT: 'Non conforme',
  NEEDS_INFORMATION: 'Informations complémentaires requises',
};

const DOCUMENT_LABELS: Record<PassengerDocumentType, string> = {
  PASSPORT: 'Passeport',
  NATIONAL_ID: 'Carte nationale d’identité',
  RESIDENCE_PERMIT: 'Titre de séjour',
  VISA: 'Visa',
  PARENTAL_AUTHORIZATION: 'Autorisation parentale',
  OTHER: 'Autre',
};

const TECHNICAL_LABELS: Record<PassengerDocumentStatus, string> = {
  QUARANTINED: 'En quarantaine',
  ACCEPTED: 'Accepté techniquement',
  REJECTED: 'Refusé',
};

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

/** Documents of the evaluated facts snapshot (references, types, expiry only). */
function factDocuments(
  facts: unknown,
): Array<{ reference: string; type: PassengerDocumentType; expiresAt: string | null }> {
  const documents = (facts as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) return [];
  return documents.filter(
    (item): item is { reference: string; type: PassengerDocumentType; expiresAt: string | null } =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { reference?: unknown }).reference === 'string' &&
      typeof (item as { type?: unknown }).type === 'string' &&
      (item as { type: string }).type in DOCUMENT_LABELS,
  );
}

const findingText = (finding: { code: string; documentType?: string | null; country?: string }) =>
  [finding.code, finding.documentType, finding.country].filter(Boolean).join(' · ');

function EvaluationDetail({
  evaluation,
  canReview,
  canOpenDocuments,
  busy,
  onReview,
  onReevaluate,
  onOpenDocument,
}: {
  evaluation: ComplianceEvaluationDetail;
  canReview: boolean;
  canOpenDocuments: boolean;
  busy: boolean;
  onReview: (
    decision: ComplianceReviewDecision,
    reason: string,
    customerMessage: string,
  ) => Promise<void>;
  onReevaluate: () => Promise<void>;
  onOpenDocument: (reference: string) => Promise<void>;
}) {
  const formId = useId();
  const [decision, setDecision] = useState<ComplianceReviewDecision | ''>('');
  const [reason, setReason] = useState('');
  const [customerMessage, setCustomerMessage] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    void onReview(decision, reason, customerMessage).then(() => {
      setDecision('');
      setReason('');
      setCustomerMessage('');
    });
  };

  return (
    <section
      className="et-network-panel"
      aria-labelledby="compliance-evaluation-title"
      data-testid="compliance-evaluation-detail"
    >
      <div className="et-actions">
        <h2 id="compliance-evaluation-title">
          Évaluation <span className="et-code">{evaluation.reference}</span>
        </h2>
        <span className="et-tag">{STATUS_LABELS[evaluation.status]}</span>
      </div>
      {!evaluation.current ? (
        <p role="alert">
          Évaluation obsolète ou remplacée : les faits ou les règles ont changé. Elle et ses revues
          sont un historique, pas une conformité actuelle. Réévaluez avant toute décision.
        </p>
      ) : null}
      <dl className="et-booking-admin-summary">
        <dt>Voyageur</dt>
        <dd>
          {evaluation.passenger.givenName} {evaluation.passenger.familyName} ·{' '}
          <span className="et-code">{evaluation.passenger.reference}</span>
        </dd>
        <dt>Nationalité</dt>
        <dd>
          {evaluation.passenger.nationality.name} ({evaluation.passenger.nationality.iso2})
        </dd>
        <dt>Réservation</dt>
        <dd className="et-code">{evaluation.bookingReference}</dd>
        <dt>Voyage</dt>
        <dd className="et-code">{evaluation.tripReference}</dd>
        <dt>Date de voyage</dt>
        <dd>
          {evaluation.travelDate} (arrivée {evaluation.arrivalDate})
        </dd>
        <dt>Évaluée le</dt>
        <dd>
          {formatAt(evaluation.evaluatedAt)} · {evaluation.engineVersion}
        </dd>
        <dt>Résultat machine</dt>
        <dd>{evaluation.result}</dd>
      </dl>
      {evaluation.findings.length > 0 ? (
        <>
          <h3>Constats de couverture</h3>
          <ul>
            {evaluation.findings.map((finding, index) => (
              <li key={index}>{findingText(finding)}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Règles appliquées</h3>
      {evaluation.results.length === 0 ? (
        <p>Aucune règle publiée et vérifiée ne s’applique : une revue humaine est requise.</p>
      ) : (
        <div className="et-table-wrap">
          <table>
            <caption>Versions de règles et constats</caption>
            <thead>
              <tr>
                <th>Règle</th>
                <th>Version</th>
                <th>Résultat</th>
                <th>Constats</th>
                <th>Documents (état technique)</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.results.map((result) => (
                <tr key={`${result.rule.reference}-${result.version.version}`}>
                  <td>
                    <span className="et-code">{result.rule.reference}</span> {result.rule.title}
                  </td>
                  <td>
                    v{result.version.version} ({result.version.status}) ·{' '}
                    {result.version.effectiveFrom} → {result.version.effectiveTo ?? '…'} · source{' '}
                    {result.version.source.authority ?? '—'}
                  </td>
                  <td>
                    {OUTCOME_LABELS[result.outcome]}{' '}
                    <span className="et-code">{result.reasonCode}</span>
                  </td>
                  <td>{result.details.map(findingText).join(' ; ') || '—'}</td>
                  <td>
                    {result.evidence.length === 0
                      ? '—'
                      : result.evidence.map((document) => (
                          <div key={document.reference}>
                            {DOCUMENT_LABELS[document.type]}{' '}
                            <span className="et-code">{document.reference}</span> ·{' '}
                            {TECHNICAL_LABELS[document.technicalStatus]} · expiration{' '}
                            {document.expiresAt ?? 'non renseignée'}
                            {canOpenDocuments && document.technicalStatus === 'ACCEPTED' ? (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  className="et-button et-button--secondary"
                                  disabled={busy}
                                  onClick={() => void onOpenDocument(document.reference)}
                                >
                                  Ouvrir la preuve {document.reference}
                                </button>
                              </>
                            ) : null}
                          </div>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Documents du voyageur au moment de l’évaluation</h3>
      {factDocuments(evaluation.facts).length === 0 ? (
        <p>Aucun document accepté techniquement.</p>
      ) : (
        <ul>
          {factDocuments(evaluation.facts).map((document) => (
            <li key={document.reference}>
              {DOCUMENT_LABELS[document.type]} <span className="et-code">{document.reference}</span>{' '}
              · expiration {document.expiresAt ?? 'non renseignée'}
              {canOpenDocuments ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busy}
                    onClick={() => void onOpenDocument(document.reference)}
                  >
                    Ouvrir le document {document.reference}
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p>
        « Accepté techniquement » n’est pas une validation réglementaire : vérifiez le contenu du
        document au regard des règles appliquées.
      </p>
      <details>
        <summary>Faits évalués (instantané minimisé)</summary>
        <pre className="et-json et-code">{JSON.stringify(evaluation.facts, null, 2)}</pre>
      </details>

      <h3>Revues</h3>
      {evaluation.reviews.length === 0 ? (
        <p>Aucune revue.</p>
      ) : (
        <ol>
          {evaluation.reviews.map((review) => (
            <li key={review.id}>
              {DECISION_LABELS[review.decision]} · {formatAt(review.reviewedAt)} · {review.reviewer}{' '}
              · {review.current ? 'actuelle' : 'historique'} — {review.reason}
              {review.customerMessage ? ` (message client : ${review.customerMessage})` : ''}
            </li>
          ))}
        </ol>
      )}

      {canReview ? (
        <div className="et-actions">
          <button
            type="button"
            className="et-button et-button--secondary"
            disabled={busy}
            onClick={() => void onReevaluate()}
          >
            Réévaluer
          </button>
        </div>
      ) : null}
      {canReview && evaluation.current ? (
        <form onSubmit={submit} aria-label="Enregistrer une revue">
          <fieldset>
            <legend>Décision (motif obligatoire)</legend>
            {(Object.keys(DECISION_LABELS) as ComplianceReviewDecision[]).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${formId}-decision`}
                  value={value}
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                  required
                />{' '}
                {DECISION_LABELS[value]}
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${formId}-reason`}>Motif interne (obligatoire)</label>
          <textarea
            id={`${formId}-reason`}
            value={reason}
            minLength={10}
            maxLength={1000}
            required
            onChange={(event) => setReason(event.target.value)}
          />
          <label htmlFor={`${formId}-message`}>Message au client (facultatif)</label>
          <input
            id={`${formId}-message`}
            value={customerMessage}
            maxLength={500}
            onChange={(event) => setCustomerMessage(event.target.value)}
          />
          <button type="submit" className="et-button" disabled={busy || !decision}>
            Enregistrer la revue
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** compliance.read queue and detail; compliance.review to evaluate and review. */
export function ComplianceReviewsAdmin() {
  const canReview = useCan('compliance.review');
  const canOpenDocuments = useCan('passenger.document.read');
  const statusId = useId();
  const [status, setStatus] = useState<ComplianceStatus | ''>('');
  const [bookingReference, setBookingReference] = useState('');
  const [passengerReference, setPassengerReference] = useState('');
  const [tripReference, setTripReference] = useState('');
  const [applied, setApplied] = useState({
    status: '' as ComplianceStatus | '',
    bookingReference: '',
    passengerReference: '',
    tripReference: '',
  });
  const [items, setItems] = useState<ComplianceQueueItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<ComplianceEvaluationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.compliance.queue({
        limit: 25,
        ...(cursor ? { cursor } : {}),
        ...(applied.status ? { status: applied.status } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.passengerReference ? { passengerReference: applied.passengerReference } : {}),
        ...(applied.tripReference ? { tripReference: applied.tripReference } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openEvaluation = async (reference: string) => {
    setError(null);
    const result = await auth.admin.compliance.evaluation(reference);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const evaluate = async (item: { bookingReference: string; passengerReference: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.compliance.evaluate(
        item.bookingReference,
        item.passengerReference,
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        result.data.created ? 'Nouvelle évaluation enregistrée.' : 'Évaluation déjà à jour.',
      );
      await openEvaluation(result.data.reference);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const review = async (
    decision: ComplianceReviewDecision,
    reason: string,
    customerMessage: string,
  ) => {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      const head =
        detail.reviews.find((item) => item.current) ?? detail.reviews[detail.reviews.length - 1];
      const result = await auth.admin.compliance.review(detail.reference, {
        decision,
        reason,
        ...(customerMessage.trim() ? { customerMessage: customerMessage.trim() } : {}),
        previousReviewId: head?.id ?? null,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(`Revue enregistrée : ${DECISION_LABELS[decision]}.`);
      await openEvaluation(detail.reference);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (reference: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.passengerDocuments.download(reference);
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
      status,
      bookingReference: bookingReference.trim().toUpperCase(),
      passengerReference: passengerReference.trim().toUpperCase(),
      tripReference: tripReference.trim().toUpperCase(),
    });
  };

  return (
    <div className="et-network" data-testid="compliance-reviews-workspace">
      <p>
        File de revue de conformité des voyageurs. Une évaluation obsolète et ses revues sont un
        historique : réévaluez avant toute décision. Aucune décision n’est possible sans motif.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form
        className="et-form et-network-form"
        aria-label="Filtrer la file de conformité"
        onSubmit={filter}
      >
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={statusId}>Statut</label>
            <select
              id={statusId}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as ComplianceStatus | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(STATUS_LABELS) as ComplianceStatus[]).map((value) => (
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
          <TextField
            label="Référence voyage"
            name="tripReference"
            value={tripReference}
            onChange={setTripReference}
            autoComplete="off"
            maxLength={32}
          />
        </div>
        <button type="submit" className="et-button">
          Filtrer
        </button>
      </form>

      {detail ? (
        <EvaluationDetail
          evaluation={detail}
          canReview={canReview}
          canOpenDocuments={canOpenDocuments}
          busy={busy}
          onReview={review}
          onReevaluate={() =>
            evaluate({
              bookingReference: detail.bookingReference,
              passengerReference: detail.passenger.reference,
            })
          }
          onOpenDocument={openDocument}
        />
      ) : null}

      <section aria-labelledby="compliance-queue-title">
        <h2 id="compliance-queue-title">Voyageurs</h2>
        {!items ? <p role="status">Chargement de la file…</p> : null}
        {items?.length === 0 ? <p>Aucun voyageur pour ces filtres.</p> : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table>
              <caption>Conformité par voyageur et voyage</caption>
              <thead>
                <tr>
                  <th>Voyageur</th>
                  <th>Réservation</th>
                  <th>Voyage</th>
                  <th>Départ</th>
                  <th>Statut</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.bookingReference}-${item.passenger.reference}`}>
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}{' '}
                      <span className="et-code">{item.passenger.reference}</span>
                    </td>
                    <td className="et-code">{item.bookingReference}</td>
                    <td className="et-code">{item.tripReference}</td>
                    <td>{formatAt(item.departureAt)}</td>
                    <td>{STATUS_LABELS[item.status]}</td>
                    <td>
                      {item.evaluation ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          onClick={() => void openEvaluation(item.evaluation!.reference)}
                        >
                          Examiner {item.passenger.reference}
                        </button>
                      ) : canReview ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy}
                          onClick={() =>
                            void evaluate({
                              bookingReference: item.bookingReference,
                              passengerReference: item.passenger.reference,
                            })
                          }
                        >
                          Évaluer {item.passenger.reference}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Voir plus
          </button>
        ) : null}
      </section>
    </div>
  );
}
