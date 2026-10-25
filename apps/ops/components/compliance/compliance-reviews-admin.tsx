'use client';

import type {
  ComplianceEvaluationDetail,
  ComplianceOutcome,
  ComplianceQueueItem,
  ComplianceReviewDecision,
  ComplianceRuleVersionStatus,
  ComplianceStatus,
  PassengerDocumentStatus,
  PassengerDocumentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
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

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Global evaluation status (machine result or human review), always labelled. */
const STATUS_TONES: Record<ComplianceStatus, Tone> = {
  NOT_EVALUATED: 'neutral',
  STALE: 'warning',
  REVIEW_REQUIRED: 'warning',
  COMPLIANT_BY_RULES: 'success',
  NON_COMPLIANT_BY_RULES: 'danger',
  COMPLIANT: 'success',
  NON_COMPLIANT: 'danger',
  NEEDS_INFORMATION: 'warning',
};

/**
 * Per-rule outcome, outlined so it never reads as the global status: a PASS is
 * a rule evaluation, not an authorization to travel.
 */
const OUTCOME_TONES: Record<ComplianceOutcome, Tone> = {
  PASS: 'info',
  FAIL: 'danger',
  REVIEW_REQUIRED: 'warning',
  NOT_APPLICABLE: 'neutral',
};

const DECISION_TONES: Record<ComplianceReviewDecision, Tone> = {
  COMPLIANT: 'success',
  NON_COMPLIANT: 'danger',
  NEEDS_INFORMATION: 'warning',
};

const TECHNICAL_TONES: Record<PassengerDocumentStatus, Tone> = {
  QUARANTINED: 'warning',
  ACCEPTED: 'info',
  REJECTED: 'danger',
};

const VERSION_LABELS: Record<ComplianceRuleVersionStatus, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
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

  const currentReview = evaluation.reviews.find((review) => review.current) ?? null;
  const documents = factDocuments(evaluation.facts);

  return (
    <section
      className="et-network-panel ops-ground-detail"
      aria-labelledby="compliance-evaluation-title"
      data-testid="compliance-evaluation-detail"
    >
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">
            Dossier de conformité · moteur {evaluation.engineVersion}
          </p>
          <h2 id="compliance-evaluation-title">
            Évaluation <span className="et-code">{evaluation.reference}</span>
          </h2>
        </div>
        <div className="ops-ground-badges">
          <OpsStatusBadge tone={STATUS_TONES[evaluation.status]} className="et-tag">
            {STATUS_LABELS[evaluation.status]}
          </OpsStatusBadge>
          {evaluation.current ? (
            <OpsStatusBadge tone="info" className="ops-status-badge--outline">
              Évaluation courante
            </OpsStatusBadge>
          ) : (
            <OpsStatusBadge tone="warning" className="ops-status-badge--outline">
              Historique : à réévaluer
            </OpsStatusBadge>
          )}
        </div>
      </div>
      {!evaluation.current ? (
        <p className="ops-ground-guardrail ops-ground-guardrail--strong" role="alert">
          Évaluation obsolète ou remplacée : les faits ou les règles ont changé. Elle et ses revues
          sont un historique, pas une conformité actuelle. Réévaluez avant toute décision.
        </p>
      ) : null}

      <h3>Identité du dossier</h3>
      <dl className="ops-ground-facts">
        <div>
          <dt>Voyageur</dt>
          <dd>
            {evaluation.passenger.givenName} {evaluation.passenger.familyName} ·{' '}
            <span className="et-code">{evaluation.passenger.reference}</span>
          </dd>
        </div>
        <div>
          <dt>Nationalité</dt>
          <dd>
            {evaluation.passenger.nationality.name} ({evaluation.passenger.nationality.iso2})
          </dd>
        </div>
        <div>
          <dt>Réservation</dt>
          <dd className="et-code">{evaluation.bookingReference}</dd>
        </div>
        <div>
          <dt>Voyage</dt>
          <dd className="et-code">{evaluation.tripReference}</dd>
        </div>
        <div>
          <dt>Date de voyage</dt>
          <dd>
            {evaluation.travelDate} (arrivée {evaluation.arrivalDate})
          </dd>
        </div>
        <div>
          <dt>Évaluée le</dt>
          <dd>{formatAt(evaluation.evaluatedAt)}</dd>
        </div>
      </dl>

      <h3>État actuel</h3>
      <div className="ops-compliance-split">
        <div className="ops-compliance-split__item">
          <p className="ops-operations-section-kicker">Résultat machine</p>
          <p className="ops-compliance-split__value">
            <span className="et-code">{evaluation.result}</span>
          </p>
          <p className="ops-ground-form__hint">
            Calculé par le Core API à partir des seules règles publiées et vérifiées.
          </p>
        </div>
        <div className="ops-compliance-split__item">
          <p className="ops-operations-section-kicker">Décision humaine</p>
          <p className="ops-compliance-split__value">
            {currentReview ? (
              <OpsStatusBadge tone={DECISION_TONES[currentReview.decision]}>
                {DECISION_LABELS[currentReview.decision]}
              </OpsStatusBadge>
            ) : (
              'Aucune décision enregistrée'
            )}
          </p>
          <p className="ops-ground-form__hint">
            Revue motivée par un agent habilité ; elle ne remplace pas le résultat machine.
          </p>
        </div>
      </div>

      {evaluation.findings.length > 0 ? (
        <>
          <h3>Constats de couverture</h3>
          <ul className="ops-ground-history">
            {evaluation.findings.map((finding, index) => (
              <li key={index}>
                <span className="et-code">{findingText(finding)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Règles appliquées</h3>
      {evaluation.results.length === 0 ? (
        <p className="ops-ground-guardrail">
          Aucune règle publiée et vérifiée ne s’applique : une revue humaine est requise.
        </p>
      ) : (
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Versions de règles et constats</caption>
            <thead>
              <tr>
                <th scope="col">Règle</th>
                <th scope="col">Version</th>
                <th scope="col">Résultat de la règle</th>
                <th scope="col">Constats</th>
                <th scope="col">Documents (état technique)</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.results.map((result) => (
                <tr key={`${result.rule.reference}-${result.version.version}`}>
                  <th scope="row">
                    <span className="et-code">{result.rule.reference}</span> {result.rule.title}
                  </th>
                  <td>
                    v{result.version.version} · {VERSION_LABELS[result.version.status]} ·{' '}
                    {result.version.effectiveFrom} → {result.version.effectiveTo ?? '…'} · source{' '}
                    {result.version.source.authority ?? '—'}
                  </td>
                  <td>
                    <OpsStatusBadge
                      tone={OUTCOME_TONES[result.outcome]}
                      className="ops-status-badge--outline"
                    >
                      {OUTCOME_LABELS[result.outcome]}
                    </OpsStatusBadge>{' '}
                    <span className="et-code">{result.reasonCode}</span>
                  </td>
                  <td>{result.details.map(findingText).join(' ; ') || '—'}</td>
                  <td>
                    {result.evidence.length === 0
                      ? '—'
                      : result.evidence.map((document) => (
                          <div key={document.reference} className="ops-compliance-evidence">
                            {DOCUMENT_LABELS[document.type]}{' '}
                            <span className="et-code">{document.reference}</span>{' '}
                            <OpsStatusBadge
                              tone={TECHNICAL_TONES[document.technicalStatus]}
                              className="ops-status-badge--technical"
                            >
                              {TECHNICAL_LABELS[document.technicalStatus]}
                            </OpsStatusBadge>{' '}
                            · expiration {document.expiresAt ?? 'non renseignée'}
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
      {documents.length === 0 ? (
        <p className="ops-ground-form__hint">Aucun document accepté techniquement.</p>
      ) : (
        <ul className="ops-compliance-documents">
          {documents.map((document) => (
            <li key={document.reference}>
              <span>
                {DOCUMENT_LABELS[document.type]}{' '}
                <span className="et-code">{document.reference}</span> · expiration{' '}
                {document.expiresAt ?? 'non renseignée'}
              </span>
              {canOpenDocuments ? (
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  disabled={busy}
                  onClick={() => void onOpenDocument(document.reference)}
                >
                  Ouvrir le document {document.reference}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!canOpenDocuments && documents.length > 0 ? (
        <p className="ops-ground-form__hint">
          L’ouverture d’une pièce privée exige la permission de lecture des documents passagers.
        </p>
      ) : null}
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        « Accepté techniquement » n’est pas une validation réglementaire : vérifiez le contenu du
        document au regard des règles appliquées.
      </p>
      <details className="ops-compliance-json">
        <summary>Faits évalués (instantané minimisé)</summary>
        <pre className="et-json et-code">{JSON.stringify(evaluation.facts, null, 2)}</pre>
      </details>

      <h3>Historique des revues</h3>
      {evaluation.reviews.length === 0 ? (
        <p className="ops-ground-form__hint">Aucune revue.</p>
      ) : (
        <ol className="ops-ground-history">
          {evaluation.reviews.map((review) => (
            <li key={review.id}>
              <OpsStatusBadge tone={DECISION_TONES[review.decision]}>
                {DECISION_LABELS[review.decision]}
              </OpsStatusBadge>{' '}
              · {formatAt(review.reviewedAt)} · {review.reviewer} ·{' '}
              <strong>{review.current ? 'actuelle' : 'historique'}</strong> — {review.reason}
              {review.customerMessage ? ` (message client : ${review.customerMessage})` : ''}
            </li>
          ))}
        </ol>
      )}

      {canReview ? (
        <div className="ops-ground-forms">
          <div className="ops-ground-form">
            <p className="ops-operations-section-kicker">Réévaluation</p>
            <p className="ops-ground-form__hint">
              Le Core API recalcule la conformité à partir des faits et des règles en vigueur.
            </p>
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
          </div>
          {evaluation.current ? (
            <form
              className="et-form ops-ground-form ops-ground-form--wide"
              onSubmit={submit}
              aria-label="Enregistrer une revue"
            >
              <p className="ops-operations-section-kicker">Nouvelle décision</p>
              <p className="ops-ground-form__hint">
                La décision s’ajoute à la chaîne des revues : les revues précédentes restent
                visibles dans l’historique.
              </p>
              <fieldset className="ops-compliance-fieldset ops-compliance-decisions">
                <legend>Décision (motif obligatoire)</legend>
                {(Object.keys(DECISION_LABELS) as ComplianceReviewDecision[]).map((value) => (
                  <label key={value} className="ops-compliance-decision">
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
              <div className="et-field">
                <label htmlFor={`${formId}-reason`}>Motif interne (obligatoire)</label>
                <textarea
                  id={`${formId}-reason`}
                  className="et-input"
                  value={reason}
                  minLength={10}
                  maxLength={1000}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="et-field">
                <label htmlFor={`${formId}-message`}>Message au client (facultatif)</label>
                <input
                  id={`${formId}-message`}
                  className="et-input"
                  value={customerMessage}
                  maxLength={500}
                  onChange={(event) => setCustomerMessage(event.target.value)}
                />
              </div>
              <button type="submit" className="et-button" disabled={busy || !decision}>
                Enregistrer la revue
              </button>
            </form>
          ) : (
            <p className="ops-ground-form ops-ground-form__hint">
              Aucune décision n’est possible sur une évaluation obsolète : réévaluez d’abord.
            </p>
          )}
        </div>
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

  const visible = items ?? [];
  const reviewRequiredCount = visible.filter((item) => item.status === 'REVIEW_REQUIRED').length;
  const staleCount = visible.filter(
    (item) => item.status === 'STALE' || item.status === 'NOT_EVALUATED',
  ).length;
  const needsInformationCount = visible.filter(
    (item) => item.status === 'NEEDS_INFORMATION',
  ).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-compliance-workspace"
      data-testid="compliance-reviews-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Conformité passagers</p>
          <h2>File de revue et décisions réglementaires</h2>
          <p>
            File de revue de conformité des voyageurs. Une évaluation obsolète et ses revues sont un
            historique : réévaluez avant toute décision. Aucune décision n’est possible sans motif.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Le résultat machine, le résultat de chaque règle et la décision humaine sont distincts.
        L’absence de règle publiée et vérifiée exige une revue : elle ne vaut jamais conformité.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {items ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des voyageurs affichés">
          <OpsKpiCard
            label="Voyageurs affichés"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Tous les voyageurs filtrés sont chargés'
            }
            icon="users"
            tone="info"
          />
          <OpsKpiCard
            label="Revues requises"
            value={reviewRequiredCount}
            helper="Aucune règle applicable ou constat à examiner"
            icon="review"
            tone={reviewRequiredCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="À évaluer ou réévaluer"
            value={staleCount}
            helper="Non évalués ou évaluations obsolètes"
            icon="audit"
            tone={staleCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Informations requises"
            value={needsInformationCount}
            helper="Pièce ou précision demandée au voyageur"
            icon="alert"
            tone={needsInformationCount > 0 ? 'warning' : 'neutral'}
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres voyageurs sont disponibles. Les indicateurs ne portent que
          sur les {items.length} voyageurs chargés.
        </p>
      ) : null}

      <form
        className="et-form et-network-form ops-ground-panel"
        aria-label="Filtrer la file de conformité"
        onSubmit={filter}
      >
        <p className="ops-operations-section-kicker">Filtres</p>
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

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="compliance-queue-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">File de revue</p>
            <h2 id="compliance-queue-title">Voyageurs</h2>
          </div>
        </div>
        {!items && !error ? <OpsLoadingState title="Chargement de la file…" /> : null}
        {items?.length === 0 ? (
          <OpsEmptyState
            title="Aucun voyageur pour ces filtres."
            description="Aucun dossier de conformité ne correspond aux filtres actuellement appliqués."
          />
        ) : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Conformité par voyageur et voyage</caption>
              <thead>
                <tr>
                  <th scope="col">Voyageur</th>
                  <th scope="col">Réservation · voyage</th>
                  <th scope="col">Départ</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Dossier</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={`${item.bookingReference}-${item.passenger.reference}`}
                    className={
                      item.evaluation && detail?.reference === item.evaluation.reference
                        ? 'ops-table-row--selected'
                        : undefined
                    }
                  >
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}
                      <br />
                      <span className="et-code">{item.passenger.reference}</span>
                    </td>
                    <td>
                      <span className="et-code">{item.bookingReference}</span>
                      <br />
                      <span className="et-code">{item.tripReference}</span>
                    </td>
                    <td>{formatAt(item.departureAt)}</td>
                    <td>
                      <OpsStatusBadge tone={STATUS_TONES[item.status]}>
                        {STATUS_LABELS[item.status]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      {item.evaluation ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          aria-controls="compliance-evaluation-detail-panel"
                          aria-label={`Examiner ${item.passenger.reference}`}
                          aria-expanded={detail?.reference === item.evaluation.reference}
                          onClick={() => void openEvaluation(item.evaluation!.reference)}
                        >
                          Examiner
                        </button>
                      ) : canReview ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          aria-label={`Évaluer ${item.passenger.reference}`}
                          disabled={busy}
                          onClick={() =>
                            void evaluate({
                              bookingReference: item.bookingReference,
                              passengerReference: item.passenger.reference,
                            })
                          }
                        >
                          Évaluer
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

      {detail ? (
        <OpsDetailRegion
          id="compliance-evaluation-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
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
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
