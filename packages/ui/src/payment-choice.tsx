'use client';

import { useId } from 'react';

export interface PaymentChoiceMethod {
  code: string;
  label: string;
  available: boolean;
  /** Card networks accepted, as labels (badges of the card option, never choices). */
  acceptedNetworks?: readonly string[];
  /** A wallet the provider's page may add on an eligible device; never a promise. */
  deviceWalletsHint?: string | null;
}

/** The quote shown before paying: what the payer will be asked for, until when. */
export interface PaymentChoiceQuote {
  /** Formatted amount in the payer's currency, e.g. "163 333 XOF". */
  amount: string;
  /** Formatted booking total when the currency differs, e.g. "249,00 EUR". */
  bookingAmount: string | null;
  /** Formatted end of validity, e.g. "14:32". */
  validUntil: string;
}

export interface PaymentChoiceProps {
  /** Distinguishes several bookings on one page (accessible names). */
  bookingReference: string;
  /** Accessible name of the first step's button. */
  continueLabel: string;
  countries: ReadonlyArray<{ code: string; label: string }>;
  country: string;
  onCountryChange: (code: string) => void;
  /** Null while the options load. */
  methods: readonly PaymentChoiceMethod[] | null;
  method: string;
  onMethodChange: (code: string) => void;
  quote: PaymentChoiceQuote | null;
  busy: boolean;
  /** Step 1: ask the server for the exact amount (a quote; takes no money). */
  onQuote: () => void;
  /** Step 2: start the payment of that quote. */
  onPay: () => void;
  /** Back to step 1 (another country or method). */
  onChange: () => void;
}

/**
 * PAY-HUB-1: the payer's country and method, then the exact amount in their
 * currency before anything starts. Methods nobody can collect right now are
 * listed but disabled: a method is never silently replaced by another one.
 * A card option shows the networks its provider accepts (PAY-EU-1), as
 * information only. The component collects no card, account or phone data.
 */
export function PaymentChoice({
  bookingReference,
  continueLabel,
  countries,
  country,
  onCountryChange,
  methods,
  method,
  onMethodChange,
  quote,
  busy,
  onQuote,
  onPay,
  onChange,
}: PaymentChoiceProps) {
  const id = useId();
  const anyAvailable = methods?.some((item) => item.available) ?? false;
  const selected = methods?.find((item) => item.code === method);
  if (quote) {
    return (
      <div className="et-payment-choice" data-testid="payment-quote">
        <p>
          Montant à payer : <strong data-testid="payment-quote-amount">{quote.amount}</strong>
          {quote.bookingAmount ? <> (soit {quote.bookingAmount})</> : null}, valable jusqu’à{' '}
          {quote.validUntil}.
        </p>
        <div className="et-actions">
          <button
            type="button"
            className="et-button"
            disabled={busy}
            aria-busy={busy || undefined}
            // The accessible name starts with the visible label (WCAG 2.5.3),
            // then names the booking when a page lists several.
            aria-label={`Confirmer le paiement de ${quote.amount} pour ${bookingReference}`}
            onClick={onPay}
          >
            Confirmer le paiement de {quote.amount}
          </button>
          <button
            type="button"
            className="et-button et-button--secondary"
            disabled={busy}
            onClick={onChange}
          >
            Changer de moyen de paiement
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="et-payment-choice">
      <div className="et-field">
        <label htmlFor={`${id}-country`}>Pays du payeur</label>
        <select
          id={`${id}-country`}
          className="et-input"
          value={country}
          disabled={busy}
          onChange={(event) => onCountryChange(event.target.value)}
        >
          {countries.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="et-field">
        <label htmlFor={`${id}-method`}>Moyen de paiement</label>
        <select
          id={`${id}-method`}
          className="et-input"
          value={method}
          disabled={busy || !methods}
          onChange={(event) => onMethodChange(event.target.value)}
        >
          {(methods ?? []).map((item) => (
            <option key={item.code} value={item.code} disabled={!item.available}>
              {item.available ? item.label : `${item.label} (indisponible)`}
            </option>
          ))}
        </select>
      </div>
      {selected?.available && selected.acceptedNetworks?.length ? (
        <p className="et-hint" data-testid="payment-card-networks">
          Cartes acceptées : {selected.acceptedNetworks.join(', ')}.
        </p>
      ) : null}
      {selected?.available && selected.deviceWalletsHint ? (
        <p className="et-hint" data-testid="payment-device-wallets">
          {selected.deviceWalletsHint}
        </p>
      ) : null}
      {methods && !anyAvailable ? (
        <p className="et-hint">
          Aucun moyen de paiement n’est disponible pour ce pays pour le moment.
        </p>
      ) : null}
      <button
        type="button"
        className="et-button"
        disabled={busy || !anyAvailable || !method}
        aria-busy={busy || undefined}
        aria-label={continueLabel}
        onClick={onQuote}
      >
        Continuer vers le paiement
      </button>
    </div>
  );
}
