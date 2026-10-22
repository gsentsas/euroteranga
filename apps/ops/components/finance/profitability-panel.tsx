'use client';

import type { OpsProfitTripProjection } from '@euroteranga/auth-client';
import { FormAlert } from '@euroteranga/ui';
import { useEffect, useState } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

function decimalMinor(amountMinor: string, minorUnit: number): string {
  const negative = amountMinor.startsWith('-');
  const absolute = BigInt(negative ? amountMinor.slice(1) : amountMinor);
  const factor = 10n ** BigInt(minorUnit);
  const integer = (absolute / factor).toString();
  const fraction = (absolute % factor).toString().padStart(minorUnit, '0');
  return (negative ? '-' : '') + integer + (minorUnit > 0 ? '.' + fraction : '');
}

function money(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const decimal = decimalMinor(amountMinor, minorUnit);
  const negative = decimal.startsWith('-');
  const absolute = negative ? decimal.slice(1) : decimal;
  const [whole = '0', fraction = ''] = absolute.split('.');
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  }
  return (
    (negative ? '-' : '') +
    groups.join(' ') +
    (minorUnit > 0 ? ',' + fraction.padEnd(minorUnit, '0') : '') +
    ' ' +
    currencyCode
  );
}

function percentFromBasisPoints(value: string | null): string {
  if (value === null) return '—';
  const basisPoints = BigInt(value);
  const negative = basisPoints < 0n;
  const absolute = negative ? -basisPoints : basisPoints;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return (negative ? '-' : '') + whole.toString() + ',' + fraction + ' %';
}

const WARNING_LABELS: Record<string, string> = {
  NO_TRIP_COST_PLAN: 'Aucun budget prévisionnel n’est encore enregistré pour ce voyage.',
  MULTI_CURRENCY_NO_FX:
    'Plusieurs devises sont présentes : aucune conversion de change ni total consolidé n’est appliqué.',
  CARGO_COMMERCIAL_NOT_RECOGNIZED_REVENUE:
    'Les devis Cargo acceptés restent des valeurs commerciales non reconnues comme revenus Finance.',
};

