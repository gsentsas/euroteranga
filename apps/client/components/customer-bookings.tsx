'use client';

import {
  formatMoney,
  type CustomerBooking,
  type CustomerBookingStatus,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { auth } from '../lib/auth';
import { paymentTestEnvironment } from '../lib/env';
import { CustomerPaymentChoice } from './customer-payment-choice';

const STATUS_LABELS: Record<CustomerBookingStatus, string> = {
  HELD: 'Provisoire',
  CONFIRMED: 'Confirmée',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
};

/** How often PENDING attempts are re-read until the provider's result arrives. */
const PENDING_REFRESH_MS = 2_000;

function formatAt(value: string, timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(value));
  }
}

function stopName(booking: CustomerBooking, end: 'origin' | 'destination'): string {
  const stop = booking[end].stop;
  return stop ? `${stop.name} (${stop.locality})` : 'Arrêt inconnu';
}

/**
 * CUSTOMER-owned bookings only; ownership and every mutation are checked
 * again by the API. A HELD booking can be paid (the payer chooses a country
 * and a method, the server quotes the amount; no card or bank data is ever
 * asked here); a CONFIRMED one shows
 * its payment and can no longer be cancelled online (no refund yet).
 */
export function CustomerBookings() {
  const router = useRouter();
  const [bookings, setBookings] = useState<CustomerBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyReference, setBusyReference] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await auth.booking.customer.bookings({ limit: 50 });
    if (result.ok) {
      setBookings(result.data.items);
      return;
    }
    if (result.error.status === 401) router.replace('/connexion');
    else setError(result.error.message);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = bookings?.some((booking) => booking.payment?.status === 'PENDING') ?? false;
  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => void load(), PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, pending]);

  /** An attempt was started from a quote: show it PENDING until the provider answers. */
  const started = useCallback(
    async (paymentReference: string) => {
      await load();
      setNotice(`Paiement ${paymentReference} en attente de confirmation par le prestataire.`);
    },
    [load],
  );

  const cancelPayment = async (paymentReference: string, bookingReference: string) => {
    setBusyReference(bookingReference);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.cancelPayment(paymentReference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await load();
      setNotice(`Tentative de paiement ${paymentReference} annulée.`);
    } finally {
      setBusyReference(null);
    }
  };

  const cancel = async (reference: string) => {
    setBusyReference(reference);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.cancel(reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await load();
      setNotice(`Réservation ${reference} annulée. Les sièges sont de nouveau disponibles.`);
    } finally {
      setBusyReference(null);
    }
  };

  return (
    <section aria-labelledby="customer-bookings-title" data-testid="customer-bookings">
      <div className="et-actions">
        <h2 id="customer-bookings-title">Mes réservations</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        Une réservation provisoire retient vos sièges jusqu’à son expiration, sans paiement. Une
        réservation confirmée est payée ; elle ne constitue pas encore un billet.
      </p>
      {paymentTestEnvironment ? (
        <p className="et-tag" data-testid="payment-test-mode">
          Environnement de test : paiement simulé (SANDBOX), aucun débit réel.
        </p>
      ) : null}
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {!bookings ? <p role="status">Chargement de vos réservations…</p> : null}
      {bookings?.length === 0 ? <p>Vous n’avez aucune réservation.</p> : null}
      {bookings ? (
        <div className="et-booking-list">
          {bookings.map((booking) => {
            const active = booking.status === 'HELD';
            const payment = booking.payment;
            const paying = active && payment?.status === 'PENDING';
            return (
              <article
                key={booking.reference}
                className="et-customer-booking"
                aria-labelledby={`booking-${booking.reference}`}
              >
                <div className="et-actions">
                  <h3 id={`booking-${booking.reference}`} className="et-code">
                    {booking.reference}
                  </h3>
                  <span className="et-tag">{STATUS_LABELS[booking.status]}</span>
                </div>
                <dl className="et-booking-details">
                  <dt>Voyage</dt>
                  <dd>
                    {booking.trip.reference} · {booking.trip.route.code} — {booking.trip.route.name}
                  </dd>
                  <dt>Trajet</dt>
                  <dd>
                    {stopName(booking, 'origin')} → {stopName(booking, 'destination')}
                  </dd>
                  <dt>Départ</dt>
                  <dd>
                    {booking.origin.plannedDepartureAt
                      ? formatAt(booking.origin.plannedDepartureAt, booking.origin.stop?.timezone)
                      : '—'}
                  </dd>
                  <dt>Sièges</dt>
                  <dd>{booking.seats.map((seat) => seat.seatLabel ?? '—').join(', ')}</dd>
                  <dt>Prix unitaire</dt>
                  <dd>
                    {formatMoney(
                      booking.unitAmountMinor,
                      booking.currencyCode,
                      booking.currencyMinorUnit,
                    )}
                  </dd>
                  <dt>Total</dt>
                  <dd>
                    <strong>
                      {formatMoney(
                        booking.totalAmountMinor,
                        booking.currencyCode,
                        booking.currencyMinorUnit,
                      )}
                    </strong>{' '}
                    ({booking.seatCount} siège{booking.seatCount > 1 ? 's' : ''})
                  </dd>
                  {booking.status === 'CONFIRMED' && payment ? (
                    <>
                      <dt>Montant payé</dt>
                      <dd data-testid={`paid-amount-${booking.reference}`}>
                        <strong>
                          {payment.presentment &&
                          payment.presentment.currencyCode !== booking.currencyCode
                            ? `${formatMoney(
                                payment.presentment.amountMinor,
                                payment.presentment.currencyCode,
                                payment.presentment.currencyMinorUnit,
                              )} (soit ${formatMoney(
                                payment.amountMinor,
                                booking.currencyCode,
                                booking.currencyMinorUnit,
                              )})`
                            : formatMoney(
                                payment.amountMinor,
                                booking.currencyCode,
                                booking.currencyMinorUnit,
                              )}
                        </strong>
                      </dd>
                      <dt>Référence du paiement</dt>
                      <dd
                        className="et-code"
                        data-testid={`payment-reference-${booking.reference}`}
                      >
                        {payment.reference}
                      </dd>
                      <dt>Confirmée le</dt>
                      <dd>
                        {booking.confirmedAt
                          ? formatAt(booking.confirmedAt, booking.origin.stop?.timezone)
                          : '—'}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Expiration</dt>
                      <dd>{formatAt(booking.holdExpiresAt, booking.origin.stop?.timezone)}</dd>
                    </>
                  )}
                </dl>
                {paying && payment ? (
                  <div className="et-customer-booking-payment" role="status">
                    <p>
                      Paiement <span className="et-code">{payment.reference}</span> en attente de
                      confirmation par le prestataire de paiement.
                    </p>
                  </div>
                ) : null}
                {active ? (
                  <div className="et-actions">
                    {paying && payment ? (
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        disabled={busyReference === booking.reference}
                        onClick={() => void cancelPayment(payment.reference, booking.reference)}
                      >
                        Annuler la tentative de paiement {payment.reference}
                      </button>
                    ) : (
                      <CustomerPaymentChoice
                        booking={booking}
                        busy={busyReference === booking.reference}
                        onBusy={(busy) => setBusyReference(busy ? booking.reference : null)}
                        onStarted={started}
                        onError={setError}
                      />
                    )}
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      disabled={busyReference === booking.reference}
                      onClick={() => void cancel(booking.reference)}
                    >
                      Annuler la réservation {booking.reference}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
