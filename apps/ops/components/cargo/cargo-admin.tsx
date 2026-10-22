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
      className="et-network-panel"
      aria-labelledby={`cargo-${shipment.reference}`}
      data-testid="cargo-detail"
    >
      <div className="et-actions">
        <h2 id={`cargo-${shipment.reference}`}>Colis & fret {shipment.reference}</h2>
        <span className="et-tag">{STATUS_LABELS[shipment.lifecycleStatus]}</span>
        {shipment.exceptionStatus ? (
          <span className="et-tag">{EXCEPTION_LABELS[shipment.exceptionStatus]}</span>
        ) : null}
      </div>

      <dl className="et-booking-admin-summary">
        <dt>Sens</dt>
        <dd>{DIRECTION_LABELS[shipment.direction]}</dd>
        <dt>Expéditeur</dt>
        <dd>
          {shipment.senderName} · {shipment.senderContact}
        </dd>
        <dt>Destinataire</dt>
        <dd>
          {shipment.recipientName} · {shipment.recipientContact}
        </dd>
        <dt>Poids</dt>
        <dd data-testid="cargo-weight">{formatWeight(shipment.weightKg)}</dd>
        <dt>Volume</dt>
        <dd>{formatVolume(shipment.volumeLiters)}</dd>
        <dt>Pièces</dt>
        <dd>{shipment.packageCount}</dd>
        <dt>Contenu déclaré</dt>
        <dd>{shipment.declaredContents}</dd>
        <dt>Réservation</dt>
        <dd className="et-code">{shipment.booking?.reference ?? '—'}</dd>
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
        <dt>Voyage</dt>
        <dd className="et-code">{shipment.trip?.reference ?? 'Non affecté'}</dd>
        <dt>Véhicule</dt>
        <dd className="et-code">{shipment.vehicle?.code ?? 'Non affecté'}</dd>
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

      {canManage && editable ? (
        <form
          className="et-form"
          aria-label="Modifier les caractéristiques du fret"
          onSubmit={submitFacts}
        >
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

      {canManage && assignable ? (
        <form className="et-form" aria-label="Affecter le fret" onSubmit={submitAssignment}>
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

      {canManage && !['DELIVERED', 'REFUSED', 'CANCELLED'].includes(shipment.lifecycleStatus) ? (
        <form className="et-form" aria-label="Enregistrer un événement fret" onSubmit={submitEvent}>
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
          <button type="submit" className="et-button" disabled={busy}>
            Enregistrer l’événement
          </button>
        </form>
      ) : null}

      <div className="et-table-wrap">
        <table data-testid="cargo-timeline">
          <caption>Historique opérationnel immuable</caption>
          <thead>
            <tr>
              <th>N°</th>
              <th>Événement</th>
              <th>Statut</th>
              <th>Incident</th>
              <th>Survenu le</th>
              <th>Lieu</th>
            </tr>
          </thead>
          <tbody>
            {shipment.events.map((event) => (
              <tr key={event.sequence}>
                <td>{event.sequence}</td>
                <td>{event.type}</td>
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

  return (
    <div className="et-network" data-testid="cargo-workspace">
      <p>
        Colis et fret routier distincts des bagages voyageurs. CARGO-PRICE-1 ajoute des devis
        commerciaux versionnés ; les paiements et la comptabilisation Finance restent séparés.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      <form className="et-form et-network-form" aria-label="Résoudre un QR fret" onSubmit={resolveQr}>
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

      {canManage ? (
        <form
          className="et-form et-network-form"
          aria-label="Créer un colis ou fret"
          onSubmit={submitCreate}
        >
          <h2>Nouveau colis / fret</h2>
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
          <div className="et-actions">
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

      <form
        className="et-form et-network-form"
        aria-label="Filtrer les colis et fret"
        onSubmit={filter}
      >
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

      {detail ? (
        <CargoDetail
          shipment={detail}
          canManage={canManage}
          canReadPricing={canReadPricing}
          canManagePricing={canManagePricing}
          onChanged={changed}
        />
      ) : null}

      <section aria-labelledby="cargo-list-title">
        <h2 id="cargo-list-title">Colis & fret</h2>
        {!items ? <p role="status">Chargement…</p> : null}
        {items ? (
          <div className="et-table-wrap">
            <table>
              <caption>Fret routier et statut courant</caption>
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Sens</th>
                  <th>Expéditeur → destinataire</th>
                  <th>Poids</th>
                  <th>Volume</th>
                  <th>Statut</th>
                  <th>Voyage / véhicule</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.reference}>
                    <td className="et-code">{item.reference}</td>
                    <td>{DIRECTION_LABELS[item.direction]}</td>
                    <td>
                      {item.senderName} → {item.recipientName}
                    </td>
                    <td>{formatWeight(item.weightKg)}</td>
                    <td>{formatVolume(item.volumeLiters)}</td>
                    <td>{STATUS_LABELS[item.lifecycleStatus]}</td>
                    <td>
                      <span className="et-code">{item.trip?.reference ?? '—'}</span>
                      <br />
                      <span className="et-code">{item.vehicle?.code ?? '—'}</span>
                    </td>
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
        {items?.length === 0 ? <p>Aucun colis ou fret.</p> : null}
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
