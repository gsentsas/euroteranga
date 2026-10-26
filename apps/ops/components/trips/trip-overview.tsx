'use client';

import type {
  AdminBooking,
  AdminTrip,
  FinanceCurrencySummary,
  TripCostPlan,
} from '@euroteranga/auth-client';
import { useId, type ReactNode } from 'react';
import { BLOCKER_LABELS } from '../departure/departure-admin';
import { assignedFareLabel } from '../pricing/pricing-format';
import { OpsStatusBadge } from '../ops-ui';
import { assignedLabel } from '../seat-maps/seat-map-format';
import type {
  CockpitPermissions,
  CockpitSource,
  OnDemandSource,
  TripCockpitData,
} from './trip-cockpit-data';
import {
  RouteSchematic,
  RouteStops,
  TripHistoryList,
  VehicleCard,
  type VehicleCardAction,
} from './trip-cockpit-parts';
import { formatMinor, type TripTone } from './trip-format';
import type { TripTabId } from './trip-tabs';

export type TripEditTarget = 'timetable' | 'vehicle' | 'support' | 'seatMap' | 'pricing' | 'costs';

const COST_STATUS_LABELS: Record<TripCostPlan['status'], string> = {
  DRAFT: 'Brouillon',
  ESTIMATED: 'Estimation',
  LOCKED: 'Verrouillé',
};

export function costStatusLabel(status: TripCostPlan['status']): string {
  return COST_STATUS_LABELS[status];
}

/** Seats of the bookings that hold them now: paid ones, and holds not yet expired. */
export function bookingFigures(bookings: readonly AdminBooking[], now = Date.now()) {
  let confirmed = 0;
  let held = 0;
  let heldBookings = 0;
  const confirmedRevenue = new Map<string, { amountMinor: bigint; minorUnit: number }>();
  for (const booking of bookings) {
    if (booking.status === 'CONFIRMED') {
      confirmed += booking.seatCount;
      const key = booking.currencyCode;
      const current = confirmedRevenue.get(key) ?? {
        amountMinor: 0n,
        minorUnit: booking.currencyMinorUnit,
      };
      current.amountMinor += BigInt(booking.totalAmountMinor);
      confirmedRevenue.set(key, current);
    } else if (booking.status === 'HELD' && new Date(booking.holdExpiresAt).getTime() > now) {
      held += booking.seatCount;
      heldBookings += 1;
    }
  }
  return { confirmed, held, heldBookings, confirmedRevenue };
}

/** Waypoints missing a planned time the timetable requires. */
export function missingTimings(trip: AdminTrip): number {
  const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
  const waypoints = trip.routeVersion.waypoints;
  return waypoints.filter((waypoint, index) => {
    const timing = byWaypoint.get(waypoint.id);
    const needsArrival = index > 0;
    const needsDeparture = index < waypoints.length - 1;
    return (
      (needsArrival && !timing?.plannedArrivalAt) || (needsDeparture && !timing?.plannedDepartureAt)
    );
  }).length;
}

export interface TripAlert {
  id: string;
  tone: Exclude<TripTone, 'success' | 'neutral'>;
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void } | undefined;
}

/**
 * Alerts are derived from facts returned by the API only. A missing
 * permission removes the corresponding check: it never claims health.
 */
