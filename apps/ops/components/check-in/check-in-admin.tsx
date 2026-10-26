'use client';

import type {
  BoardingResolution,
  CheckInBlocker,
  CheckInBlockerCode,
  CheckInGate,
  CheckInGateStatus,
  StaffCheckInDetail,
  StaffCheckInListItem,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { useTripReferenceParam } from '../trips/trip-link';

const CHECK_LABELS: Record<CheckInGate, string> = {
  BOOKING: 'Réservation',
  PAYMENT: 'Paiement',
  DOCUMENTS: 'Documents',
  COMPLIANCE: 'Conformité',
  SEAT: 'Siège',
  BAGGAGE: 'Bagages',
};

const STATUS_LABELS: Record<CheckInGateStatus, string> = {
  PASS: 'OK',
  BLOCKED: 'À régulariser',
  PENDING_REVIEW: 'À vérifier',
};

const STATUS_TONES: Record<CheckInGateStatus, 'success' | 'warning' | 'danger'> = {
  PASS: 'success',
  BLOCKED: 'danger',
  PENDING_REVIEW: 'warning',
};

/** Operator wording of the stable codes; the API stays the authority. */
const BLOCKER_LABELS: Record<CheckInBlockerCode, string> = {
  BOOKING_NOT_CONFIRMED: 'Réservation non confirmée',
  BOOKING_CANCELLED: 'Réservation annulée',
  TRIP_NOT_SCHEDULED: 'Voyage non programmé',
  PAYMENT_NOT_SUCCEEDED: 'Aucun paiement réussi',
  DOCUMENTS_NOT_VERIFIED: 'Documents non vérifiés (conformité à refaire)',
  DOCUMENTS_NOT_ACCEPTED: 'Pièce non acceptée techniquement',
  DOCUMENTS_INCOMPLETE: 'Document requis manquant ou insuffisant',
  DOCUMENTS_REVIEW_REQUIRED: 'Document à vérifier par un agent',
  COMPLIANCE_MISSING: 'Conformité non évaluée',
  COMPLIANCE_STALE: 'Conformité périmée',
  COMPLIANCE_REVIEW_REQUIRED: 'Revue de conformité requise',
  COMPLIANCE_NEEDS_INFORMATION: 'Informations complémentaires requises',
  COMPLIANCE_NON_COMPLIANT: 'Non conforme',
  SEAT_NOT_ASSIGNED: 'Siège non affecté',
  SEAT_RELEASED: 'Siège libéré',
  BAGGAGE_EXCEPTION_ACTIVE: 'Incident bagage en cours',
};

const blockerText = (blocker: CheckInBlocker) =>
  blocker.reference
    ? `${BLOCKER_LABELS[blocker.code]} (${blocker.reference})`
    : BLOCKER_LABELS[blocker.code];

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

function Detail({
  detail,
  canManage,
  onChanged,
}: {
  detail: StaffCheckInDetail;
  canManage: boolean;
  onChanged: (message: string) => Promise<void>;
}) {
  const seatId = useId();
  const [seat, setSeat] = useState(detail.seat?.label ?? '');
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passenger = detail.passenger;
  const passengerReference = passenger?.reference ?? '';

  const run = async (action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = await action();
      if (message) await onChanged(message);
    } finally {
      setBusy(false);
    }
  };

  const assign = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await auth.admin.checkIn.assignSeat(
        detail.booking.reference,
        passengerReference,
        seat,
      );
      if (!result.ok) {
        setError(result.error.message);
        return null;
      }
      return `Siège ${result.data.seat.label} affecté.`;
    });
  };

  const checkIn = () =>
    void run(async () => {
      const result = await auth.admin.checkIn.checkIn(detail.booking.reference, passengerReference);
      if (!result.ok) {
        const blockers = result.error.details?.blockers ?? [];
        setError(
          blockers.length > 0
            ? `${result.error.message} ${blockers.map(blockerText).join(', ')}.`
            : result.error.message,
        );
        return null;
      }
      return `Passager enregistré : ${result.data.checkIn.reference}.`;
    });

  const showQr = async () => {
    if (!detail.checkIn) return;
    setError(null);
    const result = await auth.admin.checkIn.qr(detail.checkIn.reference);
    // Rendered as an image: the SVG is never injected as markup.
    if (result.ok) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.svg)}`);
    else setError(result.error.message);
  };

  const state = detail.checkIn
    ? detail.checkIn.boarding
      ? { label: 'Embarqué', tone: 'success' as const }
      : { label: 'Enregistré', tone: 'info' as const }
    : detail.readiness.eligible
      ? { label: 'Prêt pour le check-in', tone: 'success' as const }
      : { label: 'Non prêt', tone: 'danger' as const };

  return (
    <section
      className="et-network-panel ops-ground-detail"
      aria-labelledby="check-in-detail-title"
      data-testid="check-in-detail"
    >
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">Fiche voyageur</p>
          <h2 id="check-in-detail-title">
            {passenger ? `${passenger.givenName} ${passenger.familyName}` : 'Voyageur'}
          </h2>
        </div>
        <OpsStatusBadge tone={state.tone} className="et-tag">
          {state.label}
        </OpsStatusBadge>
      </div>
      <ol className="ops-ground-sequence" aria-label="Parcours du voyageur">
        <li
          className={
            detail.readiness.eligible
              ? 'ops-ground-sequence__step--done'
              : 'ops-ground-sequence__step--blocked'
          }
        >
          <span>Contrôles serveur</span>
          <small>
            {detail.readiness.eligible
              ? 'Six contrôles OK'
              : `${detail.readiness.blockers.length} point(s) à régulariser`}
          </small>
        </li>
        <li className={detail.seat ? 'ops-ground-sequence__step--done' : undefined}>
          <span>Siège</span>
          <small>{detail.seat ? detail.seat.label : 'À affecter'}</small>
        </li>
        <li className={detail.checkIn ? 'ops-ground-sequence__step--done' : undefined}>
          <span>Check-in</span>
          <small>{detail.checkIn ? 'Effectué' : 'En attente'}</small>
        </li>
        <li className={detail.checkIn?.boarding ? 'ops-ground-sequence__step--done' : undefined}>
          <span>Embarquement</span>
          <small>{detail.checkIn?.boarding ? 'Effectué' : 'En attente'}</small>
        </li>
      </ol>
      <dl className="ops-ground-facts">
        <div>
          <dt>Voyageur</dt>
          <dd className="et-code">{passengerReference}</dd>
        </div>
        <div>
          <dt>Réservation</dt>
          <dd className="et-code">{detail.booking.reference}</dd>
        </div>
        <div>
          <dt>Voyage</dt>
          <dd>
            <span className="et-code">{detail.trip.reference}</span> · {detail.trip.route.name} ·
            départ {formatAt(detail.trip.plannedDepartureAt)}
          </dd>
        </div>
        <div>
          <dt>Siège</dt>
          <dd data-testid="check-in-seat">{detail.seat?.label ?? 'Non affecté'}</dd>
        </div>
      </dl>
      <div className="et-table-wrap">
        <table className="et-table" data-testid="check-in-readiness">
          <caption>Contrôles recalculés par le serveur</caption>
          <thead>
            <tr>
              <th scope="col">Contrôle</th>
              <th scope="col">État</th>
              <th scope="col">Motif</th>
            </tr>
          </thead>
          <tbody>
            {detail.readiness.checks.map((check) => (
              <tr key={check.check}>
                <th scope="row">{CHECK_LABELS[check.check]}</th>
                <td>
                  <OpsStatusBadge tone={STATUS_TONES[check.status]}>
                    {STATUS_LABELS[check.status]}
                  </OpsStatusBadge>
                </td>
                <td>
                  {detail.readiness.blockers
                    .filter((blocker) => blocker.check === check.check)
                    .map(blockerText)
                    .join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormAlert message={error} />
      {detail.checkIn ? (
        <>
          <dl className="ops-ground-facts">
            <div>
              <dt>Enregistrement</dt>
              <dd className="et-code">{detail.checkIn.reference}</dd>
            </div>
            <div>
              <dt>Canal</dt>
              <dd>{detail.checkIn.channel === 'CUSTOMER' ? 'Client (en ligne)' : 'Comptoir'}</dd>
            </div>
            <div>
              <dt>Enregistré le</dt>
              <dd>{formatAt(detail.checkIn.checkedInAt)}</dd>
            </div>
            <div>
              <dt>Toujours valable</dt>
              <dd>
                {detail.checkIn.current ? 'Oui' : 'Non : un point bloquant est apparu'}
                {detail.checkIn.factsChangedSinceCheckIn
                  ? ' (faits modifiés depuis le check-in)'
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Embarquement</dt>
              <dd>
                {detail.checkIn.boarding
                  ? `${formatAt(detail.checkIn.boarding.boardedAt)} · poste ${detail.checkIn.boarding.deviceId}`
                  : 'Non embarqué'}
              </dd>
            </div>
          </dl>
          <div className="ops-ground-qr">
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => void showQr()}
            >
              Afficher l’étiquette QR
            </button>
            {qr ? (
              <figure className="et-baggage-qr">
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URI */}
                <img
                  src={qr}
                  alt={`QR d’embarquement ${detail.checkIn.reference}`}
                  width={198}
                  height={198}
                />
                <figcaption className="et-code">{detail.checkIn.reference}</figcaption>
              </figure>
            ) : null}
          </div>
        </>
      ) : canManage ? (
        <div className="ops-ground-forms">
          <form
            className="et-form ops-ground-form"
            aria-label="Affecter un siège"
            onSubmit={assign}
          >
            <p className="ops-operations-section-kicker">Siège</p>
            <div className="et-field">
              <label htmlFor={seatId}>Siège réservé</label>
              <select
                id={seatId}
                className="et-select"
                value={seat}
                onChange={(event) => setSeat(event.target.value)}
              >
                <option value="">Choisir</option>
                {detail.seats
                  .filter((option) => !option.assigned || option.label === detail.seat?.label)
                  .map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </div>
            <button
              type="submit"
              className="et-button et-button--secondary"
              disabled={busy || !seat || seat === detail.seat?.label}
            >
              Affecter le siège
            </button>
          </form>
          <div className="ops-ground-form">
            <p className="ops-operations-section-kicker">Enregistrement au comptoir</p>
            <p className="ops-ground-form__hint">
              Disponible uniquement lorsque le serveur confirme les six contrôles.
            </p>
            <button
              type="button"
              className="et-button"
              disabled={busy || !detail.readiness.eligible}
              onClick={checkIn}
            >
              Enregistrer le passager
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BoardingPanel({ canScan }: { canScan: boolean }) {
  const [qrPayload, setQrPayload] = useState('');
  const [deviceId, setDeviceId] = useState('ops-console');
  const [resolved, setResolved] = useState<BoardingResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const result = await auth.admin.boarding.resolve(qrPayload.trim());
    if (result.ok) setResolved(result.data);
    else {
      setResolved(null);
      setError(result.error.message);
    }
  };

  const board = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // One id per operator action: a network retry of the same action is
      // idempotent; a new scan of a boarded passenger is a stable 409.
      const result = await auth.admin.boarding.scan(qrPayload.trim(), {
        deviceId: deviceId.trim(),
        clientEventId: `ops-${crypto.randomUUID()}`,
        occurredAt: new Date().toISOString(),
      });
      if (!result.ok) {
        const blockers = result.error.details?.blockers ?? [];
        setError(
          blockers.length > 0
            ? `${result.error.message} ${blockers.map(blockerText).join(', ')}.`
            : result.error.message,
        );
        return;
      }
      setNotice(`Voyageur embarqué (${result.data.boarding.reference}).`);
      const refreshed = await auth.admin.boarding.resolve(qrPayload.trim());
      if (refreshed.ok) setResolved(refreshed.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="et-network-panel ops-ground-panel ops-ground-scan"
      aria-labelledby="boarding-panel-title"
      data-testid="boarding-panel"
    >
      <div>
        <p className="ops-operations-section-kicker">Porte d’embarquement</p>
        <h2 id="boarding-panel-title">Embarquement</h2>
      </div>
      <p className="ops-ground-form__hint">
        Le QR identifie seulement un enregistrement : le serveur revérifie chaque contrôle avant
        d’embarquer. Un voyageur ne peut être embarqué qu’une fois.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form className="et-form" aria-label="Scanner un QR" onSubmit={resolve}>
        <div className="et-network-adders">
          <TextField
            label="Code QR d’embarquement"
            name="qrPayload"
            value={qrPayload}
            onChange={setQrPayload}
            autoComplete="off"
            maxLength={64}
          />
          <TextField
            label="Poste d’embarquement"
            name="deviceId"
            value={deviceId}
            onChange={setDeviceId}
            autoComplete="off"
            maxLength={64}
            hint="Identifiant opérationnel du poste ou de l’appareil (pas une preuve d’identité)."
          />
        </div>
        <button type="submit" className="et-button et-button--secondary">
          Vérifier le code
        </button>
      </form>
      {resolved ? (
        <div className="ops-ground-resolution" data-testid="boarding-resolution">
          <dl className="ops-ground-facts">
            <div>
              <dt>Voyageur</dt>
              <dd>
                {resolved.checkIn.passenger.givenName} {resolved.checkIn.passenger.familyName}
              </dd>
            </div>
            <div>
              <dt>Siège</dt>
              <dd>{resolved.checkIn.seat.label}</dd>
            </div>
            <div>
              <dt>Voyage</dt>
              <dd className="et-code">{resolved.checkIn.trip.reference}</dd>
            </div>
            <div>
              <dt>Enregistrement</dt>
              <dd className="et-code">{resolved.checkIn.reference}</dd>
            </div>
            <div>
              <dt>État</dt>
              <dd>
                {resolved.checkIn.boarding
                  ? `Déjà embarqué (${formatAt(resolved.checkIn.boarding.boardedAt)})`
                  : resolved.readiness.eligible
                    ? 'Prêt à embarquer'
                    : `Bloqué : ${resolved.readiness.blockers.map(blockerText).join(', ')}`}
              </dd>
            </div>
          </dl>
          {canScan && !resolved.checkIn.boarding ? (
            <button
              type="button"
              className="et-button"
              disabled={busy || !deviceId.trim()}
              onClick={() => void board()}
            >
              Embarquer
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * checkin.read workspace; seat and check-in need checkin.manage, the boarding
 * panel boarding.read and the boarding action boarding.scan. No override.
 */
export function CheckInAdmin() {
  const checkInStatusId = useId();
  const boardingStatusId = useId();
  const canManage = useCan('checkin.manage');
  const canReadBoarding = useCan('boarding.read');
  const canScan = useCan('boarding.scan');
  // `/check-in?voyage=REF` (trip cockpit) opens filtered on that trip.
  const linkedTrip = useTripReferenceParam();
  const [tripReference, setTripReference] = useState(linkedTrip);
  const [bookingReference, setBookingReference] = useState('');
  const [passengerReference, setPassengerReference] = useState('');
  const [checkInStatus, setCheckInStatus] = useState<'' | 'CHECKED_IN' | 'NOT_CHECKED_IN'>('');
  const [boardingStatus, setBoardingStatus] = useState<'' | 'BOARDED' | 'NOT_BOARDED'>('');
  const [applied, setApplied] = useState({
    tripReference: linkedTrip,
    bookingReference: '',
    passengerReference: '',
  });
  const [items, setItems] = useState<StaffCheckInListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<StaffCheckInDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setListError(null);
      if (!cursor) setItems(null);
      const result = await auth.admin.checkIn.list({
        limit: 25,
        ...(cursor ? { cursor } : {}),
        ...(applied.tripReference ? { tripReference: applied.tripReference } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.passengerReference ? { passengerReference: applied.passengerReference } : {}),
        ...(checkInStatus ? { checkInStatus } : {}),
        ...(boardingStatus ? { boardingStatus } : {}),
      });
      if (!result.ok) {
        setListError(result.error.message);
        return;
      }
      setListError(null);
      setItems((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied, boardingStatus, checkInStatus],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (booking: string, passenger: string) => {
    const key = `${booking}/${passenger}`;
    setSelectedKey(key);
    setDetail(null);
    setDetailError(null);
    const result = await auth.admin.checkIn.detail(booking, passenger);
    if (result.ok) setDetail(result.data);
    else setDetailError(result.error.message);
  };

  const changed = async (message: string) => {
    setNotice(message);
    if (detail?.passenger) await select(detail.booking.reference, detail.passenger.reference);
    await load();
  };

  const filter = (event: FormEvent) => {
    event.preventDefault();
    setApplied({
      tripReference: tripReference.trim().toUpperCase(),
      bookingReference: bookingReference.trim().toUpperCase(),
      passengerReference: passengerReference.trim().toUpperCase(),
    });
  };

  const visible = items ?? [];
  const blockedCount = visible.filter((item) => !item.readiness.eligible).length;
  const checkedInCount = visible.filter((item) => item.checkIn).length;
  const boardedCount = visible.filter((item) => item.boarding).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-check-in-workspace"
      data-testid="check-in-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Comptoir & porte d’embarquement</p>
          <h2>Check-in et embarquement des voyageurs</h2>
          <p>
            Check-in et embarquement des voyageurs de réservations confirmées. Les six contrôles
            (réservation, paiement, documents, conformité, siège, bagages) sont recalculés par le
            serveur ; aucun forçage n’existe. Un voyageur embarqué ne signifie pas que le voyage
            peut partir.
          </p>
        </div>
      </div>
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {items ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des voyageurs affichés">
          <OpsKpiCard
            label="Voyageurs affichés"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Tous les voyageurs filtrés sont chargés'
            }
            icon="users"
            tone="info"
          />
          <OpsKpiCard
            label="Contrôles à régulariser"
            value={blockedCount}
            helper="Au moins un contrôle serveur non satisfait"
            icon="alert"
            tone={blockedCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Enregistrés"
            value={checkedInCount}
            helper="Check-in effectué"
            icon="check"
            tone="success"
          />
          <OpsKpiCard
            label="Embarqués"
            value={boardedCount}
            helper="N’autorise pas le départ du voyage"
            icon="bus"
            tone="info"
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {items.length} voyageurs chargés.
        </p>
      ) : null}

      <div className="ops-ground-tools">
        {canReadBoarding ? <BoardingPanel canScan={canScan} /> : null}
        <form
          className="et-form et-network-form ops-ground-panel"
          aria-label="Filtrer les voyageurs"
          onSubmit={filter}
        >
          <p className="ops-operations-section-kicker">Filtres</p>
          <div className="et-network-adders">
            <TextField
              label="Référence voyage"
              name="tripReference"
              value={tripReference}
              onChange={setTripReference}
              autoComplete="off"
              required={false}
              maxLength={32}
            />
            <TextField
              label="Référence réservation"
              name="bookingReference"
              value={bookingReference}
              onChange={setBookingReference}
              autoComplete="off"
              required={false}
              maxLength={16}
            />
            <TextField
              label="Référence voyageur"
              name="passengerReference"
              value={passengerReference}
              onChange={setPassengerReference}
              autoComplete="off"
              required={false}
              maxLength={16}
            />
            <div className="et-field">
              <label htmlFor={checkInStatusId}>Check-in</label>
              <select
                id={checkInStatusId}
                className="et-select"
                value={checkInStatus}
                onChange={(event) =>
                  setCheckInStatus(event.target.value as '' | 'CHECKED_IN' | 'NOT_CHECKED_IN')
                }
              >
                <option value="">Tous</option>
                <option value="CHECKED_IN">Enregistrés</option>
                <option value="NOT_CHECKED_IN">Non enregistrés</option>
              </select>
            </div>
            <div className="et-field">
              <label htmlFor={boardingStatusId}>Embarquement</label>
              <select
                id={boardingStatusId}
                className="et-select"
                value={boardingStatus}
                onChange={(event) =>
                  setBoardingStatus(event.target.value as '' | 'BOARDED' | 'NOT_BOARDED')
                }
              >
                <option value="">Tous</option>
                <option value="BOARDED">Embarqués</option>
                <option value="NOT_BOARDED">Non embarqués</option>
              </select>
            </div>
          </div>
          <button type="submit" className="et-button">
            Filtrer
          </button>
        </form>
      </div>

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="check-in-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Liste d’enregistrement</p>
            <h2 id="check-in-list-title">Voyageurs</h2>
          </div>
        </div>
        {!items && !listError ? <OpsLoadingState title="Chargement des voyageurs" /> : null}
        {!items && listError ? (
          <OpsErrorState
            title="Impossible de charger les voyageurs"
            message={listError}
            onRetry={() => void load()}
          />
        ) : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Voyageurs de réservations confirmées</caption>
              <thead>
                <tr>
                  <th scope="col">Voyageur</th>
                  <th scope="col">Réservation · voyage</th>
                  <th scope="col">Siège</th>
                  <th scope="col">Contrôles</th>
                  <th scope="col">Check-in</th>
                  <th scope="col">Embarquement</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={`${item.booking.reference}/${item.passenger.reference}`}
                    className={
                      selectedKey === `${item.booking.reference}/${item.passenger.reference}`
                        ? 'ops-table-row--selected'
                        : undefined
                    }
                  >
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}
                      <br />
                      <span className="et-code">{item.passenger.reference}</span>
                    </td>
                    <td>
                      <span className="et-code">{item.booking.reference}</span>
                      <br />
                      <span className="et-code">{item.trip.reference}</span>
                    </td>
                    <td>{item.seat?.label ?? '—'}</td>
                    <td>
                      {item.readiness.eligible ? (
                        <OpsStatusBadge tone="success">OK</OpsStatusBadge>
                      ) : (
                        <span className="ops-ground-blockers">
                          {item.readiness.blockers.map(blockerText).join(', ')}
                        </span>
                      )}
                    </td>
                    <td>
                      {item.checkIn ? (
                        <span className="et-code">{item.checkIn.reference}</span>
                      ) : (
                        <OpsStatusBadge tone="neutral">Non enregistré</OpsStatusBadge>
                      )}
                    </td>
                    <td>
                      {item.boarding ? (
                        formatAt(item.boarding.boardedAt)
                      ) : (
                        <OpsStatusBadge tone="neutral">Non embarqué</OpsStatusBadge>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter ${item.passenger.givenName} ${item.passenger.familyName}`}
                        aria-controls="check-in-detail-panel"
                        aria-expanded={
                          Boolean(detail) &&
                          selectedKey === `${item.booking.reference}/${item.passenger.reference}`
                        }
                        onClick={() =>
                          void select(item.booking.reference, item.passenger.reference)
                        }
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
        {items?.length === 0 ? (
          <OpsEmptyState
            title="Aucun voyageur"
            description="Aucun voyageur ne correspond aux filtres de check-in actuellement appliqués."
          />
        ) : null}
        {items && listError ? (
          <OpsErrorState
            title="Impossible d’actualiser les voyageurs"
            message={listError}
            onRetry={() => void load(nextCursor ?? undefined)}
          />
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Charger la suite
          </button>
        ) : null}
      </section>

      {selectedKey && !detail && !detailError ? (
        <OpsLoadingState title="Chargement de la fiche voyageur" />
      ) : null}
      {selectedKey && detailError ? (
        <OpsErrorState
          title="Impossible d’ouvrir cette fiche voyageur"
          message={detailError}
          onRetry={() => {
            const [booking, passenger] = selectedKey.split('/');
            if (booking && passenger) void select(booking, passenger);
          }}
        />
      ) : null}
      {detail ? (
        <OpsDetailRegion
          id="check-in-detail-panel"
          focusKey={selectedKey}
          onClose={() => {
            setSelectedKey(null);
            setDetail(null);
            setDetailError(null);
          }}
        >
          <Detail
            key={`${detail.booking.reference}/${detail.passenger?.reference ?? ''}/${detail.checkIn?.reference ?? ''}`}
            detail={detail}
            canManage={canManage}
            onChanged={changed}
          />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
