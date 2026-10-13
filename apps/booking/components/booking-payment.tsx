'use client';

import type { CustomerBooking } from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useEffect, useRef, useState } from 'react';
import { auth } from '../lib/auth';
import { paymentTestEnvironment } from '../lib/env';

/** How often a PENDING attempt is re-read until the provider's result arrives. */
const PENDING_REFRESH_MS = 2_000;

/**
 * Payment of a HELD booking. EURO TERANGA never asks for a card number, a
 * security code or an IBAN: the amount comes from the server and the result
 * from the payment provider. The idempotency key of the current intent stays
 * in memory, so a retried click cannot start a second attempt.
 */
export function BookingPayment({
  booking,
  onBooking,
}: {
  booking: CustomerBooking;
  onBooking: (booking: CustomerBooking) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<string | null>(null);
  const pending = booking.payment?.status === 'PENDING';

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(() => {
      void auth.booking.customer.booking(booking.reference).then((result) => {
        if (result.ok) onBooking(result.data);
      });
    }, PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [booking.reference, onBooking, pending]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    intent.current ??= crypto.randomUUID();
    try {
      const result = await auth.booking.customer.createPayment(booking.reference, intent.current);
      // Same key only to retry a request that may not have reached the API.
      if (result.ok || result.error.status !== 0) intent.current = null;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const refreshed = await auth.booking.customer.booking(booking.reference);
      if (refreshed.ok) onBooking(refreshed.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="et-booking-payment"
      aria-labelledby="booking-payment-title"
      data-testid="booking-payment"
    >
      <h3 id="booking-payment-title">Paiement</h3>
      {paymentTestEnvironment ? (
        <p className="et-tag" data-testid="payment-test-mode">
          Environnement de test : paiement simulé (SANDBOX), aucun débit réel.
        </p>
      ) : null}
      <p>
        Le montant à régler est le total ci-dessus, calculé par EURO TERANGA. Nous ne vous demandons
        jamais votre numéro de carte, votre cryptogramme ou votre IBAN.
      </p>
      <FormAlert message={error} />
      {pending && booking.payment ? (
        <FormStatus>
          <p>
            Paiement <span className="et-code">{booking.payment.reference}</span> en attente de
            confirmation par le prestataire de paiement.
          </p>
        </FormStatus>
      ) : (
        <button
          type="button"
          className="et-button"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void start()}
        >
          Continuer vers le paiement
        </button>
      )}
    </section>
  );
}