export function tripAlerts({
  trip,
  data,
  canEdit,
  openEditor,
  openTab,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  canEdit: (target: TripEditTarget) => boolean;
  openEditor: (target: TripEditTarget) => void;
  openTab: (tab: TripTabId) => void;
}): TripAlert[] {
  const alerts: TripAlert[] = [];
  const active = trip.status === 'DRAFT' || trip.status === 'SCHEDULED';
  const edit = (target: TripEditTarget, label: string) =>
    canEdit(target) ? { label, onClick: () => openEditor(target) } : undefined;

  if (data.readiness.state === 'ready' && data.readiness.data.readiness.status === 'BLOCKED') {
    const labels = [
      ...new Set(data.readiness.data.readiness.blockers.map((blocker) => blocker.code)),
    ].map((code) => BLOCKER_LABELS[code]);
    alerts.push({
      id: 'departure-blocked',
      tone: 'danger',
      title: `Départ bloqué : ${labels.length} point${labels.length > 1 ? 's' : ''} à lever.`,
      detail: labels.slice(0, 3).join(' ') + (labels.length > 3 ? ' …' : ''),
    });
  }
  if (data.readiness.state === 'error') {
    alerts.push({
      id: 'departure-error',
      tone: 'info',
      title: 'Préparation au départ indisponible.',
      detail: data.readiness.error,
    });
  }
  if (active && trip.vehicle && trip.vehicle.status !== 'ACTIVE') {
    alerts.push({
      id: 'vehicle-inactive',
      tone: 'danger',
      title: `Le véhicule principal ${trip.vehicle.code} n’est plus en service.`,
      action: edit('vehicle', 'Changer de véhicule'),
    });
  }
  if (active && trip.supportVehicle && trip.supportVehicle.status !== 'ACTIVE') {
    alerts.push({
      id: 'support-inactive',
      tone: 'danger',
      title: `Le véhicule d’appoint ${trip.supportVehicle.code} n’est plus en service.`,
      action: edit('support', 'Changer de véhicule d’appoint'),
    });
  }
  if (active && !trip.vehicle) {
    alerts.push({
      id: 'vehicle-missing',
      tone: 'warning',
      title: 'Aucun véhicule principal n’est affecté.',
      action: edit('vehicle', 'Affecter un véhicule'),
    });
  }
  const missing = missingTimings(trip);
  if (trip.status === 'DRAFT' && missing > 0) {
    alerts.push({
      id: 'timetable-incomplete',
      tone: 'warning',
      title: `Horaire incomplet : ${missing} point${missing > 1 ? 's' : ''} sans heure prévue.`,
      action: edit('timetable', 'Compléter l’horaire'),
    });
  }
  if (active && !trip.seatMapVersion) {
    alerts.push({
      id: 'seat-map-missing',
      tone: 'warning',
      title: 'Aucun plan de sièges n’est affecté au voyage.',
      action: edit('seatMap', 'Choisir un plan'),
    });
  }
  if (
    trip.status === 'DRAFT' &&
    trip.vehicle?.seatMapVersion &&
    trip.vehicle.seatMapVersion.id !== trip.seatMapVersionId
  ) {
    alerts.push({
      id: 'seat-map-differs',
      tone: 'info',
      title: 'Le plan de sièges du voyage diffère du plan actuel du véhicule.',
      action: { label: 'Voir les véhicules', onClick: () => openTab('vehicules') },
    });
  }
  if (active && !trip.fareTableVersion) {
    alerts.push({
      id: 'fare-missing',
      tone: 'warning',
      title: 'Aucune grille tarifaire n’est affectée.',
      detail: 'La tarification reste facultative pour planifier.',
      action: edit('pricing', 'Choisir une grille'),
    });
  }
  if (data.costs.state === 'ready' && trip.status !== 'CANCELLED') {
    if (data.costs.data.id === null) {
      alerts.push({
        id: 'costs-missing',
        tone: 'info',
        title: 'Aucun coût prévisionnel n’est enregistré.',
        action: edit('costs', 'Saisir les coûts'),
      });
    } else if (data.costs.data.status === 'DRAFT') {
      alerts.push({
        id: 'costs-draft',
        tone: 'info',
        title: 'Le chiffrage des coûts est encore en brouillon.',
        action: edit('costs', 'Compléter les coûts'),
      });
    }
  }
  if (data.bookings.state === 'ready' && active) {
    const { heldBookings } = bookingFigures(data.bookings.data);
    if (heldBookings > 0) {
      alerts.push({
        id: 'bookings-held',
        tone: 'info',
        title: `${heldBookings} réservation${heldBookings > 1 ? 's' : ''} provisoire${
          heldBookings > 1 ? 's' : ''
        } en attente de paiement.`,
        action: { label: 'Voir les passagers', onClick: () => openTab('passagers') },
      });
    }
  }
  if (trip.status === 'DRAFT') {
    alerts.push({
      id: 'draft',
      tone: 'info',
      title: 'Brouillon : le voyage n’est pas encore planifié.',
      detail: 'La planification fige l’horaire, le plan de sièges et la tarification.',
    });
  }
  if (trip.routeVersion.status === 'RETIRED') {
    alerts.push({
      id: 'route-retired',
      tone: 'info',
      title: 'La version de route a été retirée depuis ; le voyage reste valide.',
    });
  }
  return alerts;
}

