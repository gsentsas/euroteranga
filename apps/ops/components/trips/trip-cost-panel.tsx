'use client';

import type { TripCostCategory, TripCostPlan, TripCostStatus } from '@euroteranga/auth-client';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';

type Run = ReturnType<typeof useAdminFeedback>['run'];

const STATUS_LABELS: Record<TripCostStatus, string> = {
  DRAFT: 'Brouillon',
  ESTIMATED: 'Estimation',
  LOCKED: 'Verrouillé',
};

const CATEGORY_OPTIONS: Array<[TripCostCategory, string]> = [
  ['FUEL', 'Carburant'],
  ['TOLLS', 'Péages'],
  ['FERRY', 'Ferry'],
  ['BORDER_FEES', 'Frais frontière / transit'],
  ['PERMITS', 'Permis et formalités'],
  ['DRIVERS', 'Chauffeurs'],
  ['ACCOMMODATION', 'Hébergement'],
  ['MEALS_ALLOWANCES', 'Repas / indemnités'],
  ['MAINTENANCE', 'Provision maintenance'],
  ['INSURANCE', 'Assurance'],
  ['CLEANING_PREPARATION', 'Nettoyage / préparation'],
  ['PARKING', 'Stationnement'],
  ['STOP_COST', 'Coûts des arrêts'],
  ['SUPPORT_VEHICLE', 'Véhicule d’appoint'],
  ['CONTINGENCY', 'Imprévus'],
  ['OTHER', 'Autre'],
];

interface CostDraft {
  key: string;
  category: TripCostCategory;
  label: string;
  amount: string;
  notes: string;
}

/** Parse an EUR decimal without ever passing through floating-point arithmetic. */
function parseEuros(value: string): string | null {
  const cleaned = value.replace(/[\s\u00a0\u202f]/gu, '');
  const match = /^([0-9]+)(?:[.,]([0-9]{0,2}))?$/u.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const amount = BigInt(whole) * 100n + BigInt(fraction || '0');
  return amount.toString().length <= 16 ? amount.toString() : null;
}

/** Format exact minor units with French grouping, without Number conversion. */
function euros(amountMinor: string): string {
  const amount = BigInt(amountMinor);
  const whole = (amount / 100n).toString();
  const cents = (amount % 100n).toString().padStart(2, '0');
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  }
  return `${groups.join(' ')},${cents} €`;
}

function amountInput(amountMinor: string): string {
  const amount = BigInt(amountMinor);
  return `${amount / 100n},${(amount % 100n).toString().padStart(2, '0')}`;
}

