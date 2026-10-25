'use client';

import type {
  PrivateDownload,
  ReportingMoneySummary,
  ReportingOverview,
  ReportingOverviewOptions,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function initialDates() {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: isoDate(from), to: isoDate(to) };
}

function dateStart(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function integerMinor(amountMinor: string, minorUnit: number): string {
  const negative = amountMinor.startsWith('-');
  const absolute = BigInt(negative ? amountMinor.slice(1) : amountMinor);
  const factor = 10n ** BigInt(minorUnit);
  const whole = (absolute / factor).toString();
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  }
  const grouped = groups.join(' ');
  const fraction = (absolute % factor).toString().padStart(minorUnit, '0');
  return `${negative ? '-' : ''}${grouped}${minorUnit > 0 ? `,${fraction}` : ''}`;
}

function money(
  value: ReportingMoneySummary,
  field: keyof Pick<
    ReportingMoneySummary,
    'netRevenueMinor' | 'refundMinor' | 'expenseMinor' | 'contributionMinor'
  >,
): string {
  return `${integerMinor(value[field], value.currencyMinorUnit)} ${value.currencyCode}`;
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function decimal(value: number | null, suffix = ''): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value)}${suffix}`;
}

function saveDownload(download: PrivateDownload): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <OpsKpiCard
      label={label}
      value={value}
      helper="Période sélectionnée"
      icon="chart"
      tone="info"
    />
  );
}

function FinanceTable({ currencies }: { currencies: ReportingMoneySummary[] }) {
  return (
    <div className="et-table-wrap">
      <table className="et-table">
        <caption>Performance financière par devise — aucune conversion FX</caption>
        <thead>
          <tr>
            <th>Devise</th>
            <th>Revenu net</th>
            <th>Remboursements</th>
            <th>Dépenses</th>
            <th>Contribution</th>
            <th>Marge</th>
          </tr>
        </thead>
        <tbody>
          {currencies.length === 0 ? (
            <tr>
              <td colSpan={6}>Aucun mouvement financier sur la période.</td>
            </tr>
          ) : (
            currencies.map((currency) => (
              <tr key={`${currency.currencyCode}:${currency.currencyMinorUnit}`}>
                <td>{currency.currencyCode}</td>
                <td>{money(currency, 'netRevenueMinor')}</td>
                <td>{money(currency, 'refundMinor')}</td>
                <td>{money(currency, 'expenseMinor')}</td>
                <td>
                  <strong>{money(currency, 'contributionMinor')}</strong>
                </td>
                <td>{percent(currency.contributionRate)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ReportingDashboard() {
  const initial = useMemo(initialDates, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<ReportingOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canExport = useCan('reporting.export');

  const options = (): ReportingOverviewOptions => ({ from: dateStart(from), to: dateStart(to) });

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.reporting.overview(options());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setData(result.data);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void auth.admin.reporting
      .overview({ from: dateStart(initial.from), to: dateStart(initial.to) })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setData(result.data);
        else setError(result.error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [initial.from, initial.to]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };

  const exportFile = async (kind: 'csv' | 'xlsx') => {
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === 'csv'
          ? await auth.admin.reporting.exportCsv(options())
          : await auth.admin.reporting.exportXlsx(options());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      saveDownload(result.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="et-network ops-operations-workspace ops-reporting-workspace"
      data-testid="reporting-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Pilotage & analyse</p>
          <h2>Reporting opérationnel</h2>
          <p>
            Analysez l’activité commerciale, financière et opérationnelle sur une période donnée.
            Les montants restent toujours séparés par devise et aucune conversion de change
            implicite n’est appliquée.
          </p>
        </div>
      </div>

      <form
        className="et-network-form ops-reporting-filter"
        aria-label="Filtres reporting"
        onSubmit={submit}
      >
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor="reporting-from">Du (UTC)</label>
            <input
              id="reporting-from"
              className="et-input"
              type="date"
              value={from}
              required
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="et-field">
            <label htmlFor="reporting-to">Au, exclu (UTC)</label>
            <input
              id="reporting-to"
              className="et-input"
              type="date"
              value={to}
              required
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>
        <div className="et-actions">
          <button type="submit" className="et-button" disabled={busy || !from || !to}>
            Actualiser
          </button>
          {canExport ? (
            <>
              <button
                type="button"
                className="et-button"
                disabled={busy}
                onClick={() => exportFile('csv')}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="et-button"
                disabled={busy}
                onClick={() => exportFile('xlsx')}
              >
                Export XLSX
              </button>
            </>
          ) : null}
        </div>
        <FormAlert message={error} />
        {busy ? <FormStatus>Calcul du reporting…</FormStatus> : null}
      </form>

      {data ? (
        <>
          {data.privacy.containsPassengerPii === false ? (
            <div className="ops-reporting-privacy" role="status">
              <OpsStatusBadge tone="success">Sans PII passager</OpsStatusBadge>
              <span>Cette vue agrégée ne contient aucune donnée personnelle voyageur.</span>
            </div>
          ) : null}

          <section className="ops-reporting-section" aria-labelledby="reporting-overview-title">
            <div className="et-actions">
              <div>
                <p className="ops-operations-section-kicker">Vue d’ensemble</p>
                <h2 id="reporting-overview-title">Synthèse</h2>
              </div>
            </div>
            <div className="et-network-adders ops-reporting-kpis">
              <Kpi label="Voyages" value={data.activity.tripCount} />
              <Kpi label="Passagers" value={data.commercial.passengerCount} />
              <Kpi label="Sièges vendus" value={data.commercial.soldSeatCount} />
              <Kpi label="Taux de remplissage" value={percent(data.commercial.loadFactor)} />
              <Kpi label="Réservations confirmées" value={data.commercial.confirmedBookingCount} />
              <Kpi label="Taux d’annulation" value={percent(data.commercial.cancellationRate)} />
            </div>
          </section>

          <section
            className="et-network-panel ops-reporting-panel"
            aria-labelledby="reporting-finance-title"
          >
            <h2 id="reporting-finance-title">Finance</h2>
            <p>Les montants restent séparés par devise. Aucun taux de change n’est appliqué.</p>
            <FinanceTable currencies={data.finance.currencies} />
          </section>

          <section className="ops-reporting-section" aria-labelledby="reporting-operations-title">
            <div className="et-actions">
              <div>
                <p className="ops-operations-section-kicker">Qualité d’exploitation</p>
                <h2 id="reporting-operations-title">Exploitation</h2>
              </div>
            </div>
            <div className="et-network-adders ops-reporting-kpis">
              <Kpi label="Départs à l’heure" value={data.operations.onTimeDepartureCount} />
              <Kpi label="Départs en retard" value={data.operations.delayedDepartureCount} />
              <Kpi
                label="Retard moyen"
                value={decimal(data.operations.averageDelayMinutes, ' min')}
              />
              <Kpi label="Incidents ouverts" value={data.incidents.openIncidentCount} />
              <Kpi label="Anomalies bagages" value={data.baggage.anomalyBaggageCount} />
              <Kpi label="Utilisation flotte active" value={percent(data.fleet.utilizationRate)} />
            </div>
          </section>

          <section
            className="et-network-panel ops-reporting-panel"
            aria-labelledby="reporting-routes-title"
          >
            <h2 id="reporting-routes-title">Performance par trajet</h2>
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>Trajets historiques par version</caption>
                <thead>
                  <tr>
                    <th>Trajet</th>
                    <th>Voyages</th>
                    <th>Passagers</th>
                    <th>Remplissage</th>
                    <th>Incidents</th>
                    <th>Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.length === 0 ? (
                    <tr>
                      <td colSpan={6}>Aucun trajet sur la période.</td>
                    </tr>
                  ) : (
                    data.routes.map((route) => (
                      <tr key={route.routeVersionId}>
                        <td>
                          {route.routeCode} · v{route.routeVersion}
                        </td>
                        <td>{route.tripCount}</td>
                        <td>{route.passengerCount}</td>
                        <td>{percent(route.loadFactor)}</td>
                        <td>{route.incidentCount}</td>
                        <td>
                          {route.currencies.length === 0
                            ? '—'
                            : route.currencies
                                .map((currency) => money(currency, 'contributionMinor'))
                                .join(' · ')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className="et-network-panel ops-reporting-panel"
            aria-labelledby="reporting-trips-title"
          >
            <h2 id="reporting-trips-title">Voyages récents de la période</h2>
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>25 voyages maximum, triés par départ planifié décroissant</caption>
                <thead>
                  <tr>
                    <th>Voyage</th>
                    <th>Trajet</th>
                    <th>Statut</th>
                    <th>Passagers</th>
                    <th>Remplissage</th>
                    <th>Incidents</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentTrips.length === 0 ? (
                    <tr>
                      <td colSpan={6}>Aucun voyage sur la période.</td>
                    </tr>
                  ) : (
                    data.recentTrips.map((trip) => (
                      <tr key={trip.id}>
                        <td>{trip.reference}</td>
                        <td>
                          {trip.route.code} · v{trip.route.version}
                        </td>
                        <td>
                          <OpsStatusBadge tone="neutral">{trip.status}</OpsStatusBadge>
                        </td>
                        <td>{trip.passengerCount}</td>
                        <td>{percent(trip.loadFactor)}</td>
                        <td>{trip.incidentCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