function Card({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void } | null;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className={`ops-trip-card${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
    >
      <div className="ops-trip-card__head">
        <h3 id={titleId}>{title}</h3>
        {action ? (
          <button type="button" className="ops-trip-link" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SourceState({ source, label }: { source: CockpitSource<unknown>; label: string }) {
  if (source.state === 'loading') return <p className="et-hint">Chargement — {label}…</p>;
  // `idle` sources have their own explicit trigger.
  if (source.state === 'error') {
    return (
      <p className="et-hint" role="status">
        {label} : non disponible ({source.error}).
      </p>
    );
  }
  return null;
}

/** Explicit trigger of an audited read: nothing of the kind runs on mere opening. */
export function OnDemandButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="et-button et-button--secondary ops-trip-ondemand"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function AlertsCard({
  trip,
  alerts,
  data,
  onRequest,
}: {
  trip: AdminTrip;
  alerts: readonly TripAlert[];
  data: TripCockpitData;
  onRequest: (source: OnDemandSource) => void;
}) {
  const readiness = data.readiness.state === 'ready' ? data.readiness.data.readiness : null;
  return (
    <Card title="Alertes & actions" className="ops-trip-card--alerts">
      {data.readiness.state === 'idle' ? (
        <div className="ops-trip-readiness">
          <span>Préparation au départ : non évaluée.</span>
          <OnDemandButton
            label="Évaluer la préparation au départ"
            onClick={() => onRequest('readiness')}
          />
        </div>
      ) : null}
      {data.readiness.state === 'loading' ? (
        <p className="et-hint">Évaluation de la préparation au départ…</p>
      ) : null}
      {readiness ? (
        <p className="ops-trip-readiness">
          Préparation au départ :{' '}
          <OpsStatusBadge tone={readiness.status === 'READY' ? 'success' : 'danger'}>
            {readiness.status === 'READY' ? 'Prêt' : 'Bloqué'}
          </OpsStatusBadge>
        </p>
      ) : null}
      {trip.status === 'CANCELLED' ? (
        <p className="et-hint">Voyage annulé : aucune action opérationnelle n’est attendue.</p>
      ) : alerts.length === 0 ? (
        <p className="ops-trip-alerts__empty">
          Aucune alerte dans les données que vous pouvez consulter.
        </p>
      ) : (
        <ul className="ops-trip-alerts">
          {alerts.map((alert) => (
            <li key={alert.id} className={`ops-trip-alert ops-trip-alert--${alert.tone}`}>
              <div>
                <strong>{alert.title}</strong>
                {alert.detail ? <p>{alert.detail}</p> : null}
              </div>
              {alert.action ? (
                <button type="button" className="ops-trip-link" onClick={alert.action.onClick}>
                  {alert.action.label}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function amountsByCurrency(
  rows: readonly FinanceCurrencySummary[],
  pick: (row: FinanceCurrencySummary) => string,
) {
  return rows.map((row) => formatMinor(pick(row), row.currencyCode, row.currencyMinorUnit));
}

function FinanceCard({
  data,
  can,
  onOpenCosts,
  onRequest,
}: {
  data: TripCockpitData;
  can: CockpitPermissions;
  onOpenCosts: () => void;
  onRequest: (source: OnDemandSource) => void;
}) {
  const costs = data.costs.state === 'ready' ? data.costs.data : null;
  const confirmed =
    data.bookings.state === 'ready' ? bookingFigures(data.bookings.data).confirmedRevenue : null;
  const actuals = data.profit.state === 'ready' ? data.profit.data.financeActuals : null;
  return (
    <Card title="Finance du voyage" action={{ label: 'Voir les coûts', onClick: onOpenCosts }}>
      <dl className="ops-trip-finance">
        <div>
          <dt>
            Estimé <small>coûts prévisionnels</small>
          </dt>
          <dd>
            {costs && costs.id !== null ? (
              <>
                {formatMinor(costs.totalCostMinor, costs.currencyCode, costs.currencyMinorUnit)}
                <small>{costStatusLabel(costs.status)}</small>
              </>
            ) : costs ? (
              'Aucun chiffrage'
            ) : (
              '…'
            )}
          </dd>
        </div>
        {can.bookings ? (
          <div>
            <dt>
              Confirmé <small>billets payés</small>
            </dt>
            <dd>
              {confirmed
                ? confirmed.size > 0
                  ? [...confirmed.entries()].map(([currency, value]) => (
                      <span key={currency}>
                        {formatMinor(value.amountMinor.toString(), currency, value.minorUnit)}
                      </span>
                    ))
                  : 'Aucun billet payé'
                : data.bookings.state === 'error'
                  ? 'Non disponible'
                  : '…'}
            </dd>
          </div>
        ) : null}
        {can.finance ? (
          <>
            <div>
              <dt>
                Réel <small>recettes nettes Finance</small>
              </dt>
              <dd>
                {actuals ? (
                  actuals.length > 0 ? (
                    amountsByCurrency(actuals, (row) => row.netRevenueMinor).map((value) => (
                      <span key={value}>{value}</span>
                    ))
                  ) : (
                    'Aucun flux Finance'
                  )
                ) : data.profit.state === 'error' ? (
                  'Non disponible'
                ) : data.profit.state === 'idle' ? (
                  <OnDemandButton
                    label="Charger le réalisé Finance"
                    onClick={() => onRequest('profit')}
                  />
                ) : (
                  '…'
                )}
              </dd>
            </div>
            {actuals && actuals.length > 0 ? (
              <>
                <div>
                  <dt>
                    Réel <small>dépenses</small>
                  </dt>
                  <dd>
                    {amountsByCurrency(actuals, (row) => row.expenseMinor).map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt>
                    Réel <small>contribution</small>
                  </dt>
                  <dd>
                    {amountsByCurrency(actuals, (row) => row.contributionMinor).map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                  </dd>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {!can.finance ? (
        <p className="et-hint">Le réalisé Finance n’est pas accessible avec vos droits.</p>
      ) : actuals && actuals.length > 1 ? (
        <p className="et-hint">Plusieurs devises : aucune conversion n’est appliquée.</p>
      ) : null}
    </Card>
  );
}

function CostsCard({ data, onOpen }: { data: TripCockpitData; onOpen: () => void }) {
  const plan = data.costs.state === 'ready' ? data.costs.data : null;
  const top = plan
    ? [...plan.items].sort((a, b) => (BigInt(b.amountMinor) > BigInt(a.amountMinor) ? 1 : -1))
    : [];
  return (
    <Card title="Coûts prévisionnels" action={{ label: 'Ouvrir les coûts', onClick: onOpen }}>
      <SourceState source={data.costs} label="Coûts prévisionnels" />
      {plan ? (
        plan.items.length > 0 ? (
          <>
            <p className="ops-trip-figure">
              {formatMinor(plan.totalCostMinor, plan.currencyCode, plan.currencyMinorUnit)}
              <OpsStatusBadge tone={plan.status === 'LOCKED' ? 'success' : 'neutral'}>
                {costStatusLabel(plan.status)}
              </OpsStatusBadge>
            </p>
            <ul className="ops-trip-mini-list">
              {top.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <span>{item.label}</span>
                  <span>
                    {formatMinor(item.amountMinor, plan.currencyCode, plan.currencyMinorUnit)}
                  </span>
                </li>
              ))}
            </ul>
            {plan.items.length > 3 ? (
              <p className="et-hint">
                {plan.items.length - 3} autre{plan.items.length - 3 > 1 ? 's' : ''} ligne
                {plan.items.length - 3 > 1 ? 's' : ''}.
              </p>
            ) : null}
          </>
        ) : (
          <p className="et-hint">Aucune ligne de coût prévisionnel n’est enregistrée.</p>
        )
      ) : null}
      {data.profit.state === 'ready' && data.profit.data.plannedCost ? (
        <p className="et-hint">
          Dépenses réelles :{' '}
          {formatMinor(
            data.profit.data.plannedCost.actualExpenseMinor,
            data.profit.data.plannedCost.currencyCode,
            data.profit.data.plannedCost.currencyMinorUnit,
          )}{' '}
          · budget restant :{' '}
          {formatMinor(
            data.profit.data.plannedCost.remainingBudgetMinor,
            data.profit.data.plannedCost.currencyCode,
            data.profit.data.plannedCost.currencyMinorUnit,
          )}
        </p>
      ) : null}
    </Card>
  );
}

export function TripOverview({
  trip,
  data,
  can,
  canReadPricing,
  alerts,
  vehicleAction,
  supportAction,
  openTab,
  onRequest,
}: {
  trip: AdminTrip;
  data: TripCockpitData;
  can: CockpitPermissions;
  canReadPricing: boolean;
  alerts: readonly TripAlert[];
  vehicleAction: VehicleCardAction | null;
  supportAction: VehicleCardAction | null;
  openTab: (tab: TripTabId) => void;
  onRequest: (source: OnDemandSource) => void;
}) {
  const capacity = trip.seatMapVersion?.seatCount ?? null;
  const figures = data.bookings.state === 'ready' ? bookingFigures(data.bookings.data) : null;
  return (
    <div className="ops-trip-overview">
      <div className="ops-trip-overview__main">
        <Card
          title="Itinéraire"
          className="ops-trip-card--route"
          action={{ label: 'Voir l’itinéraire détaillé', onClick: () => openTab('itineraire') }}
        >
          <RouteSchematic trip={trip} compact />
          <RouteStops trip={trip} />
        </Card>

        <Card
          title="Véhicules"
          className="ops-trip-card--vehicles"
          action={{ label: 'Gérer les véhicules', onClick: () => openTab('vehicules') }}
        >
          <div className="ops-trip-vehicles">
            <VehicleCard
              kind="principal"
              vehicle={trip.vehicle}
              media={data.vehicleMedia}
              seatCount={capacity}
              action={vehicleAction}
            />
            <VehicleCard
              kind="support"
              vehicle={trip.supportVehicle}
              media={data.supportVehicleMedia}
              action={supportAction}
            />
          </div>
        </Card>

        <div className="ops-trip-overview__pair">
          <Card title="Places">
            <dl className="ops-trip-facts">
              <div>
                <dt>Plan du voyage</dt>
                <dd>{assignedLabel(trip.seatMapVersion)}</dd>
              </div>
              {capacity !== null ? (
                <div>
                  <dt>Capacité</dt>
                  <dd>{capacity} sièges</dd>
                </div>
              ) : null}
              {figures ? (
                <>
                  <div>
                    <dt>Vendus (payés)</dt>
                    <dd>{figures.confirmed}</dd>
                  </div>
                  <div>
                    <dt>Retenus (paiement en cours)</dt>
                    <dd>{figures.held}</dd>
                  </div>
                  {capacity !== null ? (
                    <div>
                      <dt>Libres</dt>
                      <dd>{Math.max(0, capacity - figures.confirmed - figures.held)}</dd>
                    </div>
                  ) : null}
                </>
              ) : null}
            </dl>
            {can.bookings ? <SourceState source={data.bookings} label="Réservations" /> : null}
            {trip.status !== 'DRAFT' && trip.seatMapVersion ? (
              <p className="et-hint">Plan figé depuis la planification.</p>
            ) : null}
          </Card>

          {canReadPricing ? (
            <Card
              title="Tarification"
              action={{ label: 'Ouvrir la tarification', onClick: () => openTab('tarification') }}
            >
              <dl className="ops-trip-facts">
                <div>
                  <dt>Grille du voyage</dt>
                  <dd>{assignedFareLabel(trip.fareTableVersion)}</dd>
                </div>
                {trip.fareTableVersion ? (
                  <div>
                    <dt>Devise</dt>
                    <dd>{trip.fareTableVersion.fareTable.currencyCode}</dd>
                  </div>
                ) : null}
              </dl>
              {trip.status !== 'DRAFT' ? (
                <p className="et-hint">Tarification figée : elle fait partie de l’historique.</p>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>

      <div className="ops-trip-overview__aside">
        <AlertsCard trip={trip} alerts={alerts} data={data} onRequest={onRequest} />
        <FinanceCard
          data={data}
          can={can}
          onOpenCosts={() => openTab('couts')}
          onRequest={onRequest}
        />
        <CostsCard data={data} onOpen={() => openTab('couts')} />
        <Card
          title="Derniers événements"
          action={{ label: 'Voir l’historique', onClick: () => openTab('historique') }}
        >
          <TripHistoryList
            trip={trip}
            limit={4}
            label={`Derniers événements du voyage ${trip.reference}`}
          />
        </Card>
      </div>
    </div>
  );
}