/** Accessible editor and read-only view of one trip's internal cost plan. */
export function TripCostPanel({
  tripId,
  tripReference,
  canManage,
  run,
  busy,
  onSaved,
}: {
  tripId: string;
  tripReference: string;
  canManage: boolean;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const id = useId();
  const nextKey = useRef(0);
  const [plan, setPlan] = useState<TripCostPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<TripCostStatus>('DRAFT');
  const [items, setItems] = useState<CostDraft[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    const result = await auth.admin.trips.tripCosts(tripId);
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setPlan(result.data);
  }, [tripId]);

  useEffect(() => {
    setPlan(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!plan) return;
    setStatus(plan.status);
    setItems(
      plan.items.map((item) => ({
        key: item.id,
        category: item.category,
        label: item.label,
        amount: amountInput(item.amountMinor),
        notes: item.notes ?? '',
      })),
    );
  }, [plan]);

  const update = (index: number, value: Partial<CostDraft>) =>
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...value } : item)),
    );
  const move = (index: number, direction: -1 | 1) =>
    setItems((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      return next;
    });
  const valid = items.every((item) => item.label.trim() && parseEuros(item.amount) !== null);
  const readOnly = !canManage || plan?.status === 'LOCKED';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!plan || readOnly || busy || !valid) return;
    const ok = await run(
      () =>
        auth.admin.trips.replaceTripCosts(tripId, {
          status,
          currencyCode: 'EUR',
          items: items.map((item, position) => ({
            category: item.category,
            label: item.label.trim(),
            amountMinor: parseEuros(item.amount)!,
            ...(item.notes.trim() ? { notes: item.notes.trim() } : {}),
            position,
          })),
        }),
      `Coûts prévisionnels du voyage ${tripReference} enregistrés.`,
    );
    if (ok) {
      await load();
      await onSaved();
    }
  };

  if (!plan && !loadError) return <p>Chargement des coûts prévisionnels…</p>;
  if (!plan && loadError) {
    return (
      <section aria-label={`Coûts prévisionnels du voyage ${tripReference}`}>
        <h3>Coûts prévisionnels</h3>
        <p>{loadError}</p>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Réessayer
        </button>
      </section>
    );
  }
  if (!plan) return null;

  if (readOnly) {
    return (
      <section aria-label={`Coûts prévisionnels du voyage ${tripReference}`}>
        <h3>Coûts prévisionnels</h3>
        <p>
          Statut : <strong>{STATUS_LABELS[plan.status]}</strong> · Devise : EUR
        </p>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Lignes de coût prévisionnel</caption>
            <thead>
              <tr>
                <th scope="col">Catégorie</th>
                <th scope="col">Libellé</th>
                <th scope="col">Montant</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((item) => (
                <tr key={item.id}>
                  <td>{CATEGORY_OPTIONS.find(([value]) => value === item.category)?.[1]}</td>
                  <th scope="row">{item.label}</th>
                  <td>{euros(item.amountMinor)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" colSpan={2}>
                  TOTAL
                </th>
                <td data-testid="trip-cost-total">{euros(plan.totalCostMinor)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {plan.status === 'LOCKED' ? (
          <p className="et-hint">Ce snapshot opérationnel est verrouillé et définitif.</p>
        ) : null}
      </section>
    );
  }

  return (
    <form
      className="et-form et-network-form"
      aria-label={`Coûts prévisionnels du voyage ${tripReference}`}
      onSubmit={submit}
    >
      <h3>Coûts prévisionnels</h3>
      <div className="et-network-adders">
        <div className="et-field">
          <label htmlFor={`${id}-status`}>Statut du chiffrage</label>
          <select
            id={`${id}-status`}
            className="et-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as TripCostStatus)}
          >
            {(Object.keys(STATUS_LABELS) as TripCostStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={`${id}-currency`}>Devise</label>
          <input id={`${id}-currency`} className="et-input" value="EUR" readOnly />
        </div>
      </div>

      {items.map((item, index) => (
        <fieldset key={item.key} className="ops-content-item">
          <legend>Ligne {index + 1}</legend>
          <div className="et-network-adders">
            <div className="et-field">
              <label htmlFor={`${id}-category-${index}`}>Catégorie</label>
              <select
                id={`${id}-category-${index}`}
                className="et-select"
                value={item.category}
                onChange={(event) =>
                  update(index, { category: event.target.value as TripCostCategory })
                }
              >
                {CATEGORY_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="et-field">
              <label htmlFor={`${id}-label-${index}`}>Libellé</label>
              <input
                id={`${id}-label-${index}`}
                className="et-input"
                required
                maxLength={160}
                value={item.label}
                onChange={(event) => update(index, { label: event.target.value })}
              />
            </div>
            <div className="et-field">
              <label htmlFor={`${id}-amount-${index}`}>Montant (EUR)</label>
              <input
                id={`${id}-amount-${index}`}
                className="et-input"
                inputMode="decimal"
                required
                value={item.amount}
                onChange={(event) => update(index, { amount: event.target.value })}
              />
            </div>
          </div>
          <div className="et-field">
            <label htmlFor={`${id}-notes-${index}`}>Notes (facultatif)</label>
            <textarea
              id={`${id}-notes-${index}`}
              className="et-input"
              maxLength={500}
              rows={2}
              value={item.notes}
              onChange={(event) => update(index, { notes: event.target.value })}
            />
          </div>
          <div className="et-actions" role="group" aria-label={`Actions de la ligne ${index + 1}`}>
            <button
              type="button"
              className="et-button et-button--secondary"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Monter
            </button>
            <button
              type="button"
              className="et-button et-button--secondary"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              Descendre
            </button>
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() =>
                setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              Supprimer
            </button>
          </div>
        </fieldset>
      ))}

      <div className="et-actions">
        {items.length < 100 ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => {
              nextKey.current += 1;
              setItems((current) => [
                ...current,
                {
                  key: `new-${nextKey.current}`,
                  category: 'OTHER',
                  label: '',
                  amount: '0,00',
                  notes: '',
                },
              ]);
            }}
          >
            Ajouter une ligne
          </button>
        ) : null}
        <strong data-testid="trip-cost-total">
          TOTAL :{' '}
          {euros(
            items
              .reduce((total, item) => total + BigInt(parseEuros(item.amount) ?? '0'), 0n)
              .toString(),
          )}
        </strong>
      </div>
      {status === 'LOCKED' ? (
        <p className="et-hint">
          Attention : enregistrer avec ce statut verrouille définitivement le plan.
        </p>
      ) : null}
      <button className="et-button" type="submit" disabled={busy || !valid}>
        Enregistrer les coûts
      </button>
    </form>
  );
}
