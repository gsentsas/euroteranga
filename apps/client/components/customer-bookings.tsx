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

const STATUS_LABELS: Record<CustomerBookingStatus, string> = {
  HELD: 'Provisoire',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
};

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

/** CUSTOMER-owned holds only; ownership and every mutation are checked again by the API. */
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
        Les réservations affichées sont des retenues provisoires. Elles ne constituent ni un
        paiement ni un billet.
      </p>
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
                  <dt>Expiration</dt>
                  <dd>{formatAt(booking.holdExpiresAt, booking.origin.stop?.timezone)}</dd>
                </dl>
                {active ? (
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busyReference === booking.reference}
                    onClick={() => void cancel(booking.reference)}
                  >
                    Annuler la réservation {booking.reference}
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
