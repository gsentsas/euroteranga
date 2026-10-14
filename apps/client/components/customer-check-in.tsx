'use client';

import type {
  BookingCheckInOverview,
  CheckInBlocker,
  CheckInBlockerCode,
  CheckInGate,
  CheckInGateStatus,
  PassengerCheckIn,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import { auth } from '../lib/auth';

export const CHECK_LABELS: Record<CheckInGate, string> = {
  BOOKING: 'Réservation',
  PAYMENT: 'Paiement',
  DOCUMENTS: 'Documents',
  COMPLIANCE: 'Conformité',
  SEAT: 'Siège',
  BAGGAGE: 'Bagages',
};

export const CHECK_STATUS_LABELS: Record<CheckInGateStatus, string> = {
  PASS: 'OK',
  BLOCKED: 'À régulariser',
  PENDING_REVIEW: 'À vérifier',
};

/** Next useful action per stable code; the server stays the authority. */
export const NEXT_ACTIONS: Record<CheckInBlockerCode, string> = {
  BOOKING_NOT_CONFIRMED: 'Contacter le service client : la réservation n’est pas confirmée.',
  BOOKING_CANCELLED: 'Contacter le service client : la réservation est annulée.',
  TRIP_NOT_SCHEDULED: 'Contacter le service client : le voyage n’est pas programmé.',
  PAYMENT_NOT_SUCCEEDED: 'Contacter le service client : aucun paiement réussi n’est enregistré.',
  DOCUMENTS_NOT_VERIFIED: 'Les documents seront vérifiés avec la conformité du voyage.',
  DOCUMENTS_NOT_ACCEPTED: 'Ajouter un document accepté techniquement.',
  DOCUMENTS_INCOMPLETE: 'Ajouter un document de voyage.',
  DOCUMENTS_REVIEW_REQUIRED: 'Un document doit être vérifié par l’équipe EURO TERANGA.',
  COMPLIANCE_MISSING: 'Faire vérifier la conformité dans la section « Conformité du voyage ».',
  COMPLIANCE_STALE: 'Faire vérifier à nouveau la conformité : des informations ont changé.',
  COMPLIANCE_REVIEW_REQUIRED: 'Une revue de conformité est en cours par l’équipe.',
  COMPLIANCE_NEEDS_INFORMATION:
    'Informations complémentaires requises : voir « Conformité du voyage ».',
  COMPLIANCE_NON_COMPLIANT:
    'Non conforme selon les règles publiées : voir « Conformité du voyage ».',
  SEAT_NOT_ASSIGNED: 'Affecter un siège à ce voyageur.',
  SEAT_RELEASED: 'Contacter le service client : ce siège n’est plus réservé.',
  BAGGAGE_EXCEPTION_ACTIVE: 'Résoudre le problème bagage avec l’équipe EURO TERANGA.',
};

function blockerText(blocker: CheckInBlocker): string {
  const base = NEXT_ACTIONS[blocker.code];
  return blocker.reference ? `${base} (${blocker.reference})` : base;
}

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

type Item = BookingCheckInOverview['items'][number];

function CheckedIn({ checkIn }: { checkIn: PassengerCheckIn }) {
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showQr = async () => {
    setError(null);
    const result = await auth.booking.customer.checkInQr(checkIn.reference);
    // The SVG is rendered as an image, never injected as markup.
    if (result.ok) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.svg)}`);
    else setError(result.error.message);
  };

  return (
    <div>
      <p className="et-tag">{checkIn.boarding ? 'Embarqué' : 'Enregistrement effectué'}</p>
      <dl className="et-booking-details">
        <dt>Enregistrement</dt>
        <dd>{checkIn.reference}</dd>
        <dt>Siège</dt>
        <dd>{checkIn.seat.label}</dd>
        <dt>Voyage</dt>
        <dd>
          {checkIn.trip.reference} · {checkIn.trip.route.name} · départ{' '}
          {formatAt(checkIn.trip.plannedDepartureAt)}
        </dd>
        <dt>Voyageur</dt>
        <dd>
          {checkIn.passenger.givenName} {checkIn.passenger.familyName}
        </dd>
        {checkIn.boarding ? (
          <>
            <dt>Embarquement</dt>
            <dd>{formatAt(checkIn.boarding.boardedAt)}</dd>
          </>
        ) : null}
      </dl>
      <FormAlert message={error} />
      <button
        type="button"
        className="et-button et-button--secondary"
        onClick={() => void showQr()}
      >
        Afficher le QR d’embarquement
      </button>
      {qr ? (
        <figure className="et-baggage-qr">
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URI */}
          <img src={qr} alt={`QR d’embarquement ${checkIn.reference}`} width={198} height={198} />
          <figcaption>
            Le QR ne remplace pas les documents de voyage. Il ne prouve ni l’identité, ni le
            paiement, ni la conformité : l’équipe vérifie tout à l’embarquement.
          </figcaption>
        </figure>
      ) : (
        <p>Le QR ne remplace pas les documents de voyage.</p>
      )}
    </div>
  );
}

function PassengerCheckInCard({
  bookingReference,
  item,
  seats,
  busy,
  onAssign,
  onCheckIn,
}: {
  bookingReference: string;
  item: Item;
  seats: BookingCheckInOverview['seats'];
  busy: boolean;
  onAssign: (passengerReference: string, seatLabel: string) => void;
  onCheckIn: (passengerReference: string) => void;
}) {
  const seatId = useId();
  const [seat, setSeat] = useState(item.seat?.label ?? '');
  const free = seats.filter(
    (option) => option.assignedTo === null || option.assignedTo === item.passenger.reference,
  );
  const readiness = item.readiness;

  return (
    <article
      className="et-customer-booking"
      data-testid={`check-in-${item.passenger.reference}`}
      aria-label={`Check-in de ${item.passenger.givenName} ${item.passenger.familyName}`}
    >
      <div className="et-actions">
        <h4>
          {item.passenger.givenName} {item.passenger.familyName}
        </h4>
        <span className="et-tag">{bookingReference}</span>
      </div>
      {item.checkIn ? (
        <CheckedIn checkIn={item.checkIn} />
      ) : (
        <>
          <ul className="et-document-list" aria-label="Contrôles avant check-in">
            {readiness.checks.map((check) => (
              <li key={check.check}>
                <span>{CHECK_LABELS[check.check]}</span>
                <span className="et-tag">{CHECK_STATUS_LABELS[check.status]}</span>
              </li>
            ))}
          </ul>
          {readiness.blockers.length > 0 ? (
            <ul aria-label="À faire avant le check-in">
              {readiness.blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`}>{blockerText(blocker)}</li>
              ))}
              {readiness.complianceGuidance.map((guidance) => (
                <li key={guidance}>{guidance}</li>
              ))}
            </ul>
          ) : null}
          <div className="et-actions">
            <label htmlFor={seatId}>Siège</label>
            <select id={seatId} value={seat} onChange={(event) => setSeat(event.target.value)}>
              <option value="">Choisir un siège réservé</option>
              {free.map((option) => (
                <option key={option.label} value={option.label}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="et-button et-button--secondary"
              disabled={busy || !seat || seat === item.seat?.label}
              onClick={() => onAssign(item.passenger.reference, seat)}
            >
              Affecter le siège
            </button>
          </div>
          <button
            type="button"
            className="et-button"
            disabled={busy || !readiness.eligible}
            onClick={() => onCheckIn(item.passenger.reference)}
          >
            Effectuer le check-in
          </button>
        </>
      )}
    </article>
  );
}

