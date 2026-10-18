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
import { OpsDetailRegion } from '../ops-detail-region';
import { useCan } from '../staff-access';
import { BOOKING_STATUS_LABELS, formatInstant, PAYMENT_STATUS_LABELS } from './payment-format';

const EVENT_LABELS: Record<AdminPaymentDetail['events'][number]['type'], string> = {
  PAYMENT_SUCCEEDED: 'Succès signalé par le prestataire',
  PAYMENT_FAILED: 'Échec signalé par le prestataire',
};

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
        <span className="et-tag">{PAYMENT_STATUS_LABELS[payment.status]}</span>
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
          <button type="submit" className="et-button" disabled={busy || reason.trim().length < 3}>
            Annuler la tentative
          </button>
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.payments.listPayments({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.paymentReference ? { paymentReference: applied.paymentReference } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPayments((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied, status],
  );

  const loadDetail = useCallback(async (paymentId: string) => {
    const result = await auth.admin.payments.getPayment(paymentId);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
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

  return (
    <div className="et-network" data-testid="payments-workspace">
      <p>
        Consultez les tentatives de paiement des réservations. Le succès d’un paiement vient
        uniquement du prestataire de paiement (environnement de test SANDBOX dans cette version) :
        aucune action ne permet de marquer un paiement comme réussi.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form
        className="et-form et-network-form"
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

      <section aria-labelledby="admin-payments-title">
        <h2 id="admin-payments-title">Paiements</h2>
        {!payments ? <p role="status">Chargement des paiements…</p> : null}
        {payments ? (
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
                    <td>{PAYMENT_STATUS_LABELS[payment.status]}</td>
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
        {payments?.length === 0 ? <p>Aucun paiement.</p> : null}
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

      {selectedId && !detail ? <p role="status">Chargement du paiement…</p> : null}
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