export function ProfitabilityPanel({
  tripReference,
  refreshKey,
}: {
  tripReference: string;
  refreshKey?: unknown;
}) {
  const canReadTrip = useCan('trip.read');
  const [projection, setProjection] = useState<OpsProfitTripProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadTrip || !tripReference) {
      setProjection(null);
      setError(null);
      return;
    }
    let active = true;
    void auth.admin.finance.profitability(tripReference).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setProjection(null);
        setError(result.error.message);
        return;
      }
      setProjection(result.data);
      setError(null);
    });
    return () => {
      active = false;
    };
  }, [canReadTrip, tripReference, refreshKey]);

  if (!canReadTrip) return null;

  return (
    <section
      className="et-network-panel"
      aria-labelledby="ops-profit-title"
      data-testid="ops-profit-panel"
    >
      <div className="et-actions">
        <div>
          <span className="et-kicker">Analyse opérationnelle</span>
          <h2 id="ops-profit-title">Rentabilité du voyage</h2>
        </div>
        <span className="et-tag">Lecture seule</span>
      </div>

      <p>
        Les chiffres Finance, le budget prévisionnel et la valeur commerciale Cargo sont séparés
        pour éviter tout double comptage.
      </p>
      <FormAlert message={error} />

      {projection ? (
        <div className="et-network-grid">
          <section className="et-network-panel" aria-labelledby="ops-profit-actual-title">
            <h3 id="ops-profit-actual-title">Réalisé Finance</h3>
            <p>Aucun devis Cargo n’est ajouté automatiquement aux revenus.</p>
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>Contribution réelle par devise</caption>
                <thead>
                  <tr>
                    <th>Devise</th>
                    <th>Recettes nettes</th>
                    <th>Dépenses</th>
                    <th>Contribution</th>
                    <th>À régler</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.financeActuals.length ? (
                    projection.financeActuals.map((currency) => (
                      <tr key={currency.currencyCode + ':' + currency.currencyMinorUnit}>
                        <td>{currency.currencyCode}</td>
                        <td>
                          {money(
                            currency.netRevenueMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                        <td>
                          {money(
                            currency.expenseMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                        <td>
                          {money(
                            currency.contributionMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                        <td>
                          {money(
                            currency.outstandingExpenseMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>Aucun flux Finance enregistré.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="et-network-panel" aria-labelledby="ops-profit-plan-title">
            <h3 id="ops-profit-plan-title">Prévisionnel</h3>
            {projection.plannedCost ? (
              <>
                <div className="et-actions">
                  <span className="et-tag">{projection.plannedCost.status}</span>
                  <strong>
                    {money(
                      projection.plannedCost.plannedCostMinor,
                      projection.plannedCost.currencyCode,
                      projection.plannedCost.currencyMinorUnit,
                    )}
                  </strong>
                </div>
                <dl className="et-definition-list">
                  <dt>Dépenses réelles</dt>
                  <dd>
                    {money(
                      projection.plannedCost.actualExpenseMinor,
                      projection.plannedCost.currencyCode,
                      projection.plannedCost.currencyMinorUnit,
                    )}
                  </dd>
                  <dt>Écart budget</dt>
                  <dd>
                    {money(
                      projection.plannedCost.varianceMinor,
                      projection.plannedCost.currencyCode,
                      projection.plannedCost.currencyMinorUnit,
                    )}{' '}
                    ({percentFromBasisPoints(projection.plannedCost.varianceBasisPoints)})
                  </dd>
                  <dt>Budget restant</dt>
                  <dd>
                    {money(
                      projection.plannedCost.remainingBudgetMinor,
                      projection.plannedCost.currencyCode,
                      projection.plannedCost.currencyMinorUnit,
                    )}
                  </dd>
                </dl>
                <p>Un écart positif signifie un dépassement du budget prévisionnel.</p>
              </>
            ) : (
              <p>Aucun budget prévisionnel disponible.</p>
            )}
          </section>

          <section className="et-network-panel" aria-labelledby="ops-profit-cargo-title">
            <h3 id="ops-profit-cargo-title">Commercial Cargo non reconnu</h3>
            <p>
              {projection.cargo.shipmentCount} fret(s) affecté(s) ·{' '}
              {projection.cargo.acceptedQuoteCount} devis accepté(s) ·{' '}
              {projection.cargo.shipmentsWithoutAcceptedQuote} sans devis accepté.
            </p>
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>Valeur commerciale acceptée, hors revenu Finance</caption>
                <thead>
                  <tr>
                    <th>Devise</th>
                    <th>Devis acceptés</th>
                    <th>Valeur commerciale</th>
                    <th>Revenu reconnu</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.cargo.commercial.length ? (
                    projection.cargo.commercial.map((currency) => (
                      <tr key={currency.currencyCode + ':' + currency.currencyMinorUnit}>
                        <td>{currency.currencyCode}</td>
                        <td>{currency.acceptedQuoteCount}</td>
                        <td>
                          {money(
                            currency.acceptedCommercialValueMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                        <td>
                          {money(
                            currency.recognizedRevenueMinor,
                            currency.currencyCode,
                            currency.currencyMinorUnit,
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4}>Aucun devis Cargo accepté affecté à ce voyage.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="et-network-panel" aria-labelledby="ops-profit-capacity-title">
            <h3 id="ops-profit-capacity-title">Occupation Cargo du convoi</h3>
            <dl className="et-definition-list">
              <dt>Véhicules avec capacité déclarée</dt>
              <dd>
                {projection.cargo.capacity.vehicleCount} ·{' '}
                {projection.cargo.capacity.vehicleCodes.join(', ') || '—'}
              </dd>
              <dt>Poids utilisé / capacité</dt>
              <dd>
                {projection.cargo.capacity.usedWeightKg} kg /{' '}
                {projection.cargo.capacity.payloadCapacityKg} kg
              </dd>
              <dt>Volume utilisé / capacité</dt>
              <dd>
                {projection.cargo.capacity.usedVolumeLiters} L /{' '}
                {projection.cargo.capacity.cargoVolumeLiters} L
              </dd>
            </dl>
          </section>

          {projection.warnings.length ? (
            <section className="et-network-panel" aria-labelledby="ops-profit-warnings-title">
              <h3 id="ops-profit-warnings-title">Points d’attention</h3>
              <ul>
                {projection.warnings.map((warning) => (
                  <li key={warning}>{WARNING_LABELS[warning] ?? warning}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
