'use client';

import {
  describePaymentQuote,
  PAYER_COUNTRY_OPTIONS,
  type CustomerBooking,
  type PayerCountryCode,
  type PaymentMethodCode,
  type PaymentOption,
  type PaymentQuote,
} from '@euroteranga/auth-client';
import { PaymentChoice } from '@euroteranga/ui';
import { useEffect, useRef, useState } from 'react';
import { auth } from '../lib/auth';

/**
 * PAY-HUB-1, for one HELD booking of “Mes réservations”: the payer's country
 * and method, the exact amount quoted by the server, then the attempt. The
 * idempotency key of the current intent stays in memory only.
 */
export function CustomerPaymentChoice({
  booking,
  busy,
  onBusy,
  onStarted,
  onError,
}: {
  booking: CustomerBooking;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onStarted: (paymentReference: string) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [country, setCountry] = useState<PayerCountryCode>('FR');
  const [methods, setMethods] = useState<PaymentOption[] | null>(null);
  const [method, setMethod] = useState<PaymentMethodCode | ''>('');
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const intent = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMethods(null);
    void auth.booking.customer.paymentOptions(booking.reference, country).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        onError(result.error.message);
        setMethods([]);
        return;
      }
      setMethods(result.data.methods);
      setMethod(result.data.methods.find((item) => item.available)?.code ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [booking.reference, country, onError]);

  const requestQuote = async () => {
    if (busy || !method) return;
    onBusy(true);
    onError(null);
    try {
      const result = await auth.booking.customer.createPaymentQuote(booking.reference, {
        payerCountry: country,
        paymentMethod: method,
      });
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      setQuote(result.data);
      intent.current = null;
    } finally {
      onBusy(false);
    }
  };

  const pay = async () => {
    if (busy || !quote) return;
    onBusy(true);
    onError(null);
    intent.current ??= crypto.randomUUID();
    try {
      const result = await auth.booking.customer.createPayment(
        booking.reference,
        { quoteId: quote.id, paymentMethod: quote.paymentMethod },
        intent.current,
      );
      // The same key only retries a request that may not have reached the API.
      if (result.ok || result.error.status !== 0) intent.current = null;
      if (!result.ok) {
        if (result.error.code.startsWith('PAYMENT_QUOTE_')) setQuote(null);
        onError(result.error.message);
        return;
      }
      setQuote(null);
      await onStarted(result.data.payment.reference);
    } finally {
      onBusy(false);
    }
  };

  return (
    <PaymentChoice
      bookingReference={booking.reference}
      continueLabel={`Continuer vers le paiement de ${booking.reference}`}
      countries={PAYER_COUNTRY_OPTIONS}
      country={country}
      onCountryChange={(code) => {
        setCountry(code as PayerCountryCode);
        setQuote(null);
      }}
      methods={methods}
      method={method}
      onMethodChange={(code) => setMethod(code as PaymentMethodCode)}
      quote={quote ? describePaymentQuote(quote) : null}
      busy={busy}
      onQuote={() => void requestQuote()}
      onPay={() => void pay()}
      onChange={() => setQuote(null)}
    />
  );
}