/**
 * CUSTOMER check-in of owned confirmed bookings. Every gate is derived and
 * enforced by the server; this view only explains the result.
 */
export function CustomerCheckIn() {
  const router = useRouter();
  const [overviews, setOverviews] = useState<BookingCheckInOverview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await auth.booking.customer.bookings({ limit: 50 });
    if (!result.ok) {
      if (result.error.status === 401) router.replace('/connexion');
      else setError(result.error.message);
      return;
    }
    const confirmed = result.data.items.filter((booking) => booking.status === 'CONFIRMED');
    const loaded = await Promise.all(
      confirmed.map((booking) => auth.booking.customer.checkInOverview(booking.reference)),
    );
    setOverviews(loaded.flatMap((overview) => (overview.ok ? [overview.data] : [])));
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const assign = (bookingReference: string) => (passengerReference: string, seatLabel: string) =>
    void run(async () => {
      const result = await auth.booking.customer.assignSeat(
        bookingReference,
        passengerReference,
        seatLabel,
      );
      if (!result.ok) {
        setError(result.error.message);
        return null;
      }
      return `Siège ${result.data.seat.label} affecté.`;
    });

  const checkIn = (bookingReference: string) => (passengerReference: string) =>
    void run(async () => {
      const result = await auth.booking.customer.checkIn(bookingReference, passengerReference);
      if (!result.ok) {
        const blockers = result.error.details?.blockers ?? [];
        setError(
          blockers.length > 0
            ? `${result.error.message} ${blockers.map(blockerText).join(' ')}`
            : result.error.message,
        );
        return null;
      }
      return `Enregistrement effectué : ${result.data.checkIn.reference}.`;
    });

  return (
    <section aria-labelledby="customer-check-in-title" data-testid="customer-check-in">
      <div className="et-actions">
        <h2 id="customer-check-in-title">Check-in</h2>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      <p>
        Le check-in vérifie la réservation, le paiement, les documents, la conformité, le siège et
        les bagages de chaque voyageur. Le QR d’embarquement est délivré seulement après le check-in
        ; il ne remplace pas les documents de voyage.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      {!overviews ? <p role="status">Chargement du check-in…</p> : null}
      {overviews?.every((overview) => overview.items.length === 0) ? (
        <p>Ajoutez des voyageurs à une réservation confirmée pour effectuer le check-in.</p>
      ) : null}
      {overviews?.map((overview) =>
        overview.items.length === 0 ? null : (
          <div key={overview.booking.reference} className="et-passenger-list">
            <h3>
              Réservation {overview.booking.reference} · {overview.trip.reference}
            </h3>
            {overview.items.map((item) => (
              <PassengerCheckInCard
                key={item.passenger.reference}
                bookingReference={overview.booking.reference}
                item={item}
                seats={overview.seats}
                busy={busy}
                onAssign={assign(overview.booking.reference)}
                onCheckIn={checkIn(overview.booking.reference)}
              />
            ))}
          </div>
        ),
      )}
    </section>
  );
}
