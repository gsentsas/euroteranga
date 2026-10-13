'use client';

import {
  formatMoney,
  type AdminBooking,
  type CustomerBookingStatus,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

const STATUS_LABELS: Record<CustomerBookingStatus, string> = {
  HELD: 'Provisoire',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
};

function formatAt(value: string | null, timeZone = 'UTC'): string {
  if (!value) return '—';
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

function stopLabel(booking: AdminBooking, end: 'origin' | 'destination'): string {
  const stop = booking[end].stop;
  return stop ? `${stop.name} (${stop.locality}, ${stop.country.name})` : 'Arrêt inconnu';
}

function BookingDetail({
  booking,
  canManage,
  busy,
  onCancel,
}: {
  booking: AdminBooking;
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
      className="et-network-panel et-booking-admin-detail"
      aria-labelledby={`admin-booking-${booking.id}`}
      data-testid="booking-detail"
    >
      <div className="et-actions">
        <h2 id={`admin-booking-${booking.id}`}>Réservation {booking.reference}</h2>
        <span className="et-tag">{STATUS_LABELS[booking.status]}</span>
      </div>
      <dl className="et-booking-admin-summary">
        <dt>Voyage</dt>
        <dd>
          {booking.trip.reference} · {booking.trip.route.code} — {booking.trip.route.name}
        </dd>
        <dt>Statut du voyage</dt>
        <dd>{booking.tripStatus}</dd>
        <dt>Origine</dt>
        <dd>
          {stopLabel(booking, 'origin')} ·{' '}
          {formatAt(booking.origin.plannedDepartureAt, booking.origin.stop?.timezone)}
        </dd>
        <dt>Destination</dt>
        <dd>
          {stopLabel(booking, 'destination')} ·{' '}
          {formatAt(booking.destination.plannedArrivalAt, booking.destination.stop?.timezone)}
        </dd>
        <dt>Sièges</dt>
        <dd>{booking.seats.map((seat) => seat.seatLabel ?? '—').join(', ')}</dd>
        <dt>Prix unitaire</dt>
        <dd>
          {formatMoney(booking.unitAmountMinor, booking.currencyCode, booking.currencyMinorUnit)}
        </dd>
        <dt>Total</dt>
        <dd>
          <strong>
            {formatMoney(booking.totalAmountMinor, booking.currencyCode, booking.currencyMinorUnit)}
          </strong>{' '}
          ({booking.seatCount} siège{booking.seatCount > 1 ? 's' : ''})
        </dd>
        <dt>Expiration</dt>
        <dd>{formatAt(booking.holdExpiresAt, booking.origin.stop?.timezone)}</dd>
        <dt>Identité client</dt>
        <dd className="et-code">{booking.customerIdentityId}</dd>
        {booking.cancellationReason ? (
          <>
            <dt>Motif d’annulation</dt>
            <dd>{booking.cancellationReason}</dd>
          </>
        ) : null}
      </dl>
      {canManage && booking.status === 'HELD' ? (
        <form
          className="et-form"
          aria-label={`Annuler la réservation ${booking.reference}`}
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
            Annuler la réservation
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** booking.read list/detail; booking.manage adds one reasoned cancellation control. */
export function BookingsAdmin() {
  const canManage = useCan('booking.manage');
  const statusId = useId();
  const [status, setStatus] = useState<CustomerBookingStatus | ''>('');
  const [reference, setReference] = useState('');
  const [appliedReference, setAppliedReference] = useState('');
  const [bookings, setBookings] = useState<AdminBooking[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.bookings.bookings({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
        ...(appliedReference ? { reference: appliedReference } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setBookings((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [appliedReference, status],
  );

  const loadDetail = useCallback(async (bookingId: string) => {
    const result = await auth.admin.bookings.booking(bookingId);
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
      const result = await auth.admin.bookings.cancel(detail.id, reason);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDetail(result.data);
      await load();
      setNotice(`Réservation ${result.data.reference} annulée.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="et-network" data-testid="bookings-workspace">
      <p>
        Consultez les retenues provisoires. L’annulation libère les sièges et exige un motif ; elle
        ne représente ni remboursement ni traitement de paiement.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form
        className="et-form et-network-form"
        aria-label="Filtrer les réservations"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedReference(reference.trim().toUpperCase());
        }}
      >
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={statusId}>Statut</label>
            <select
              id={statusId}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as CustomerBookingStatus | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(STATUS_LABELS) as CustomerBookingStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Référence"
            name="reference"
            value={reference}
            onChange={setReference}
            autoComplete="off"
            required={false}
            maxLength={16}
          />
        </div>
        <button type="submit" className="et-button et-button--secondary">
          Appliquer les filtres
        </button>
      </form>

      <section aria-labelledby="admin-bookings-title">
        <h2 id="admin-bookings-title">Réservations</h2>
        {!bookings ? <p role="status">Chargement des réservations…</p> : null}
        {bookings ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Retenues provisoires des clients</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Voyage</th>
                  <th scope="col">Origine → destination</th>
                  <th scope="col">Sièges</th>
                  <th scope="col">Total</th>
                  <th scope="col">Expiration</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id}>
                    <th scope="row" className="et-code">
                      {booking.reference}
                    </th>
                    <td>{booking.trip.reference}</td>
                    <td>
                      {stopLabel(booking, 'origin')} → {stopLabel(booking, 'destination')}
                    </td>
                    <td>{booking.seatCount}</td>
                    <td>
                      {formatMoney(
                        booking.totalAmountMinor,
                        booking.currencyCode,
                        booking.currencyMinorUnit,
                      )}
                    </td>
                    <td>{formatAt(booking.holdExpiresAt, booking.origin.stop?.timezone)}</td>
                    <td>{STATUS_LABELS[booking.status]}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter la réservation ${booking.reference}`}
                        onClick={() => setSelectedId(booking.id)}
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
        {bookings?.length === 0 ? <p>Aucune réservation.</p> : null}
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

      {selectedId && !detail ? <p role="status">Chargement de la réservation…</p> : null}
      {detail ? (
        <BookingDetail booking={detail} canManage={canManage} busy={busy} onCancel={cancel} />
      ) : null}
    </div>
  );
}
