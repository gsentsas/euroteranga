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
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
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

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Display tone only: the lifecycle itself is projected by the API from the event history. */
const LIFECYCLE_TONES: Record<BaggageLifecycleStatus, Tone> = {
  REGISTERED: 'neutral',
  CHECKED_IN: 'info',
  LOADED: 'info',
  IN_TRANSIT: 'info',
  ARRIVED: 'success',
  DELIVERED: 'success',
  REMOVED: 'neutral',
};

const EXCEPTION_TONES: Record<BaggageExceptionStatus, Tone> = {
  MISSING: 'danger',
  DAMAGED: 'danger',
  HELD_BY_CUSTOMS: 'warning',
};

const IN_HANDLING: readonly BaggageLifecycleStatus[] = ['CHECKED_IN', 'LOADED', 'IN_TRANSIT'];

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
      className="et-network-panel ops-ground-detail"
      aria-labelledby={`baggage-${baggage.reference}`}
      data-testid="baggage-detail"
    >
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">Fiche bagage</p>
          <h2 id={`baggage-${baggage.reference}`}>Bagage {baggage.reference}</h2>
        </div>
        <div className="ops-ground-badges">
          <OpsStatusBadge tone={LIFECYCLE_TONES[baggage.lifecycleStatus]} className="et-tag">
            {LIFECYCLE_LABELS[baggage.lifecycleStatus]}
          </OpsStatusBadge>
          {baggage.exceptionStatus ? (
            <OpsStatusBadge tone={EXCEPTION_TONES[baggage.exceptionStatus]} className="et-tag">
              {EXCEPTION_LABELS[baggage.exceptionStatus]}
            </OpsStatusBadge>
          ) : null}
        </div>
      </div>
      <dl className="ops-ground-facts">
        <div>
          <dt>Voyageur</dt>
          <dd>
            {baggage.passenger.givenName} {baggage.passenger.familyName} ·{' '}
            <span className="et-code">{baggage.passenger.reference}</span>
          </dd>
        </div>
        <div>
          <dt>Réservation</dt>
          <dd className="et-code">{baggage.booking.reference}</dd>
        </div>
        <div>
          <dt>Voyage</dt>
          <dd>
            <span className="et-code">{baggage.booking.trip.reference}</span> ·{' '}
            {baggage.booking.trip.route.name}
            {baggage.booking.trip.plannedDepartureAt
              ? ` · départ ${formatAt(baggage.booking.trip.plannedDepartureAt)}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{TYPE_LABELS[baggage.type]}</dd>
        </div>
        <div>
          <dt>Poids mesuré</dt>
          <dd data-testid="baggage-weight">{formatWeight(baggage.measuredWeightKg)}</dd>
        </div>
        <div>
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
        </div>
        <div>
          <dt>Résultat commercial</dt>
          <dd>{allowanceLabel(baggage)}</dd>
        </div>
        <div>
          <dt>Code QR</dt>
          <dd className="et-code">{baggage.qrPayload}</dd>
        </div>
      </dl>
      <p className="ops-ground-guardrail">
        Le code QR identifie seulement le bagage : chaque action exige une session STAFF et la
        permission correspondante. La franchise est historique et le supplément éventuel est
        recalculé uniquement lorsqu’un poids officiel est enregistré. Aucun paiement n’est créé.
      </p>
      <FormAlert message={error} />
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
            <img src={qr} alt={`QR code du bagage ${baggage.reference}`} width={180} height={180} />
            <figcaption className="et-code">{baggage.reference}</figcaption>
          </figure>
        ) : null}
      </div>

      {canManage && baggage.lifecycleStatus !== 'REMOVED' ? (
        <div className="ops-ground-forms">
          <form
            className="et-form ops-ground-form"
            aria-label="Enregistrer le poids"
            onSubmit={submitWeight}
          >
            <p className="ops-operations-section-kicker">Pesée officielle</p>
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
          <form
            className="et-form ops-ground-form"
            aria-label="Enregistrer un événement"
            onSubmit={submitEvent}
          >
            <p className="ops-operations-section-kicker">Événement opérationnel</p>
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
            <p className="ops-ground-form__hint">
              Le serveur refuse toute transition non autorisée par le cycle de vie.
            </p>
            <button type="submit" className="et-button" disabled={busy}>
              Enregistrer l’événement
            </button>
          </form>
        </div>
      ) : null}

      <div className="et-table-wrap">
        <table className="et-table" data-testid="baggage-timeline">
          <caption>Historique immuable</caption>
          <thead>
            <tr>
              <th scope="col">N°</th>
              <th scope="col">Événement</th>
              <th scope="col">Statut</th>
              <th scope="col">Incident</th>
              <th scope="col">Poids</th>
              <th scope="col">Survenu le</th>
              <th scope="col">Lieu</th>
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

  const visible = items ?? [];
  const unweighedCount = visible.filter((item) => item.measuredWeightKg === null).length;
  const handlingCount = visible.filter((item) => IN_HANDLING.includes(item.lifecycleStatus)).length;
  const exceptionCount = visible.filter((item) => item.exceptionStatus !== null).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-baggage-workspace"
      data-testid="baggage-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Exploitation bagages</p>
          <h2>Suivi opérationnel des bagages voyageurs</h2>
          <p>
            Bagages enregistrés sur des voyageurs de réservations confirmées. Le statut est une
            projection de l’historique : il ne se modifie qu’en enregistrant un événement.
          </p>
        </div>
      </div>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {items ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des bagages affichés">
          <OpsKpiCard
            label="Bagages affichés"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Tous les bagages filtrés sont chargés'
            }
            icon="baggage"
            tone="info"
          />
          <OpsKpiCard
            label="Non pesés"
            value={unweighedCount}
            helper="Parmi les bagages affichés"
            icon="audit"
            tone={unweighedCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Pris en charge ou en transit"
            value={handlingCount}
            helper="Pris en charge, chargés ou en transit"
            icon="bus"
            tone="info"
          />
          <OpsKpiCard
            label="Avec incident"
            value={exceptionCount}
            helper="Introuvable, endommagé ou retenu"
            icon="alert"
            tone={exceptionCount > 0 ? 'danger' : 'neutral'}
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {items.length} bagages chargés.
        </p>
      ) : null}

      <div className="ops-ground-tools">
        <form
          className="et-form et-network-form ops-ground-panel ops-ground-scan"
          aria-label="Résoudre un code QR"
          onSubmit={resolve}
        >
          <p className="ops-operations-section-kicker">Lecture d’étiquette</p>
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
        <form
          className="et-form et-network-form ops-ground-panel"
          aria-label="Filtrer les bagages"
          onSubmit={filter}
        >
          <p className="ops-operations-section-kicker">Filtres</p>
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
      </div>

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="baggage-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Registre des bagages</p>
            <h2 id="baggage-list-title">Bagages</h2>
          </div>
        </div>
        {!items && !error ? <OpsLoadingState title="Chargement des bagages…" /> : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Bagages et statut courant</caption>
              <thead>
                <tr>
                  <th scope="col">Bagage</th>
                  <th scope="col">Voyageur</th>
                  <th scope="col">Réservation · voyage</th>
                  <th scope="col">Type</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Poids</th>
                  <th scope="col">Franchise · excédent</th>
                  <th scope="col">Créé le</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.reference}
                    className={
                      detail?.reference === item.reference ? 'ops-table-row--selected' : undefined
                    }
                  >
                    <th scope="row" className="et-code">
                      {item.reference}
                    </th>
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
                    <td>
                      <OpsStatusBadge tone={LIFECYCLE_TONES[item.lifecycleStatus]}>
                        {LIFECYCLE_LABELS[item.lifecycleStatus]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      {item.exceptionStatus ? (
                        <OpsStatusBadge tone={EXCEPTION_TONES[item.exceptionStatus]}>
                          {EXCEPTION_LABELS[item.exceptionStatus]}
                        </OpsStatusBadge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatWeight(item.measuredWeightKg)}</td>
                    <td>{allowanceLabel(item)}</td>
                    <td>{formatAt(item.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter le bagage ${item.reference}`}
                        aria-controls="baggage-detail-panel"
                        aria-expanded={detail?.reference === item.reference}
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
        {items?.length === 0 ? (
          <OpsEmptyState
            title="Aucun bagage"
            description="Aucun bagage ne correspond aux filtres actuellement appliqués."
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

      {detail ? (
        <OpsDetailRegion
          id="baggage-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
          <Detail baggage={detail} canManage={canManage} onChanged={changed} />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
