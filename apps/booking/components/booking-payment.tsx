'use client';

import {
  describePaymentOption,
  describePaymentQuote,
  PAYER_COUNTRY_OPTIONS,
  paymentRedirectTarget,
  type CustomerBooking,
  type PayerCountryCode,
  type PaymentMethodCode,
  type PaymentOption,
  type PaymentQuote,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, PaymentChoice } from '@euroteranga/ui';
import { useEffect, useRef, useState } from 'react';
import { auth } from '../lib/auth';
import { paymentTestEnvironment } from '../lib/env';

/** How often a PENDING attempt is re-read until the provider's result arrives. */
const PENDING_REFRESH_MS = 2_000;

/**
 * Payment of a HELD booking. EURO TERANGA never asks for a card number, a
 * security code or an IBAN: the payer chooses a country and a method, the
 * server quotes the exact amount in that currency, and the result comes from
 * the payment provider. The idempotency key of the current intent stays in
 * memory, so a retried click cannot start a second attempt.
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
  const [country, setCountry] = useState<PayerCountryCode>('FR');
  const [methods, setMethods] = useState<PaymentOption[] | null>(null);
  const [method, setMethod] = useState<PaymentMethodCode | ''>('');
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
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

  useEffect(() => {
    if (pending) return undefined;
    let cancelled = false;
    setMethods(null);
    void auth.booking.customer.paymentOptions(booking.reference, country).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        setMethods([]);
        return;
      }
      setMethods(result.data.methods);
      setMethod(result.data.methods.find((item) => item.available)?.code ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [booking.reference, country, pending]);

  const requestQuote = async () => {
    if (busy || !method) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.booking.customer.createPaymentQuote(booking.reference, {
        payerCountry: country,
        paymentMethod: method,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setQuote(result.data);
      intent.current = null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy || !quote) return;
    setBusy(true);
    setError(null);
    intent.current ??= crypto.randomUUID();
    try {
      const result = await auth.booking.customer.createPayment(
        booking.reference,
        { quoteId: quote.id, paymentMethod: quote.paymentMethod },
        intent.current,
      );
      // Same key only to retry a request that may not have reached the API.
      if (result.ok || result.error.status !== 0) intent.current = null;
      if (!result.ok) {
        // An expired or used quote needs a new amount: back to the choice.
        if (result.error.code.startsWith('PAYMENT_QUOTE_')) setQuote(null);
        setError(result.error.message);
        return;
      }
      setQuote(null);
      // A hosted provider page (Stripe Checkout): the browser goes there to
      // pay. Coming back confirms nothing; the provider's signed event does.
      const target = paymentRedirectTarget(result.data.checkout);
      if (target) {
        window.location.assign(target);
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
        Le montant à régler est calculé par EURO TERANGA, dans la devise de votre pays de paiement.
        Nous ne vous demandons jamais votre numéro de carte, votre cryptogramme ou votre IBAN : le
        cas échéant, vous les saisissez sur la page sécurisée du prestataire de paiement.
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
        <PaymentChoice
          bookingReference={booking.reference}
          continueLabel="Continuer vers le paiement"
          countries={PAYER_COUNTRY_OPTIONS}
          country={country}
          onCountryChange={(code) => {
            setCountry(code as PayerCountryCode);
            setQuote(null);
          }}
          methods={methods?.map((item) => ({ ...item, ...describePaymentOption(item) })) ?? null}
          method={method}
          onMethodChange={(code) => setMethod(code as PaymentMethodCode)}
          quote={quote ? describePaymentQuote(quote) : null}
          busy={busy}
          onQuote={() => void requestQuote()}
          onPay={() => void start()}
          onChange={() => setQuote(null)}
        />
      )}
    </section>
  );
}
