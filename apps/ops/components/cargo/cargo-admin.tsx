'use client';

import type {
  RoadFreightDirection,
  RoadFreightExceptionStatus,
  RoadFreightLifecycleStatus,
  RoadFreightOperationalEventType,
  RoadFreightShipment,
  RoadFreightShipmentDetail,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { CargoQuotePanel } from './cargo-quote-panel';
import { CargoTrackingPanel } from './cargo-tracking-panel';

const DIRECTION_LABELS: Record<RoadFreightDirection, string> = {
  PAR_DKR: 'Paris → Dakar',
  DKR_PAR: 'Dakar → Paris',
};

const STATUS_LABELS: Record<RoadFreightLifecycleStatus, string> = {
  QUOTE: 'Demande / devis',
  BOOKED: 'Réservé',
  RECEIVED: 'Reçu',
  INSPECTED: 'Contrôlé',
  ASSIGNED: 'Affecté',
  LOADED: 'Chargé',
  DEPARTED: 'Parti',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  AVAILABLE: 'Disponible',
  DELIVERED: 'Livré',
  REFUSED: 'Refusé',
  CANCELLED: 'Annulé',
};

const EXCEPTION_LABELS: Record<RoadFreightExceptionStatus, string> = {
  HELD: 'Bloqué',
  CUSTOMS_HOLD: 'Retenu en douane',
  DAMAGED: 'Endommagé',
};

const EVENT_LABELS: Record<RoadFreightOperationalEventType, string> = {
  BOOKED: 'Réserver',
  RECEIVED: 'Réceptionner',
  INSPECTED: 'Contrôler',
  LOADED: 'Charger',
  DEPARTED: 'Départ',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  AVAILABLE: 'Disponible au retrait',
  DELIVERED: 'Livré',
  REFUSED: 'Refusé',
  CANCELLED: 'Annulé',
  HELD: 'Bloquer',
  CUSTOMS_HOLD: 'Retenu en douane',
  DAMAGED: 'Signaler endommagé',
  EXCEPTION_RESOLVED: 'Résoudre l’incident',
};

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Display tone only: the lifecycle is projected by the API from the operational events. */
const STATUS_TONES: Record<RoadFreightLifecycleStatus, Tone> = {
  QUOTE: 'neutral',
  BOOKED: 'info',
  RECEIVED: 'info',
  INSPECTED: 'info',
  ASSIGNED: 'info',
  LOADED: 'info',
  DEPARTED: 'info',
  IN_TRANSIT: 'info',
  ARRIVED: 'success',
  AVAILABLE: 'success',
  DELIVERED: 'success',
  REFUSED: 'danger',
  CANCELLED: 'neutral',
};

const EXCEPTION_TONES: Record<RoadFreightExceptionStatus, Tone> = {
  HELD: 'danger',
  CUSTOMS_HOLD: 'warning',
  DAMAGED: 'danger',
};

const AWAITING_RECEPTION: readonly RoadFreightLifecycleStatus[] = ['QUOTE', 'BOOKED'];
const IN_HANDLING: readonly RoadFreightLifecycleStatus[] = [
  'RECEIVED',
  'INSPECTED',
  'ASSIGNED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
];

const OPERATIONAL_EVENTS = Object.keys(EVENT_LABELS) as RoadFreightOperationalEventType[];

const CREATE_FLAG_OPTIONS = [
  ['fragile', 'Fragile'],
  ['professional', 'Professionnel'],
  ['pickupRequired', 'Collecte demandée'],
  ['deliveryRequired', 'Livraison demandée'],
] as const;

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
const formatWeight = (value: string) => `${value.replace('.', ',')} kg`;
const formatVolume = (liters: number) =>
  `${liters.toLocaleString('fr-FR')} L · ${(liters / 1000).toLocaleString('fr-FR', {
    maximumFractionDigits: 3,
  })} m³`;

const EMPTY_CREATE = {
  direction: 'PAR_DKR' as RoadFreightDirection,
  bookingReference: '',
  customerIdentityId: '',
  senderName: '',
  senderContact: '',
  recipientName: '',
  recipientContact: '',
  weightKg: '',
  volumeLiters: '',
  packageCount: '1',
  declaredContents: '',
  fragile: false,
  professional: false,
  pickupRequired: false,
  deliveryRequired: false,
};

function CargoDetail({
  shipment,
  canManage,
  canReadPricing,
  canManagePricing,
  onChanged,
}: {
  shipment: RoadFreightShipmentDetail;
  canManage: boolean;
  canReadPricing: boolean;
  canManagePricing: boolean;
  onChanged: (reference: string, message: string) => Promise<void>;
}) {
  const eventId = useId();
  const [eventType, setEventType] = useState<RoadFreightOperationalEventType>('BOOKED');
  const [tripReference, setTripReference] = useState(shipment.trip?.reference ?? '');
  const [vehicleCode, setVehicleCode] = useState(shipment.vehicle?.code ?? '');
  const [weightKg, setWeightKg] = useState(shipment.weightKg);
  const [volumeLiters, setVolumeLiters] = useState(String(shipment.volumeLiters));
  const [packageCount, setPackageCount] = useState(String(shipment.packageCount));
  const [declaredContents, setDeclaredContents] = useState(shipment.declaredContents);
  const [senderContact, setSenderContact] = useState(shipment.senderContact);
  const [recipientContact, setRecipientContact] = useState(shipment.recipientContact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTripReference(shipment.trip?.reference ?? '');
    setVehicleCode(shipment.vehicle?.code ?? '');
    setWeightKg(shipment.weightKg);
    setVolumeLiters(String(shipment.volumeLiters));
    setPackageCount(String(shipment.packageCount));
    setDeclaredContents(shipment.declaredContents);
    setSenderContact(shipment.senderContact);
    setRecipientContact(shipment.recipientContact);
  }, [shipment]);

  const run = async (
    action: () => ReturnType<typeof auth.admin.cargo.recordEvent>,
    message: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await onChanged(shipment.reference, message);
    } finally {
      setBusy(false);
    }
  };

  const submitEvent = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => auth.admin.cargo.recordEvent(shipment.reference, { type: eventType }),
      `Événement « ${EVENT_LABELS[eventType]} » enregistré.`,
    );
  };

  const submitAssignment = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.cargo.assign(shipment.reference, {
        tripReference: tripReference.trim().toUpperCase(),
        vehicleCode: vehicleCode.trim().toUpperCase(),
        expectedTripReference: shipment.trip?.reference ?? null,
        expectedVehicleCode: shipment.vehicle?.code ?? null,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await onChanged(shipment.reference, 'Affectation voyage/véhicule enregistrée.');
    } finally {
      setBusy(false);
    }
  };

  const submitFacts = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.cargo.update(shipment.reference, {
        weightKg: weightKg.trim().replace(',', '.'),
        volumeLiters: Number(volumeLiters),
        packageCount: Number(packageCount),
        declaredContents,
        senderContact,
        recipientContact,
        expectedUpdatedAt: shipment.updatedAt,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await onChanged(shipment.reference, 'Caractéristiques du fret mises à jour.');
    } finally {
      setBusy(false);
    }
  };

  const editable = ![
    'LOADED',
    'DEPARTED',
    'IN_TRANSIT',
    'ARRIVED',
    'AVAILABLE',
    'DELIVERED',
    'REFUSED',
    'CANCELLED',
  ].includes(shipment.lifecycleStatus);
  const assignable = ['INSPECTED', 'ASSIGNED'].includes(shipment.lifecycleStatus);

  return (
    <section
      className="et-network-panel ops-ground-detail"
      aria-labelledby={`cargo-${shipment.reference}`}
      data-testid="cargo-detail"
    >
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">
            Fiche envoi · {DIRECTION_LABELS[shipment.direction]}
          </p>
          <h2 id={`cargo-${shipment.reference}`}>Colis & fret {shipment.reference}</h2>
        </div>
        <div className="ops-ground-badges">
          <OpsStatusBadge tone={STATUS_TONES[shipment.lifecycleStatus]} className="et-tag">
            {STATUS_LABELS[shipment.lifecycleStatus]}
          </OpsStatusBadge>
          {shipment.exceptionStatus ? (
            <OpsStatusBadge tone={EXCEPTION_TONES[shipment.exceptionStatus]} className="et-tag">
              {EXCEPTION_LABELS[shipment.exceptionStatus]}
            </OpsStatusBadge>
          ) : null}
        </div>
      </div>

      <dl className="ops-ground-facts">
        <div>
          <dt>Sens</dt>
          <dd>{DIRECTION_LABELS[shipment.direction]}</dd>
        </div>
        <div>
          <dt>Expéditeur</dt>
          <dd>
            {shipment.senderName} · {shipment.senderContact}
          </dd>
        </div>
        <div>
          <dt>Destinataire</dt>
          <dd>
            {shipment.recipientName} · {shipment.recipientContact}
          </dd>
        </div>
        <div>
          <dt>Poids</dt>
          <dd data-testid="cargo-weight">{formatWeight(shipment.weightKg)}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>{formatVolume(shipment.volumeLiters)}</dd>
        </div>
        <div>
          <dt>Pièces</dt>
          <dd>{shipment.packageCount}</dd>
        </div>
        <div>
          <dt>Contenu déclaré</dt>
          <dd>{shipment.declaredContents}</dd>
        </div>
        <div>
          <dt>Réservation</dt>
          <dd className="et-code">{shipment.booking?.reference ?? '—'}</dd>
        </div>
        <div>
          <dt>Client</dt>
          <dd>
            {shipment.customer ? (
              <>
                {shipment.customer.email} · <span className="et-code">{shipment.customer.id}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Voyage</dt>
          <dd className="et-code">{shipment.trip?.reference ?? 'Non affecté'}</dd>
        </div>
        <div>
          <dt>Véhicule</dt>
          <dd className="et-code">{shipment.vehicle?.code ?? 'Non affecté'}</dd>
        </div>
      </dl>

      <FormAlert message={error} />

      <CargoTrackingPanel
        key={`tracking-${shipment.reference}`}
        shipmentReference={shipment.reference}
        canManage={canManage}
      />

      <CargoQuotePanel
        key={shipment.reference}
        shipmentReference={shipment.reference}
        canRead={canReadPricing}
        canManage={canManage && canManagePricing}
      />

      {canManage ? (
        <div className="ops-ground-forms">
          {editable ? (
            <form
              className="et-form ops-ground-form ops-ground-form--wide"
              aria-label="Modifier les caractéristiques du fret"
              onSubmit={submitFacts}
            >
              <p className="ops-operations-section-kicker">Caractéristiques déclarées</p>
              <div className="et-network-adders">
                <TextField
                  label="Poids (kg)"
                  name="cargoWeightKg"
                  value={weightKg}
                  onChange={setWeightKg}
                  autoComplete="off"
                  maxLength={9}
                />
                <TextField
                  label="Volume (litres)"
                  name="cargoVolumeLiters"
                  value={volumeLiters}
                  onChange={setVolumeLiters}
                  autoComplete="off"
                />
                <TextField
                  label="Nombre de pièces"
                  name="cargoPackageCount"
                  value={packageCount}
                  onChange={setPackageCount}
                  autoComplete="off"
                />
                <TextField
                  label="Contact expéditeur"
                  name="cargoSenderContact"
                  value={senderContact}
                  onChange={setSenderContact}
                  autoComplete="off"
                />
                <TextField
                  label="Contact destinataire"
                  name="cargoRecipientContact"
                  value={recipientContact}
                  onChange={setRecipientContact}
                  autoComplete="off"
                />
                <TextField
                  label="Contenu déclaré"
                  name="cargoDeclaredContents"
                  value={declaredContents}
                  onChange={setDeclaredContents}
                  autoComplete="off"
                  maxLength={500}
                />
              </div>
              <button type="submit" className="et-button" disabled={busy}>
                Enregistrer les caractéristiques
              </button>
            </form>
          ) : null}

          {assignable ? (
            <form
              className="et-form ops-ground-form"
              aria-label="Affecter le fret"
              onSubmit={submitAssignment}
            >
              <p className="ops-operations-section-kicker">Affectation voyage / véhicule</p>
              <div className="et-network-adders">
                <TextField
                  label="Référence voyage"
                  name="cargoTripReference"
                  value={tripReference}
                  onChange={setTripReference}
                  autoComplete="off"
                  maxLength={32}
                />
                <TextField
                  label="Code véhicule"
                  name="cargoVehicleCode"
                  value={vehicleCode}
                  onChange={setVehicleCode}
                  autoComplete="off"
                  maxLength={32}
                />
              </div>
              <button type="submit" className="et-button" disabled={busy}>
                {shipment.lifecycleStatus === 'ASSIGNED' ? 'Réaffecter' : 'Affecter'}
              </button>
            </form>
          ) : null}

          {!['DELIVERED', 'REFUSED', 'CANCELLED'].includes(shipment.lifecycleStatus) ? (
            <form
              className="et-form ops-ground-form"
              aria-label="Enregistrer un événement fret"
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
                    setEventType(event.target.value as RoadFreightOperationalEventType)
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
          ) : null}
        </div>
      ) : null}

      <div className="et-table-wrap">
        <table className="et-table" data-testid="cargo-timeline">
          <caption>Historique opérationnel immuable</caption>
          <thead>
            <tr>
              <th scope="col">N°</th>
              <th scope="col">Événement</th>
              <th scope="col">Statut</th>
              <th scope="col">Incident</th>
              <th scope="col">Survenu le</th>
              <th scope="col">Lieu</th>
            </tr>
          </thead>
          <tbody>
            {shipment.events.map((event) => (
              <tr key={event.sequence}>
                <td>{event.sequence}</td>
                <td className="et-code">{event.type}</td>
                <td>{STATUS_LABELS[event.lifecycleStatus]}</td>
                <td>{event.exceptionStatus ? EXCEPTION_LABELS[event.exceptionStatus] : '—'}</td>
                <td>{formatAt(event.occurredAt)}</td>
                <td>{event.location?.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CargoAdmin() {
  const directionFilterId = useId();
  const statusFilterId = useId();
  const eventDirectionId = useId();
  const canManage = useCan('cargo.manage');
  const canReadPricing = useCan('pricing.read');
  const canManagePricing = useCan('pricing.manage');

  const [create, setCreate] = useState(EMPTY_CREATE);
  const [reference, setReference] = useState('');
  const [qrPayload, setQrPayload] = useState('');
  const [tripReference, setTripReference] = useState('');
  const [vehicleCode, setVehicleCode] = useState('');
  const [direction, setDirection] = useState<RoadFreightDirection | ''>('');
  const [lifecycleStatus, setLifecycleStatus] = useState<RoadFreightLifecycleStatus | ''>('');
  const [applied, setApplied] = useState({
    reference: '',
    tripReference: '',
    vehicleCode: '',
  });
  const [items, setItems] = useState<RoadFreightShipment[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoadFreightShipmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.cargo.list({
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(applied.reference ? { reference: applied.reference } : {}),
        ...(applied.tripReference ? { tripReference: applied.tripReference } : {}),
        ...(applied.vehicleCode ? { vehicleCode: applied.vehicleCode } : {}),
        ...(direction ? { direction } : {}),
        ...(lifecycleStatus ? { lifecycleStatus } : {}),
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
    [applied, direction, lifecycleStatus],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (value: string) => {
    setError(null);
    const result = await auth.admin.cargo.detail(value);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };

  const changed = async (value: string, message: string) => {
    setNotice(message);
    await Promise.all([select(value), load()]);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.cargo.create({
        direction: create.direction,
        ...(create.bookingReference.trim()
          ? { bookingReference: create.bookingReference.trim().toUpperCase() }
          : {}),
        ...(create.customerIdentityId.trim()
          ? { customerIdentityId: create.customerIdentityId.trim().toLowerCase() }
          : {}),
        senderName: create.senderName,
        senderContact: create.senderContact,
        recipientName: create.recipientName,
        recipientContact: create.recipientContact,
        weightKg: create.weightKg.trim().replace(',', '.'),
        volumeLiters: Number(create.volumeLiters),
        packageCount: Number(create.packageCount),
        declaredContents: create.declaredContents,
        fragile: create.fragile,
        professional: create.professional,
        pickupRequired: create.pickupRequired,
        deliveryRequired: create.deliveryRequired,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCreate(EMPTY_CREATE);
      setDetail(result.data);
      setNotice(`Fret ${result.data.reference} créé.`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const filter = (event: FormEvent) => {
    event.preventDefault();
    setApplied({
      reference: reference.trim().toUpperCase(),
      tripReference: tripReference.trim().toUpperCase(),
      vehicleCode: vehicleCode.trim().toUpperCase(),
    });
  };

  const resolveQr = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await auth.admin.cargo.resolveQr(qrPayload.trim());
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDetail(result.data);
    setQrPayload('');
    setNotice(`Fret ${result.data.reference} identifié par QR.`);
  };

  const visible = items ?? [];
  const awaitingCount = visible.filter((item) =>
    AWAITING_RECEPTION.includes(item.lifecycleStatus),
  ).length;
  const handlingCount = visible.filter((item) => IN_HANDLING.includes(item.lifecycleStatus)).length;
  const exceptionCount = visible.filter((item) => item.exceptionStatus !== null).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-cargo-workspace"
      data-testid="cargo-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Fret routier Paris ↔ Dakar</p>
          <h2>Exploitation colis & fret</h2>
          <p>
            Colis et fret routier distincts des bagages voyageurs. CARGO-PRICE-1 ajoute des devis
            commerciaux versionnés ; les paiements et la comptabilisation Finance restent séparés.
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
        <section className="ops-operations-kpis" aria-label="Indicateurs des envois affichés">
          <OpsKpiCard
            label="Envois affichés"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Tous les envois filtrés sont chargés'
            }
            icon="cargo"
            tone="info"
          />
          <OpsKpiCard
            label="À réceptionner"
            value={awaitingCount}
            helper="Demandes, devis ou réservés"
            icon="booking"
            tone={awaitingCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="En traitement ou en route"
            value={handlingCount}
            helper="Reçus, contrôlés, affectés, chargés ou partis"
            icon="bus"
            tone="info"
          />
          <OpsKpiCard
            label="Avec incident"
            value={exceptionCount}
            helper="Bloqué, retenu en douane ou endommagé"
            icon="alert"
            tone={exceptionCount > 0 ? 'danger' : 'neutral'}
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {items.length} envois chargés.
        </p>
      ) : null}

      <div className="ops-ground-tools">
        <form
          className="et-form et-network-form ops-ground-panel ops-ground-scan"
          aria-label="Résoudre un QR fret"
          onSubmit={resolveQr}
        >
          <p className="ops-operations-section-kicker">Lecture d’étiquette</p>
          <TextField
            label="Code QR fret"
            name="cargoQrPayload"
            value={qrPayload}
            onChange={setQrPayload}
            autoComplete="off"
            maxLength={64}
          />
          <button type="submit" className="et-button et-button--secondary">
            Rechercher le fret
          </button>
        </form>
        <form
          className="et-form et-network-form ops-ground-panel"
          aria-label="Filtrer les colis et fret"
          onSubmit={filter}
        >
          <p className="ops-operations-section-kicker">Filtres</p>
          <div className="et-network-adders">
            <TextField
              label="Référence fret"
              name="cargoReference"
              value={reference}
              onChange={setReference}
              required={false}
              autoComplete="off"
              maxLength={16}
            />
            <TextField
              label="Référence voyage"
              name="cargoFilterTrip"
              value={tripReference}
              onChange={setTripReference}
              required={false}
              autoComplete="off"
              maxLength={32}
            />
            <TextField
              label="Code véhicule"
              name="cargoFilterVehicle"
              value={vehicleCode}
              onChange={setVehicleCode}
              required={false}
              autoComplete="off"
              maxLength={32}
            />
            <div className="et-field">
              <label htmlFor={directionFilterId}>Sens</label>
              <select
                id={directionFilterId}
                className="et-select"
                value={direction}
                onChange={(event) => setDirection(event.target.value as RoadFreightDirection | '')}
              >
                <option value="">Tous</option>
                {(Object.keys(DIRECTION_LABELS) as RoadFreightDirection[]).map((value) => (
                  <option key={value} value={value}>
                    {DIRECTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="et-field">
              <label htmlFor={statusFilterId}>Statut</label>
              <select
                id={statusFilterId}
                className="et-select"
                value={lifecycleStatus}
                onChange={(event) =>
                  setLifecycleStatus(event.target.value as RoadFreightLifecycleStatus | '')
                }
              >
                <option value="">Tous</option>
                {(Object.keys(STATUS_LABELS) as RoadFreightLifecycleStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
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

      {canManage ? (
        <form
          className="et-form et-network-form ops-ground-panel"
          aria-label="Créer un colis ou fret"
          onSubmit={submitCreate}
        >
          <div>
            <p className="ops-operations-section-kicker">Prise en charge</p>
            <h2>Nouveau colis / fret</h2>
          </div>
          <div className="et-network-adders">
            <div className="et-field">
              <label htmlFor={eventDirectionId}>Sens</label>
              <select
                id={eventDirectionId}
                className="et-select"
                value={create.direction}
                onChange={(event) =>
                  setCreate((value) => ({
                    ...value,
                    direction: event.target.value as RoadFreightDirection,
                  }))
                }
              >
                {(Object.keys(DIRECTION_LABELS) as RoadFreightDirection[]).map((value) => (
                  <option key={value} value={value}>
                    {DIRECTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label="Référence réservation (facultatif)"
              name="cargoBookingReference"
              value={create.bookingReference}
              onChange={(value) => setCreate((state) => ({ ...state, bookingReference: value }))}
              required={false}
              autoComplete="off"
              maxLength={16}
            />
            <TextField
              label="Identifiant client (facultatif)"
              name="cargoCustomerIdentityId"
              value={create.customerIdentityId}
              onChange={(value) => setCreate((state) => ({ ...state, customerIdentityId: value }))}
              required={false}
              autoComplete="off"
              maxLength={36}
            />
            <TextField
              label="Expéditeur"
              name="cargoSenderName"
              value={create.senderName}
              onChange={(value) => setCreate((state) => ({ ...state, senderName: value }))}
              autoComplete="off"
              maxLength={160}
            />
            <TextField
              label="Contact expéditeur"
              name="cargoSenderContact"
              value={create.senderContact}
              onChange={(value) => setCreate((state) => ({ ...state, senderContact: value }))}
              autoComplete="off"
              maxLength={200}
            />
            <TextField
              label="Destinataire"
              name="cargoRecipientName"
              value={create.recipientName}
              onChange={(value) => setCreate((state) => ({ ...state, recipientName: value }))}
              autoComplete="off"
              maxLength={160}
            />
            <TextField
              label="Contact destinataire"
              name="cargoRecipientContact"
              value={create.recipientContact}
              onChange={(value) => setCreate((state) => ({ ...state, recipientContact: value }))}
              autoComplete="off"
              maxLength={200}
            />
            <TextField
              label="Poids (kg)"
              name="cargoWeight"
              value={create.weightKg}
              onChange={(value) => setCreate((state) => ({ ...state, weightKg: value }))}
              autoComplete="off"
              maxLength={9}
            />
            <TextField
              label="Volume (litres)"
              name="cargoVolume"
              value={create.volumeLiters}
              onChange={(value) => setCreate((state) => ({ ...state, volumeLiters: value }))}
              autoComplete="off"
            />
            <TextField
              label="Nombre de pièces"
              name="cargoPieces"
              value={create.packageCount}
              onChange={(value) => setCreate((state) => ({ ...state, packageCount: value }))}
              autoComplete="off"
            />
            <TextField
              label="Contenu déclaré"
              name="cargoContents"
              value={create.declaredContents}
              onChange={(value) => setCreate((state) => ({ ...state, declaredContents: value }))}
              autoComplete="off"
              maxLength={500}
            />
          </div>
          <div className="et-actions ops-ground-flags">
            {CREATE_FLAG_OPTIONS.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={create[key]}
                  onChange={(event) =>
                    setCreate((state) => ({ ...state, [key]: event.target.checked }))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </div>
          <button type="submit" className="et-button" disabled={busy}>
            Créer
          </button>
        </form>
      ) : null}

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="cargo-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Registre des envois</p>
            <h2 id="cargo-list-title">Colis & fret</h2>
          </div>
        </div>
        {!items && !error ? <OpsLoadingState title="Chargement des envois…" /> : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Fret routier et statut courant</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Sens</th>
                  <th scope="col">Expéditeur → destinataire</th>
                  <th scope="col">Poids</th>
                  <th scope="col">Volume</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Voyage / véhicule</th>
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
                    <td>{DIRECTION_LABELS[item.direction]}</td>
                    <td>
                      {item.senderName} → {item.recipientName}
                    </td>
                    <td>{formatWeight(item.weightKg)}</td>
                    <td>{formatVolume(item.volumeLiters)}</td>
                    <td>
                      <OpsStatusBadge tone={STATUS_TONES[item.lifecycleStatus]}>
                        {STATUS_LABELS[item.lifecycleStatus]}
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
                    <td>
                      <span className="et-code">{item.trip?.reference ?? '—'}</span>
                      <br />
                      <span className="et-code">{item.vehicle?.code ?? '—'}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter l’envoi ${item.reference}`}
                        aria-controls="cargo-detail-panel"
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
            title="Aucun colis ou fret"
            description="Aucun envoi ne correspond aux filtres actuellement appliqués."
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
          id="cargo-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
          <CargoDetail
            shipment={detail}
            canManage={canManage}
            canReadPricing={canReadPricing}
            canManagePricing={canManagePricing}
            onChanged={changed}
          />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
