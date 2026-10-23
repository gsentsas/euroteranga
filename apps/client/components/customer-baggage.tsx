'use client';

import type {
  Baggage,
  BaggageDetail,
  BaggageEventType,
  BaggageExceptionStatus,
  BaggageLifecycleStatus,
  BaggageType,
  Passenger,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../lib/auth';

export const BAGGAGE_TYPE_LABELS: Record<BaggageType, string> = {
  SUITCASE: 'Valise',
  TRAVEL_BAG: 'Sac de voyage',
  BOX: 'Carton',
  OTHER: 'Autre bagage',
};

export const BAGGAGE_STATUS_LABELS: Record<BaggageLifecycleStatus, string> = {
  REGISTERED: 'Enregistré',
  CHECKED_IN: 'Pris en charge',
  LOADED: 'Chargé',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  DELIVERED: 'Remis',
  REMOVED: 'Retiré',
};

export const BAGGAGE_EXCEPTION_LABELS: Record<BaggageExceptionStatus, string> = {
  MISSING: 'Introuvable',
  DAMAGED: 'Endommagé',
  HELD_BY_CUSTOMS: 'Retenu en douane',
};

const EVENT_LABELS: Record<BaggageEventType, string> = {
  ...BAGGAGE_STATUS_LABELS,
  ...BAGGAGE_EXCEPTION_LABELS,
  WEIGHT_UPDATED: 'Pesée',
  EXCEPTION_RESOLVED: 'Incident résolu',
};

/** Exact display of the API decimal string: no Number conversion. */
export function formatWeightKg(value: string | null): string {
  return value === null ? 'Non pesé' : `${value.replace('.', ',')} kg`;
}


function formatExactMoney(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  if (minorUnit === 0) return `${amount.toString()} ${currencyCode}`;
  const scale = 10n ** BigInt(minorUnit);
  const major = amount / scale;
  const minor = (amount % scale).toString().padStart(minorUnit, '0');
  return `${major.toString()},${minor} ${currencyCode}`;
}

function AllowanceSummary({ item }: { item: Baggage }) {
  const allowance = item.allowance;
  if (allowance.status === 'NOT_CONFIGURED' || !allowance.policy) {
    return <p>Franchise bagage non configurée pour cette tarification historique.</p>;
  }

  const piece = allowance.pieceOrdinal ?? 0;
  const includedPiece = piece > 0 && piece <= allowance.policy.includedPieces;
  const base = (
    <>
      Franchise <strong>{allowance.policy.name}</strong> : pièce {piece} ·{' '}
      {includedPiece
        ? `jusqu’à ${formatWeightKg(allowance.policy.includedWeightKgPerPiece)} inclus`
        : 'bagage additionnel hors nombre de pièces incluses'}
      .
    </>
  );

  if (allowance.status === 'PENDING_WEIGHT') {
    return (
      <p>
        {base} Le supplément éventuel sera déterminé après la pesée officielle.
      </p>
    );
  }
  if (allowance.status === 'INCLUDED') {
    return (
      <p>
        {base} <strong>Aucun supplément bagage.</strong>
      </p>
    );
  }
  if (allowance.status === 'EXCESS_UNPRICED') {
    return (
      <p>
        {base} Excédent : {formatWeightKg(allowance.excessWeightKg)}.{' '}
        <strong>Tarif à confirmer par EURO TERANGA.</strong>
      </p>
    );
  }

  return (
    <p>
      {base} Excédent : {formatWeightKg(allowance.excessWeightKg)}. Supplément calculé :{' '}
      <strong>
        {allowance.excessCharge
          ? formatExactMoney(
              allowance.excessCharge.amountMinor,
              allowance.excessCharge.currencyCode,
              allowance.excessCharge.currencyMinorUnit,
            )
          : '—'}
      </strong>
      . Aucun paiement n’est déclenché depuis cet écran.
    </p>
  );
}

interface PassengerChoice {
  bookingReference: string;
  passenger: Passenger;
}

function BaggageCard({ item }: { item: Baggage }) {
  const [detail, setDetail] = useState<BaggageDetail | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showHistory = async () => {
    setError(null);
    const result = await auth.booking.customer.baggage(item.reference);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const showQr = async () => {
    setError(null);
    const result = await auth.booking.customer.baggageQr(item.reference);
    // The SVG is rendered as an image, never injected as markup.
    if (result.ok) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.svg)}`);
    else setError(result.error.message);
  };

  return (
    <article className="et-customer-booking" data-testid={`baggage-${item.reference}`}>
      <div className="et-actions">
        <h4>{item.reference}</h4>
        <span className="et-tag">{BAGGAGE_STATUS_LABELS[item.lifecycleStatus]}</span>
        {item.exceptionStatus ? (
          <span className="et-tag">{BAGGAGE_EXCEPTION_LABELS[item.exceptionStatus]}</span>
        ) : null}
      </div>
      <p>
        {BAGGAGE_TYPE_LABELS[item.type]} de {item.passenger.givenName} {item.passenger.familyName}
        {' — '}poids mesuré : {formatWeightKg(item.measuredWeightKg)}
      </p>
      <AllowanceSummary item={item} />
      <FormAlert message={error} />
      <div className="et-actions">
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void showQr()}
        >
          Afficher le QR code
        </button>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void showHistory()}
        >
          Voir l’historique
        </button>
      </div>
      {qr ? (
        <figure className="et-baggage-qr">
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URI */}
          <img src={qr} alt={`QR code du bagage ${item.reference}`} width={180} height={180} />
          <figcaption>
            Ce code identifie seulement le bagage {item.reference}. Il ne donne aucun droit.
          </figcaption>
        </figure>
      ) : null}
      {detail ? (
        <ol className="et-document-list" aria-label={`Historique du bagage ${item.reference}`}>
          {detail.events.map((event) => (
            <li key={event.sequence}>
              <span>
                {new Date(event.occurredAt).toLocaleString('fr-FR')} — {EVENT_LABELS[event.type]}
                {event.type === 'WEIGHT_UPDATED'
                  ? ` (${formatWeightKg(event.measuredWeightKg)})`
                  : ''}
              </span>
              {event.location ? (
                <span className="et-tag">
                  {event.location.name} ({event.location.code})
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

/**
 * CUSTOMER baggage pre-registration on an owned confirmed booking. The
 * server derives the BookingPassenger and the journey; only STAFF weigh bags.
 */
export function CustomerBaggage() {
  const router = useRouter();
  const [choices, setChoices] = useState<PassengerChoice[]>([]);
  const [bags, setBags] = useState<Record<string, Baggage[]> | null>(null);
  const [subject, setSubject] = useState('');
  const [type, setType] = useState<BaggageType>('SUITCASE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const bookingResult = await auth.booking.customer.bookings({ limit: 50 });
    if (!bookingResult.ok) {
      if (bookingResult.error.status === 401) router.replace('/connexion');
      else setError(bookingResult.error.message);
      return;
    }
    const confirmed = bookingResult.data.items.filter((booking) => booking.status === 'CONFIRMED');
    const loaded = await Promise.all(
      confirmed.map(async (booking) => {
        const [passengers, baggage] = await Promise.all([
          auth.booking.customer.passengers(booking.reference),
          auth.booking.customer.baggageForBooking(booking.reference),
        ]);
        return {
          bookingReference: booking.reference,
          passengers: passengers.ok ? passengers.data.items : [],
          baggage: baggage.ok ? baggage.data.items : [],
        };
      }),
    );
    const nextChoices = loaded.flatMap((entry) =>
      entry.passengers.map((passenger) => ({
        bookingReference: entry.bookingReference,
        passenger,
      })),
    );
    setChoices(nextChoices);
    setBags(Object.fromEntries(loaded.map((entry) => [entry.bookingReference, entry.baggage])));
    setSubject((current) => {
      if (current) return current;
      const first = nextChoices[0];
      return first ? `${first.bookingReference}|${first.passenger.reference}` : '';
    });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const [bookingReference, passengerReference] = subject.split('|');
    if (!bookingReference || !passengerReference) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.registerBaggage(
        bookingReference,
        passengerReference,
        { type },
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(`Bagage ${result.data.reference} enregistré.`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="customer-baggage-title" data-testid="customer-baggage">
      <div className="et-actions">
        <h2 id="customer-baggage-title">Mes bagages</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        Déclarez vos bagages avant le départ. La franchise applicable est figée au moment de
        l’enregistrement du bagage à partir de la tarification historique de la réservation. Le
        poids officiel est mesuré par l’équipe EURO TERANGA ; un supplément éventuel est alors
        calculé selon les paliers configurés. Aucun paiement n’est déclenché depuis cet espace.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {choices.length > 0 ? (
        <form className="et-form et-passenger-form" onSubmit={(event) => void register(event)}>
          <label>
            Voyageur et réservation
            <select value={subject} onChange={(event) => setSubject(event.target.value)} required>
              {choices.map(({ bookingReference, passenger }) => (
                <option
                  key={`${bookingReference}|${passenger.reference}`}
                  value={`${bookingReference}|${passenger.reference}`}
                >
                  {passenger.givenName} {passenger.familyName} — {bookingReference}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type de bagage
            <select value={type} onChange={(event) => setType(event.target.value as BaggageType)}>
              {(Object.keys(BAGGAGE_TYPE_LABELS) as BaggageType[]).map((value) => (
                <option key={value} value={value}>
                  {BAGGAGE_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="et-button" disabled={busy}>
            Enregistrer le bagage
          </button>
        </form>
      ) : bags ? (
        <p>Ajoutez un voyageur à une réservation confirmée pour déclarer un bagage.</p>
      ) : (
        <p role="status">Chargement des bagages…</p>
      )}
      {bags
        ? Object.entries(bags).map(([bookingReference, items]) =>
            items.length === 0 ? null : (
              <div key={bookingReference} className="et-passenger-list">
                <h3>Réservation {bookingReference}</h3>
                {items.map((item) => (
                  <BaggageCard key={item.reference} item={item} />
                ))}
              </div>
            ),
          )
        : null}
    </section>
  );
}
