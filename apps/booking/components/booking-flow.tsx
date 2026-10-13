'use client';

import {
  formatMoney,
  multiplyAmountMinor,
  type BookingAvailability,
  type BookingSearchResult,
  type CustomerBooking,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../lib/auth';
import { clientAppUrl } from '../lib/env';
import { CustomerLogin } from './customer-login';
import { formatAt, seatsLabel, stopLabel } from './format';
import { SeatMapPicker } from './seat-map';
import { StopPicker } from './stop-picker';

function utcDayRange(date: string): { departureFrom: string; departureTo: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const departureFrom = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(departureFrom.getTime())) return null;
  const departureTo = new Date(departureFrom);
  departureTo.setUTCDate(departureTo.getUTCDate() + 1);
  return { departureFrom: departureFrom.toISOString(), departureTo: departureTo.toISOString() };
}

function HoldConfirmation({
  booking,
  onRestart,
}: {
  booking: CustomerBooking;
  onRestart: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = booking.status === 'EXPIRED' || new Date(booking.holdExpiresAt).getTime() <= now;
  return (
    <section className="et-booking-confirmation" aria-labelledby="booking-confirmation-title">
      <h2 id="booking-confirmation-title">Réservation provisoire</h2>
      {expired ? (
        <div className="et-alert" role="alert">
          Cette réservation provisoire a expiré. Les sièges ne sont plus retenus.
        </div>
      ) : (
        <FormStatus>
          <p>
            Vos sièges sont retenus jusqu’au{' '}
            <strong>{formatAt(booking.holdExpiresAt, booking.origin.stop)}</strong>.
          </p>
        </FormStatus>
      )}
      <dl className="et-booking-summary">
        <dt>Référence</dt>
        <dd>
          <strong className="et-code" data-testid="booking-reference">
            {booking.reference}
          </strong>
        </dd>
        <dt>Voyage</dt>
        <dd>
          {booking.trip.reference} · {booking.trip.route.code} — {booking.trip.route.name}
        </dd>
        <dt>Origine</dt>
        <dd>
          {stopLabel(booking.origin.stop)} ·{' '}
          {formatAt(booking.origin.plannedDepartureAt, booking.origin.stop)}
        </dd>
        <dt>Destination</dt>
        <dd>
          {stopLabel(booking.destination.stop)} ·{' '}
          {formatAt(booking.destination.plannedArrivalAt, booking.destination.stop)}
        </dd>
        <dt>Sièges</dt>
        <dd>{booking.seats.map((seat) => seat.seatLabel ?? '—').join(', ')}</dd>
        <dt>Prix unitaire</dt>
        <dd>
          {formatMoney(booking.unitAmountMinor, booking.currencyCode, booking.currencyMinorUnit)}
        </dd>
        <dt>Nombre de sièges</dt>
        <dd>{booking.seatCount}</dd>
        <dt>Total</dt>
        <dd>
          <strong>
            {formatMoney(booking.totalAmountMinor, booking.currencyCode, booking.currencyMinorUnit)}
          </strong>
        </dd>
        <dt>Expiration</dt>
        <dd data-testid="booking-expiration">
          {formatAt(booking.holdExpiresAt, booking.origin.stop)}
        </dd>
      </dl>
      <div className="et-actions">
        <a className="et-button et-booking-link-button" href={`${clientAppUrl}/compte`}>
          Mes réservations
        </a>
        <button type="button" className="et-button et-button--secondary" onClick={onRestart}>
          Nouvelle recherche
        </button>
      </div>
    </section>
  );
}

/** Public search followed by an authenticated, provisional CUSTOMER hold. */
export function BookingFlow() {
  const [originStopId, setOriginStopId] = useState('');
  const [destinationStopId, setDestinationStopId] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [results, setResults] = useState<BookingSearchResult[] | null>(null);
  const [trip, setTrip] = useState<BookingSearchResult | null>(null);
  const [availability, setAvailability] = useState<BookingAvailability | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [needsLogin, setNeedsLogin] = useState(false);
  const [booking, setBooking] = useState<CustomerBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCells = useMemo(
    () => availability?.cells.filter((cell) => selected.has(cell.id)) ?? [],
    [availability, selected],
  );
  const total = availability
    ? multiplyAmountMinor(availability.fare.amountMinor, selected.size)
    : 0;

  const resetAfterSearch = () => {
    setTrip(null);
    setAvailability(null);
    setSelected(new Set());
    setNeedsLogin(false);
    setBooking(null);
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const range = utcDayRange(departureDate);
    if (!range || originStopId === destinationStopId) {
      setError(
        originStopId === destinationStopId
          ? 'Choisissez deux arrêts différents.'
          : 'Choisissez une date de départ valide.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    resetAfterSearch();
    try {
      const result = await auth.booking.public.searchTrips({
        originStopId,
        destinationStopId,
        ...range,
        limit: 50,
      });
      if (result.ok) setResults(result.data.items);
      else setError(result.error.message);
    } finally {
      setBusy(false);
    }
  };

  const loadAvailability = async (selectedTrip: BookingSearchResult, preserveSeats = false) => {
    setBusy(true);
    setError(null);
    setTrip(selectedTrip);
    setNeedsLogin(false);
    try {
      const result = await auth.booking.public.availability(
        selectedTrip.tripId,
        selectedTrip.origin.routeWaypointId,
        selectedTrip.destination.routeWaypointId,
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAvailability(result.data);
      const availableIds = new Set(
        result.data.cells
          .filter((cell) => cell.kind === 'SEAT' && cell.available)
          .map((cell) => cell.id),
      );
      setSelected((current) =>
        preserveSeats
          ? new Set([...current].filter((cellId) => availableIds.has(cellId)))
          : new Set(),
      );
    } finally {
      setBusy(false);
    }
  };

  const createHold = async () => {
    if (!trip || !availability || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.booking.customer.createHold({
        tripId: trip.tripId,
        originRouteWaypointId: trip.origin.routeWaypointId,
        destinationRouteWaypointId: trip.destination.routeWaypointId,
        seatMapCellIds: [...selected],
      });
      if (result.ok) {
        setBooking(result.data);
        setNeedsLogin(false);
        return;
      }
      if (result.error.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (result.error.code === 'BOOKING_SEAT_UNAVAILABLE') {
        await loadAvailability(trip, true);
        setError(
          `${result.error.message} Les disponibilités ont été actualisées et les sièges encore libres sont conservés.`,
        );
      } else {
        setError(result.error.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const continueToHold = async () => {
    setBusy(true);
    setError(null);
    try {
      const me = await auth.me('customer');
      if (!me.ok) {
        if (me.error.status === 401) setNeedsLogin(true);
        else setError(me.error.message);
        return;
      }
    } finally {
      setBusy(false);
    }
    await createHold();
  };

  if (booking) {
    return (
      <HoldConfirmation
        booking={booking}
        onRestart={() => {
          setResults(null);
          resetAfterSearch();
        }}
      />
    );
  }

  return (
    <div className="et-booking-flow" data-testid="booking-flow">
      <FormAlert message={error} />
      <form
        className="et-form et-booking-search"
        aria-label="Rechercher un voyage"
        onSubmit={search}
      >
        <div className="et-booking-search-grid">
          <StopPicker label="Origine" value={originStopId} onChange={setOriginStopId} />
          <StopPicker
            label="Destination"
            value={destinationStopId}
            onChange={setDestinationStopId}
          />
          <div className="et-field et-booking-date">
            <label htmlFor="booking-departure-date">Date de départ</label>
            <input
              id="booking-departure-date"
              className="et-input"
              type="date"
              required
              value={departureDate}
              onChange={(event) => setDepartureDate(event.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="et-button" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Recherche…' : 'Rechercher'}
        </button>
      </form>

      {results ? (
        <section aria-labelledby="booking-results-title">
          <h2 id="booking-results-title">Voyages disponibles</h2>
          {results.length === 0 ? (
            <p>Aucun voyage disponible pour cette date.</p>
          ) : (
            <div className="et-booking-results">
              {results.map((result) => (
                <article
                  key={`${result.tripId}:${result.origin.routeWaypointId}:${result.destination.routeWaypointId}`}
                  className="et-booking-card"
                >
                  <h3>{result.tripReference}</h3>
                  <p>
                    <strong>{result.route.code}</strong> — {result.route.name}
                  </p>
                  <p>
                    {formatAt(result.origin.plannedDepartureAt, result.origin.stop)} →{' '}
                    {formatAt(result.destination.plannedArrivalAt, result.destination.stop)}
                  </p>
                  <p>
                    {result.availableSeatCount} sur {result.seatCount} sièges disponibles
                  </p>
                  <p>
                    <strong>
                      {formatMoney(
                        result.fare.amountMinor,
                        result.fare.currencyCode,
                        result.fare.currencyMinorUnit,
                      )}
                    </strong>{' '}
                    par siège
                  </p>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busy || result.availableSeatCount === 0}
                    onClick={() => void loadAvailability(result)}
                  >
                    Choisir le voyage {result.tripReference}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {trip && !availability ? <p role="status">Chargement du plan de sièges…</p> : null}
      {trip && availability ? (
        <section className="et-booking-selection" aria-labelledby="booking-seats-title">
          <h2 id="booking-seats-title">Choisissez vos sièges</h2>
          <p>
            Voyage <strong>{availability.tripReference}</strong> ·{' '}
            {stopLabel(availability.origin.stop)} → {stopLabel(availability.destination.stop)}
          </p>
          <p>
            {availability.availableSeatCount} sièges disponibles sur ce trajet. Vous pouvez en
            retenir au plus {availability.maxSeatsPerHold}.
          </p>
          <SeatMapPicker
            availability={availability}
            selected={selected}
            maxReached={selected.size >= availability.maxSeatsPerHold}
            onToggle={(cellId) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(cellId)) next.delete(cellId);
                else if (next.size < availability.maxSeatsPerHold) next.add(cellId);
                return next;
              })
            }
          />
          <aside className="et-booking-recap" aria-labelledby="booking-recap-title">
            <h3 id="booking-recap-title">Récapitulatif</h3>
            <dl className="et-booking-summary">
              <dt>Sièges</dt>
              <dd>
                {selectedCells.length
                  ? selectedCells.map((cell) => cell.seatLabel ?? '—').join(', ')
                  : 'Aucun'}
              </dd>
              <dt>Prix unitaire</dt>
              <dd>
                {formatMoney(
                  availability.fare.amountMinor,
                  availability.fare.currencyCode,
                  availability.fare.currencyMinorUnit,
                )}
              </dd>
              <dt>Quantité</dt>
              <dd>{seatsLabel(selected.size)}</dd>
              <dt>Total</dt>
              <dd data-testid="booking-total">
                <strong>
                  {formatMoney(
                    total,
                    availability.fare.currencyCode,
                    availability.fare.currencyMinorUnit,
                  )}
                </strong>
              </dd>
            </dl>
            <button
              type="button"
              className="et-button"
              disabled={busy || selected.size === 0}
              onClick={() => void continueToHold()}
            >
              Retenir {seatsLabel(selected.size)}
            </button>
          </aside>
        </section>
      ) : null}

      {needsLogin ? (
        <section className="et-booking-login" aria-labelledby="booking-login-title">
          <h2 id="booking-login-title">Connexion client</h2>
          <CustomerLogin onSignedIn={() => void createHold()} />
        </section>
      ) : null}
    </div>
  );
}
