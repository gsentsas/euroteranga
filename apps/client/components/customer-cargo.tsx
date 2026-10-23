'use client';

import type {
  CustomerBooking,
  CustomerRoadFreightQuote,
  CustomerRoadFreightShipment,
  CustomerRoadFreightShipmentDetail,
  PublicRoadFreightTrackingStatus,
  RoadFreightDirection,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../lib/auth';

const DIRECTION_LABELS: Record<RoadFreightDirection, string> = {
  PAR_DKR: 'Paris → Dakar',
  DKR_PAR: 'Dakar → Paris',
};

const STATUS_LABELS: Record<PublicRoadFreightTrackingStatus, string> = {
  PREPARING: 'Préparation',
  RECEIVED: 'Pris en charge',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  AVAILABLE: 'Disponible',
  DELIVERED: 'Livré',
  ATTENTION: 'Vérification en cours',
  CANCELLED: 'Annulé',
};

function exactMoney(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  if (minorUnit === 0) return `${amount.toString()} ${currencyCode}`;
  const scale = 10n ** BigInt(minorUnit);
  const major = amount / scale;
  const minor = (amount % scale).toString().padStart(minorUnit, '0');
  return `${major.toString()},${minor} ${currencyCode}`;
}

function formatAt(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function quoteAmount(quote: CustomerRoadFreightQuote | null): string {
  return quote
    ? exactMoney(quote.totalMinor, quote.currencyCode, quote.currencyMinorUnit)
    : 'Devis en préparation';
}

export function CustomerCargo() {
  const router = useRouter();
  const [items, setItems] = useState<CustomerRoadFreightShipment[] | null>(null);
  const [bookings, setBookings] = useState<CustomerBooking[]>([]);
  const [detail, setDetail] = useState<CustomerRoadFreightShipmentDetail | null>(null);
  const [quotes, setQuotes] = useState<CustomerRoadFreightQuote[]>([]);
  const [direction, setDirection] = useState<RoadFreightDirection>('PAR_DKR');
  const [bookingReference, setBookingReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderContact, setSenderContact] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientContact, setRecipientContact] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [volumeLiters, setVolumeLiters] = useState('');
  const [packageCount, setPackageCount] = useState('1');
  const [declaredContents, setDeclaredContents] = useState('');
  const [fragile, setFragile] = useState(false);
  const [professional, setProfessional] = useState(false);
  const [pickupRequired, setPickupRequired] = useState(false);
  const [deliveryRequired, setDeliveryRequired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [cargoResult, bookingResult] = await Promise.all([
      auth.booking.customer.cargo.list({ limit: 50 }),
      auth.booking.customer.bookings({ limit: 50 }),
    ]);
    if (!cargoResult.ok) {
      if (cargoResult.error.status === 401) router.replace('/connexion');
      else setError(cargoResult.error.message);
      return;
    }
    setItems(cargoResult.data.items);
    if (bookingResult.ok) setBookings(bookingResult.data.items);
    else if (bookingResult.error.status === 401) router.replace('/connexion');
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (reference: string) => {
    setBusy(reference);
    setError(null);
    setNotice(null);
    try {
      const [detailResult, quoteResult] = await Promise.all([
        auth.booking.customer.cargo.detail(reference),
        auth.booking.customer.cargo.quotes(reference),
      ]);
      if (!detailResult.ok) {
        if (detailResult.error.status === 401) router.replace('/connexion');
        else setError(detailResult.error.message);
        return;
      }
      if (!quoteResult.ok) {
        setError(quoteResult.error.message);
        return;
      }
      setDetail(detailResult.data);
      setQuotes(quoteResult.data.items);
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.cargo.create({
        direction,
        ...(bookingReference ? { bookingReference } : {}),
        senderName,
        senderContact,
        recipientName,
        recipientContact,
        weightKg: weightKg.replace(',', '.'),
        volumeLiters: Number(volumeLiters),
        packageCount: Number(packageCount),
        declaredContents,
        fragile,
        professional,
        pickupRequired,
        deliveryRequired,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        `Demande ${result.data.reference} créée. L’équipe EURO TERANGA peut maintenant préparer votre devis.`,
      );
      setDetail(result.data);
      setQuotes([]);
      setDeclaredContents('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const accept = async (quote: CustomerRoadFreightQuote) => {
    if (!detail || busy) return;
    setBusy(quote.reference);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.booking.customer.cargo.acceptQuote(
        detail.reference,
        quote.reference,
        quote.updatedAt,
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await open(detail.reference);
      await load();
      setNotice(`Devis ${result.data.reference} accepté. Aucun paiement n’a été déclenché.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="customer-cargo-title" data-testid="customer-cargo">
      <div className="et-actions">
        <h2 id="customer-cargo-title">Mes colis</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        Créez une demande de colis ou de fret Paris ↔ Dakar, avec ou sans réservation passager. Le
        prix affiché ici provient uniquement d’un devis émis par EURO TERANGA.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      <form
        className="et-form et-passenger-form"
        aria-label="Créer une demande colis/fret"
        onSubmit={(event) => void create(event)}
      >
        <h3>Nouvelle demande</h3>
        <label>
          Sens
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value as RoadFreightDirection)}
          >
            <option value="PAR_DKR">Paris → Dakar</option>
            <option value="DKR_PAR">Dakar → Paris</option>
          </select>
        </label>
        <label>
          Réservation passager facultative
          <select
            value={bookingReference}
            onChange={(event) => setBookingReference(event.target.value)}
          >
            <option value="">Sans réservation passager</option>
            {bookings.map((booking) => (
              <option key={booking.reference} value={booking.reference}>
                {booking.reference} · {booking.trip.reference}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expéditeur
          <input
            required
            maxLength={160}
            value={senderName}
            onChange={(event) => setSenderName(event.target.value)}
          />
        </label>
        <label>
          Contact expéditeur
          <input
            required
            maxLength={200}
            value={senderContact}
            onChange={(event) => setSenderContact(event.target.value)}
          />
        </label>
        <label>
          Destinataire
          <input
            required
            maxLength={160}
            value={recipientName}
            onChange={(event) => setRecipientName(event.target.value)}
          />
        </label>
        <label>
          Contact destinataire
          <input
            required
            maxLength={200}
            value={recipientContact}
            onChange={(event) => setRecipientContact(event.target.value)}
          />
        </label>
        <label>
          Poids (kg)
          <input
            required
            inputMode="decimal"
            value={weightKg}
            onChange={(event) => setWeightKg(event.target.value)}
          />
        </label>
        <label>
          Volume (litres)
          <input
            required
            type="number"
            min={1}
            max={1_000_000}
            value={volumeLiters}
            onChange={(event) => setVolumeLiters(event.target.value)}
          />
        </label>
        <label>
          Nombre de pièces
          <input
            required
            type="number"
            min={1}
            max={9_999}
            value={packageCount}
            onChange={(event) => setPackageCount(event.target.value)}
          />
        </label>
        <label>
          Contenu déclaré
          <textarea
            required
            maxLength={500}
            value={declaredContents}
            onChange={(event) => setDeclaredContents(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={fragile}
            onChange={(event) => setFragile(event.target.checked)}
          />
          Envoi fragile
        </label>
        <label>
          <input
            type="checkbox"
            checked={professional}
            onChange={(event) => setProfessional(event.target.checked)}
          />
          Envoi professionnel
        </label>
        <label>
          <input
            type="checkbox"
            checked={pickupRequired}
            onChange={(event) => setPickupRequired(event.target.checked)}
          />
          Collecte souhaitée
        </label>
        <label>
          <input
            type="checkbox"
            checked={deliveryRequired}
            onChange={(event) => setDeliveryRequired(event.target.checked)}
          />
          Livraison souhaitée
        </label>
        <button type="submit" className="et-button" disabled={busy !== null}>
          Créer la demande
        </button>
      </form>

      {!items ? <p role="status">Chargement de vos colis…</p> : null}
      {items?.length === 0 ? <p>Vous n’avez encore aucune demande de colis ou de fret.</p> : null}
      {items && items.length > 0 ? (
        <div className="et-passenger-list" aria-label="Liste de mes colis">
          {items.map((item) => (
            <article
              key={item.reference}
              className="et-customer-booking"
              data-testid={`customer-cargo-${item.reference}`}
            >
              <div className="et-actions">
                <h3 className="et-code">{item.reference}</h3>
                <span className="et-tag">{STATUS_LABELS[item.status]}</span>
              </div>
              <p>
                {DIRECTION_LABELS[item.direction]} · {item.packageCount} pièce
                {item.packageCount > 1 ? 's' : ''} · {item.weightKg.replace('.', ',')} kg
              </p>
              <p>
                Prix : <strong>{quoteAmount(item.latestQuote)}</strong>
              </p>
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy !== null}
                onClick={() => void open(item.reference)}
              >
                Consulter {item.reference}
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {detail ? (
        <article className="et-customer-booking" data-testid="customer-cargo-detail">
          <div className="et-actions">
            <h3>{detail.reference}</h3>
            <span className="et-tag">{STATUS_LABELS[detail.status]}</span>
          </div>
          <dl className="et-booking-details">
            <dt>Trajet</dt>
            <dd>
              {detail.trip
                ? `${detail.trip.route.name} · ${formatAt(detail.trip.plannedDepartureAt)}`
                : DIRECTION_LABELS[detail.direction]}
            </dd>
            <dt>Expéditeur</dt>
            <dd>
              {detail.sender.name} · {detail.sender.contact}
            </dd>
            <dt>Destinataire</dt>
            <dd>
              {detail.recipient.name} · {detail.recipient.contact}
            </dd>
            <dt>Poids</dt>
            <dd>{detail.weightKg.replace('.', ',')} kg</dd>
            <dt>Volume</dt>
            <dd>{detail.volumeLiters} L</dd>
            <dt>Pièces</dt>
            <dd>{detail.packageCount}</dd>
            <dt>Contenu déclaré</dt>
            <dd>{detail.declaredContents}</dd>
            <dt>Documents nécessaires</dt>
            <dd>
              Les pièces éventuelles sont confirmées par l’équipe selon la nature de l’envoi, le
              sens du trajet et les formalités applicables.
            </dd>
          </dl>

          <h4>Suivi</h4>
          {detail.timeline.length === 0 ? (
            <p>Aucune étape enregistrée.</p>
          ) : (
            <ol className="et-document-list" aria-label={`Suivi du colis ${detail.reference}`}>
              {detail.timeline.map((event) => (
                <li key={event.sequence}>
                  <span>
                    {formatAt(event.occurredAt)} — {STATUS_LABELS[event.status]}
                  </span>
                  {event.location ? (
                    <span className="et-tag">
                      {event.location.name} ({event.location.code})
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          <h4>Devis</h4>
          {quotes.length === 0 ? <p>Aucun devis n’a encore été émis.</p> : null}
          {quotes.map((quote) => (
            <div
              key={quote.reference}
              className="et-customer-booking"
              data-testid={`customer-cargo-quote-${quote.reference}`}
            >
              <div className="et-actions">
                <strong className="et-code">{quote.reference}</strong>
                <span className="et-tag">{quote.status}</span>
              </div>
              <p>
                Total :{' '}
                <strong>
                  {exactMoney(quote.totalMinor, quote.currencyCode, quote.currencyMinorUnit)}
                </strong>
              </p>
              <ul>
                {quote.lines.map((line) => (
                  <li key={`${quote.reference}-${line.position}`}>
                    {line.label} — {line.kind === 'DISCOUNT' ? '−' : ''}
                    {exactMoney(line.amountMinor, quote.currencyCode, quote.currencyMinorUnit)}
                  </li>
                ))}
              </ul>
              {quote.status === 'ISSUED' ? (
                <>
                  <p>Accepter ce devis ne déclenche aucun paiement.</p>
                  <button
                    type="button"
                    className="et-button"
                    disabled={busy !== null}
                    onClick={() => void accept(quote)}
                  >
                    Accepter le devis {quote.reference}
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </article>
      ) : null}
    </section>
  );
}
