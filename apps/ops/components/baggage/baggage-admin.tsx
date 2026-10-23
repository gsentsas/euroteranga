'use client';

import type {
  Baggage,
  BaggageDetail,
  BaggageEventType,
  BaggageExceptionStatus,
  BaggageLifecycleStatus,
  BaggageOperationalEventType,
  BaggageType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

const TYPE_LABELS: Record<BaggageType, string> = {
  SUITCASE: 'Valise',
  TRAVEL_BAG: 'Sac de voyage',
  BOX: 'Carton',
  OTHER: 'Autre',
};

const LIFECYCLE_LABELS: Record<BaggageLifecycleStatus, string> = {
  REGISTERED: 'Enregistré',
  CHECKED_IN: 'Pris en charge',
  LOADED: 'Chargé',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  DELIVERED: 'Remis',
  REMOVED: 'Retiré',
};

const EXCEPTION_LABELS: Record<BaggageExceptionStatus, string> = {
  MISSING: 'Introuvable',
  DAMAGED: 'Endommagé',
  HELD_BY_CUSTOMS: 'Retenu en douane',
};

const EVENT_LABELS: Record<BaggageEventType, string> = {
  ...LIFECYCLE_LABELS,
  ...EXCEPTION_LABELS,
  WEIGHT_UPDATED: 'Pesée',
  EXCEPTION_RESOLVED: 'Incident résolu',
};

const OPERATIONAL_EVENTS: BaggageOperationalEventType[] = [
  'CHECKED_IN',
  'LOADED',
  'IN_TRANSIT',
  'ARRIVED',
  'DELIVERED',
  'MISSING',
  'DAMAGED',
  'HELD_BY_CUSTOMS',
  'EXCEPTION_RESOLVED',
  'REMOVED',
];

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

/** Exact API decimal string, displayed without Number conversion. */
const formatWeight = (value: string | null) =>
  value === null ? 'Non pesé' : `${value.replace('.', ',')} kg`;

function formatExactMoney(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  if (minorUnit === 0) return `${amount.toString()} ${currencyCode}`;
  const scale = 10n ** BigInt(minorUnit);
  const major = amount / scale;
  const minor = (amount % scale).toString().padStart(minorUnit, '0');
  return `${major.toString()},${minor} ${currencyCode}`;
}

function allowanceLabel(baggage: Baggage): string {
  const allowance = baggage.allowance;
  if (!allowance.policy || allowance.status === 'NOT_CONFIGURED') return 'Non configurée';
  if (allowance.status === 'PENDING_WEIGHT') {
    return `${allowance.policy.code} · pièce ${allowance.pieceOrdinal ?? '—'} · en attente de pesée`;
  }
  if (allowance.status === 'INCLUDED') {
    return `${allowance.policy.code} · inclus`;
  }
  if (allowance.status === 'EXCESS_UNPRICED') {
    return `${allowance.policy.code} · excédent ${formatWeight(allowance.excessWeightKg)} · tarif à confirmer`;
  }
  return `${allowance.policy.code} · ${formatWeight(allowance.excessWeightKg)} d’excédent · ${
    allowance.excessCharge
      ? formatExactMoney(
          allowance.excessCharge.amountMinor,
          allowance.excessCharge.currencyCode,
          allowance.excessCharge.currencyMinorUnit,
        )
      : '—'
  }`;
}

function Detail({
  baggage,
  canManage,
  onChanged,
}: {
  baggage: BaggageDetail;
  canManage: boolean;
  onChanged: (reference: string, message: string) => Promise<void>;
}) {
  const eventId = useId();
  const [weight, setWeight] = useState('');
  const [eventType, setEventType] = useState<BaggageOperationalEventType>('CHECKED_IN');
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showQr = async () => {
    setError(null);
    const result = await auth.admin.baggage.qr(baggage.reference);
    // Rendered as an image: the SVG is never injected as markup.
    if (result.ok) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.svg)}`);
    else setError(result.error.message);
  };

  const run = async (action: () => ReturnType<typeof auth.admin.baggage.recordEvent>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await onChanged(
        baggage.reference,
        `Événement « ${EVENT_LABELS[result.data.event.type]} » enregistré (n° ${result.data.event.sequence}).`,
      );
      setWeight('');
    } finally {
      setBusy(false);
    }
  };

  const submitWeight = (event: FormEvent) => {
    event.preventDefault();
    void run(() =>
      auth.admin.baggage.updateWeight(baggage.reference, {
        // Sent exactly as typed (decimal comma accepted); the API validates it.
        measuredWeightKg: weight.trim().replace(',', '.'),
      }),
    );
  };

  const submitEvent = (event: FormEvent) => {
    event.preventDefault();
    void run(() => auth.admin.baggage.recordEvent(baggage.reference, { type: eventType }));
  };

  return (
    <section
      className="et-network-panel"
      aria-labelledby={`baggage-${baggage.reference}`}
      data-testid="baggage-detail"
    >
      <div className="et-actions">
        <h2 id={`baggage-${baggage.reference}`}>Bagage {baggage.reference}</h2>
        <span className="et-tag">{LIFECYCLE_LABELS[baggage.lifecycleStatus]}</span>
        {baggage.exceptionStatus ? (
          <span className="et-tag">{EXCEPTION_LABELS[baggage.exceptionStatus]}</span>
        ) : null}
      </div>
      <dl className="et-booking-admin-summary">
        <dt>Voyageur</dt>
        <dd>
          {baggage.passenger.givenName} {baggage.passenger.familyName} ·{' '}
          <span className="et-code">{baggage.passenger.reference}</span>
        </dd>
        <dt>Réservation</dt>
        <dd className="et-code">{baggage.booking.reference}</dd>
        <dt>Voyage</dt>
        <dd>
          <span className="et-code">{baggage.booking.trip.reference}</span> ·{' '}
          {baggage.booking.trip.route.name}
          {baggage.booking.trip.plannedDepartureAt
            ? ` · départ ${formatAt(baggage.booking.trip.plannedDepartureAt)}`
            : ''}
        </dd>
        <dt>Type</dt>
        <dd>{TYPE_LABELS[baggage.type]}</dd>
        <dt>Poids mesuré</dt>
        <dd data-testid="baggage-weight">{formatWeight(baggage.measuredWeightKg)}</dd>
        <dt>Franchise</dt>
        <dd data-testid="baggage-allowance">
          {baggage.allowance.policy ? (
            <>
              {baggage.allowance.policy.name} · version {baggage.allowance.policy.version} ·{' '}
              {baggage.allowance.policy.includedPieces} pièce(s) de{' '}
              {formatWeight(baggage.allowance.policy.includedWeightKgPerPiece)}
              {' · '}rang du bagage {baggage.allowance.pieceOrdinal ?? '—'}
            </>
          ) : (
            'Non configurée pour cette tarification historique'
          )}
        </dd>
        <dt>Résultat commercial</dt>
        <dd>{allowanceLabel(baggage)}</dd>
        <dt>Code QR</dt>
        <dd className="et-code">{baggage.qrPayload}</dd>
      </dl>
      <p>
        Le code QR identifie seulement le bagage : chaque action exige une session STAFF et la
        permission correspondante. La franchise est historique et le supplément éventuel est
        recalculé uniquement lorsqu’un poids officiel est enregistré. Aucun paiement n’est créé.
      </p>
      <FormAlert message={error} />
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
          <img src={qr} alt={`QR code du bagage ${baggage.reference}`} width={180} height={180} />
          <figcaption className="et-code">{baggage.reference}</figcaption>
        </figure>
      ) : null}

      {canManage && baggage.lifecycleStatus !== 'REMOVED' ? (
        <div className="et-network-adders">
          <form className="et-form" aria-label="Enregistrer le poids" onSubmit={submitWeight}>
            <TextField
              label="Poids mesuré (kg)"
              name="measuredWeightKg"
              value={weight}
              onChange={setWeight}
              autoComplete="off"
              hint="De 0,001 à 999,999 kg, trois décimales au plus."
              maxLength={7}
            />
            <button type="submit" className="et-button" disabled={busy}>
              Enregistrer le poids
            </button>
          </form>
          <form className="et-form" aria-label="Enregistrer un événement" onSubmit={submitEvent}>
            <div className="et-field">
              <label htmlFor={eventId}>Événement</label>
              <select
                id={eventId}
                className="et-select"
                value={eventType}
                onChange={(event) =>
                  setEventType(event.target.value as BaggageOperationalEventType)
                }
              >
                {OPERATIONAL_EVENTS.map((value) => (
                  <option key={value} value={value}>
                    {EVENT_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="et-button" disabled={busy}>
              Enregistrer l’événement
            </button>
          </form>
        </div>
      ) : null}

      <div className="et-table-wrap">
        <table data-testid="baggage-timeline">
          <caption>Historique immuable</caption>
          <thead>
            <tr>
              <th>N°</th>
              <th>Événement</th>
              <th>Statut</th>
              <th>Incident</th>
              <th>Poids</th>
              <th>Survenu le</th>
              <th>Lieu</th>
            </tr>
          </thead>
          <tbody>
            {baggage.events.map((event) => (
              <tr key={event.sequence}>
                <td>{event.sequence}</td>
                <td>{EVENT_LABELS[event.type]}</td>
                <td>{LIFECYCLE_LABELS[event.lifecycleStatus]}</td>
                <td>{event.exceptionStatus ? EXCEPTION_LABELS[event.exceptionStatus] : '—'}</td>
                <td>{formatWeight(event.measuredWeightKg)}</td>
                <td>{formatAt(event.occurredAt)}</td>
                <td>{event.location ? `${event.location.name} (${event.location.code})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * baggage.read workspace; registration, weight and events need baggage.manage.
 * The API authorizes every call and derives every projection.
 */
export function BaggageAdmin() {
  const typeId = useId();
  const statusId = useId();
  const exceptionId = useId();
  const canManage = useCan('baggage.manage');
  const [type, setType] = useState<BaggageType | ''>('');
  const [lifecycleStatus, setLifecycleStatus] = useState<BaggageLifecycleStatus | ''>('');
  const [exceptionStatus, setExceptionStatus] = useState<BaggageExceptionStatus | ''>('');
  const [reference, setReference] = useState('');
  const [bookingReference, setBookingReference] = useState('');
  const [tripReference, setTripReference] = useState('');
  const [applied, setApplied] = useState({
    reference: '',
    bookingReference: '',
    tripReference: '',
  });
  const [qrPayload, setQrPayload] = useState('');
  const [items, setItems] = useState<Baggage[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<BaggageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.baggage.list({
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(type ? { type } : {}),
        ...(lifecycleStatus ? { lifecycleStatus } : {}),
        ...(exceptionStatus ? { exceptionStatus } : {}),
        ...(applied.reference ? { reference: applied.reference } : {}),
        ...(applied.bookingReference ? { bookingReference: applied.bookingReference } : {}),
        ...(applied.tripReference ? { tripReference: applied.tripReference } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [applied, exceptionStatus, lifecycleStatus, type],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (value: string) => {
    setError(null);
    const result = await auth.admin.baggage.detail(value);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const changed = async (value: string, message: string) => {
    setNotice(message);
    await Promise.all([select(value), load()]);
  };

  const filter = (event: FormEvent) => {
    event.preventDefault();
    setApplied({
      reference: reference.trim().toUpperCase(),
      bookingReference: bookingReference.trim().toUpperCase(),
      tripReference: tripReference.trim().toUpperCase(),
    });
  };

  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await auth.admin.baggage.resolveQr(qrPayload.trim());
    if (result.ok) {
      setDetail(result.data);
      setQrPayload('');
    } else setError(result.error.message);
  };

  return (
    <div className="et-network" data-testid="baggage-workspace">
      <p>
        Bagages enregistrés sur des voyageurs de réservations confirmées. Le statut est une
        projection de l’historique : il ne se modifie qu’en enregistrant un événement.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
      <form className="et-form et-network-form" aria-label="Résoudre un code QR" onSubmit={resolve}>
        <TextField
          label="Code QR scanné"
          name="qrPayload"
          value={qrPayload}
          onChange={setQrPayload}
          autoComplete="off"
          maxLength={64}
        />
        <button type="submit" className="et-button et-button--secondary">
          Rechercher le bagage
        </button>
      </form>
      <form className="et-form et-network-form" aria-label="Filtrer les bagages" onSubmit={filter}>
        <div className="et-network-adders">
          <TextField
            label="Référence bagage"
            name="reference"
            value={reference}
            onChange={setReference}
            autoComplete="off"
            required={false}
            maxLength={16}
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
            label="Référence voyage"
            name="tripReference"
            value={tripReference}
            onChange={setTripReference}
            autoComplete="off"
            required={false}
            maxLength={32}
          />
          <div className="et-field">
            <label htmlFor={typeId}>Type</label>
            <select
              id={typeId}
              className="et-select"
              value={type}
              onChange={(event) => setType(event.target.value as BaggageType | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(TYPE_LABELS) as BaggageType[]).map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="et-field">
            <label htmlFor={statusId}>Statut</label>
            <select
              id={statusId}
              className="et-select"
              value={lifecycleStatus}
              onChange={(event) =>
                setLifecycleStatus(event.target.value as BaggageLifecycleStatus | '')
              }
            >
              <option value="">Tous</option>
              {(Object.keys(LIFECYCLE_LABELS) as BaggageLifecycleStatus[]).map((value) => (
                <option key={value} value={value}>
                  {LIFECYCLE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="et-field">
            <label htmlFor={exceptionId}>Incident</label>
            <select
              id={exceptionId}
              className="et-select"
              value={exceptionStatus}
              onChange={(event) =>
                setExceptionStatus(event.target.value as BaggageExceptionStatus | '')
              }
            >
              <option value="">Tous</option>
              {(Object.keys(EXCEPTION_LABELS) as BaggageExceptionStatus[]).map((value) => (
                <option key={value} value={value}>
                  {EXCEPTION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="submit" className="et-button">
          Filtrer
        </button>
      </form>

      {detail ? <Detail baggage={detail} canManage={canManage} onChanged={changed} /> : null}
      <section aria-labelledby="baggage-list-title">
        <h2 id="baggage-list-title">Bagages</h2>
        {!items ? <p role="status">Chargement des bagages…</p> : null}
        {items ? (
          <div className="et-table-wrap">
            <table>
              <caption>Bagages et statut courant</caption>
              <thead>
                <tr>
                  <th>Bagage</th>
                  <th>Voyageur</th>
                  <th>Réservation · voyage</th>
                  <th>Type</th>
                  <th>Statut</th>
                  <th>Incident</th>
                  <th>Poids</th>
                  <th>Franchise · excédent</th>
                  <th>Créé le</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.reference}>
                    <td className="et-code">{item.reference}</td>
                    <td>
                      {item.passenger.givenName} {item.passenger.familyName}
                      <br />
                      <span className="et-code">{item.passenger.reference}</span>
                    </td>
                    <td>
                      <span className="et-code">{item.booking.reference}</span>
                      <br />
                      <span className="et-code">{item.booking.trip.reference}</span>
                    </td>
                    <td>{TYPE_LABELS[item.type]}</td>
                    <td>{LIFECYCLE_LABELS[item.lifecycleStatus]}</td>
                    <td>{item.exceptionStatus ? EXCEPTION_LABELS[item.exceptionStatus] : '—'}</td>
                    <td>{formatWeight(item.measuredWeightKg)}</td>
                    <td>{allowanceLabel(item)}</td>
                    <td>{formatAt(item.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        onClick={() => void select(item.reference)}
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
        {items?.length === 0 ? <p>Aucun bagage.</p> : null}
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
    </div>
  );
}
