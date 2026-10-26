'use client';

import {
  formatMoney,
  type AdminPayment,
  type AdminPaymentDetail,
  type PaymentStatus,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { OpsEmptyState, OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { BOOKING_STATUS_LABELS, formatInstant, PAYMENT_STATUS_LABELS } from './payment-format';

const EVENT_LABELS: Record<AdminPaymentDetail['events'][number]['type'], string> = {
  PAYMENT_SUCCEEDED: 'Succès signalé par le prestataire',
  PAYMENT_FAILED: 'Échec signalé par le prestataire',
};

function paymentStatusTone(
  status: PaymentStatus,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'PENDING':
      return 'warning';
    case 'SUCCEEDED':
      return 'success';
    case 'FAILED':
      return 'danger';
    case 'CANCELLED':
      return 'neutral';
  }
}

function PaymentDetail({
  payment,
  canManage,
  busy,
  onCancel,
}: {
  payment: AdminPaymentDetail;
  canManage: boolean;
  busy: boolean;
  onCancel: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onCancel(reason);
    setReason('');
  };
  return (
    <section
      className="et-network-panel"
      aria-labelledby={`admin-payment-${payment.id}`}
      data-testid="payment-detail"
    >
      <div className="et-actions">
        <h2 id={`admin-payment-${payment.id}`}>Paiement {payment.reference}</h2>
        <OpsStatusBadge tone={paymentStatusTone(payment.status)}>
          {PAYMENT_STATUS_LABELS[payment.status]}
        </OpsStatusBadge>
      </div>
      <dl className="et-booking-admin-summary">
        <dt>Réservation</dt>
        <dd>
          <span className="et-code">{payment.booking.reference}</span> ·{' '}
          {BOOKING_STATUS_LABELS[payment.booking.status]}
        </dd>
        <dt>Montant</dt>
        <dd>
          <strong>
            {formatMoney(payment.amountMinor, payment.currencyCode, payment.currencyMinorUnit)}
          </strong>
        </dd>
        <dt>Devise</dt>
        <dd>{payment.currencyCode}</dd>
        <dt>Prestataire</dt>
        <dd>
          {payment.provider} (test){' '}
          {payment.providerPaymentId ? (
            <span className="et-code">{payment.providerPaymentId}</span>
          ) : null}
        </dd>
        {payment.failureCode ? (
          <>
            <dt>Code d’échec</dt>
            <dd className="et-code">{payment.failureCode}</dd>
          </>
        ) : null}
        <dt>Identité client</dt>
        <dd className="et-code">{payment.customerIdentityId}</dd>
      </dl>
      <h3>Chronologie</h3>
      <ol className="et-payment-timeline" data-testid="payment-timeline">
        <li>Créé le {formatInstant(payment.createdAt)}</li>
        {payment.events.map((event) => (
          <li key={event.id}>
            {EVENT_LABELS[event.type]} le {formatInstant(event.receivedAt)}
            {event.processedAt ? ' — appliqué' : ` — non appliqué (${event.rejectionCode ?? '—'})`}
          </li>
        ))}
        {payment.succeededAt ? <li>Réussi le {formatInstant(payment.succeededAt)}</li> : null}
        {payment.failedAt ? <li>Échoué le {formatInstant(payment.failedAt)}</li> : null}
        {payment.cancelledAt ? <li>Annulé le {formatInstant(payment.cancelledAt)}</li> : null}
      </ol>
      {canManage && payment.status === 'PENDING' ? (
        <form
          className="et-form"
          aria-label={`Annuler la tentative ${payment.reference}`}
          onSubmit={submit}
        >
          <TextField
            label="Motif de l’annulation"
            name="reason"
            value={reason}
            onChange={setReason}
            autoComplete="off"
            maxLength={500}
          />
          <OpsConfirmSubmit
            actionLabel="Annuler la tentative"
            confirmLabel="Confirmer l’annulation"
            title={`Confirmer l’annulation de la tentative ${payment.reference}`}
            description="La tentative en attente sera abandonnée. Cette action ne peut jamais la marquer comme réussie."
            disabled={busy || reason.trim().length < 3}
          />
        </form>
      ) : null}
    </section>
  );
}

/**
 * payment.read list/detail. payment.manage only adds giving up a PENDING
 * attempt: a success only ever comes from the payment provider.
 */
export function PaymentsAdmin() {
  const canManage = useCan('payment.manage');
  const statusId = useId();
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [bookingReference, setBookingReference] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [applied, setApplied] = useState({ bookingReference: '', paymentReference: '' });
  const [payments, setPayments] = useState<AdminPayment[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminPaymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setLoadError(null);
      if (!cursor) setPayments(null);
      const result = await auth.admin.payments.listPayments({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.paymentReference ? { paymentReference: applied.paymentReference } : {}),
      });
      if (!result.ok) {
        setLoadError(result.error.message);
        return;
      }
      setLoadError(null);
      setPayments((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied, status],
  );

  const loadDetail = useCallback(async (paymentId: string) => {
    setDetail(null);
    setDetailError(null);
    const result = await auth.admin.payments.getPayment(paymentId);
    if (result.ok) setDetail(result.data);
    else setDetailError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setDetail(null);
      setDetailError(null);
    }
  }, [loadDetail, selectedId]);

  const cancel = async (reason: string) => {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.payments.cancelPayment(detail.id, reason);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDetail(result.data);
      await load();
      setNotice(`Tentative ${result.data.reference} annulée.`);
    } finally {
      setBusy(false);
    }
  };

  const visiblePayments = payments ?? [];
  const pendingCount = visiblePayments.filter((payment) => payment.status === 'PENDING').length;
  const succeededCount = visiblePayments.filter((payment) => payment.status === 'SUCCEEDED').length;
  const failedOrCancelledCount = visiblePayments.filter(
    (payment) => payment.status === 'FAILED' || payment.status === 'CANCELLED',
  ).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-payments-workspace"
      data-testid="payments-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Encaissement & prestataires</p>
          <h2>Suivi des paiements</h2>
          <p>
            Consultez les tentatives de paiement des réservations. Le succès d’un paiement vient
            uniquement du prestataire de paiement (environnement de test SANDBOX dans cette version)
            : aucune action ne permet de marquer un paiement comme réussi.
          </p>
        </div>
      </div>

      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {payments ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des paiements">
          <OpsKpiCard
            label="Tentatives affichées"
            value={visiblePayments.length}
            helper={nextCursor ? 'Liste partielle · autres paiements disponibles' : 'Liste chargée'}
            icon="payment"
            tone="info"
          />
          <OpsKpiCard
            label="En attente"
            value={pendingCount}
            helper="Confirmation provider attendue"
            icon="audit"
            tone={pendingCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Réussies"
            value={succeededCount}
            helper="Succès reçus du prestataire"
            icon="check"
            tone="success"
          />
          <OpsKpiCard
            label="Échecs / annulées"
            value={failedOrCancelledCount}
            helper="Tentatives non abouties"
            icon="alert"
            tone={failedOrCancelledCount > 0 ? 'danger' : 'neutral'}
          />
        </section>
      ) : null}

      <form
        className="et-form et-network-form ops-payments-filter"
        aria-label="Filtrer les paiements"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({
            bookingReference: bookingReference.trim().toUpperCase(),
            paymentReference: paymentReference.trim().toUpperCase(),
          });
        }}
      >
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={statusId}>Statut</label>
            <select
              id={statusId}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as PaymentStatus | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatus[]).map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Référence de réservation"
            name="bookingReference"
            value={bookingReference}
            onChange={setBookingReference}
            autoComplete="off"
            required={false}
            maxLength={16}
          />
          <TextField
            label="Référence de paiement"
            name="paymentReference"
            value={paymentReference}
            onChange={setPaymentReference}
            autoComplete="off"
            required={false}
            maxLength={16}
          />
        </div>
        <button type="submit" className="et-button et-button--secondary">
          Appliquer les filtres
        </button>
      </form>

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="admin-payments-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Journal des tentatives</p>
            <h2 id="admin-payments-title">Paiements</h2>
          </div>
        </div>
        {!payments && !loadError ? <OpsLoadingState title="Chargement des paiements" /> : null}
        {!payments && loadError ? (
          <OpsErrorState
            title="Impossible de charger les paiements"
            message={loadError}
            onRetry={() => void load()}
          />
        ) : null}
        {payments && payments.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Tentatives de paiement</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Réservation</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Montant</th>
                  <th scope="col">Devise</th>
                  <th scope="col">Créé le</th>
                  <th scope="col">Réussi le</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className={selectedId === payment.id ? 'ops-table-row--selected' : undefined}
                  >
                    <th scope="row" className="et-code">
                      {payment.reference}
                    </th>
                    <td className="et-code">{payment.booking.reference}</td>
                    <td>
                      <OpsStatusBadge tone={paymentStatusTone(payment.status)}>
                        {PAYMENT_STATUS_LABELS[payment.status]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      {formatMoney(
                        payment.amountMinor,
                        payment.currencyCode,
                        payment.currencyMinorUnit,
                      )}
                    </td>
                    <td>{payment.currencyCode}</td>
                    <td>{formatInstant(payment.createdAt)}</td>
                    <td>{formatInstant(payment.succeededAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter le paiement ${payment.reference}`}
                        aria-controls="payment-detail-panel"
                        aria-expanded={selectedId === payment.id && Boolean(detail)}
                        onClick={() => setSelectedId(payment.id)}
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
        {payments?.length === 0 ? (
          <OpsEmptyState
            title="Aucun paiement"
            description="Aucune tentative ne correspond aux filtres actuellement appliqués."
          />
        ) : null}
        {payments && loadError ? (
          <OpsErrorState
            title="Impossible d’actualiser les paiements"
            message={loadError}
            onRetry={() => void load(nextCursor ?? undefined)}
          />
        ) : null}
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

      {selectedId && !detail && !detailError ? (
        <OpsLoadingState title="Chargement du paiement" />
      ) : null}
      {selectedId && detailError ? (
        <OpsErrorState
          title="Impossible d’ouvrir ce paiement"
          message={detailError}
          onRetry={() => void loadDetail(selectedId)}
        />
      ) : null}
      {detail ? (
        <OpsDetailRegion
          id="payment-detail-panel"
          focusKey={selectedId}
          onClose={() => setSelectedId(null)}
        >
          <PaymentDetail payment={detail} canManage={canManage} busy={busy} onCancel={cancel} />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
