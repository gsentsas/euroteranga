'use client';

import type { RoadFreightQuote, RoadFreightQuoteLineKind } from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';

type LineDraft = {
  key: string;
  kind: RoadFreightQuoteLineKind;
  label: string;
  amount: string;
  notes: string;
};

const STATUS_LABELS: Record<RoadFreightQuote['status'], string> = {
  DRAFT: 'Brouillon',
  ISSUED: 'Émis',
  ACCEPTED: 'Accepté',
  SUPERSEDED: 'Remplacé',
  CANCELLED: 'Annulé',
};

function parseAmount(value: string, minorUnit: number): string | null {
  const cleaned = value.replace(/[\s\u00a0\u202f]/gu, '');
  const match = /^([0-9]+)(?:[.,]([0-9]{0,3}))?$/u.exec(cleaned);
  if (!match || minorUnit < 0 || minorUnit > 3) return null;
  const fractionRaw = match[2] ?? '';
  if (fractionRaw.length > minorUnit) return null;
  const whole = match[1] ?? '0';
  const fraction = fractionRaw.padEnd(minorUnit, '0');
  const amount = BigInt(whole) * 10n ** BigInt(minorUnit) + BigInt(fraction || '0');
  if (amount <= 0n || amount.toString().length > 18) return null;
  return amount.toString();
}

function amountInput(amountMinor: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  if (minorUnit === 0) return amount.toString();
  const scale = 10n ** BigInt(minorUnit);
  return `${amount / scale},${(amount % scale).toString().padStart(minorUnit, '0')}`;
}

function formatMoney(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(minorUnit);
  const whole = (absolute / scale).toString();
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  }
  const fraction =
    minorUnit === 0 ? '' : `,${(absolute % scale).toString().padStart(minorUnit, '0')}`;
  return `${sign}${groups.join(' ')}${fraction} ${currencyCode}`;
}

function quoteLines(quote: RoadFreightQuote): LineDraft[] {
  return quote.lines.map((line) => ({
    key: line.id,
    kind: line.kind,
    label: line.label,
    amount: amountInput(line.amountMinor, quote.currencyMinorUnit),
    notes: line.notes ?? '',
  }));
}

export function CargoQuotePanel({
  shipmentReference,
  canRead,
  canManage,
}: {
  shipmentReference: string;
  canRead: boolean;
  canManage: boolean;
}) {
  const nextKey = useRef(0);
  const [quotes, setQuotes] = useState<RoadFreightQuote[]>([]);
  const [selected, setSelected] = useState<RoadFreightQuote | null>(null);
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [currencyMinorUnit, setCurrencyMinorUnit] = useState(2);
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 'initial', kind: 'CHARGE', label: 'Transport fret', amount: '', notes: '' },
  ]);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    const result = await auth.admin.cargo.quotes(shipmentReference);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setQuotes(result.data.items);
    const preferred =
      result.data.items.find((quote) => quote.status === 'DRAFT') ??
      result.data.items.find((quote) => quote.status === 'ISSUED') ??
      result.data.items[0] ??
      null;
    setSelected(preferred);
  }, [canRead, shipmentReference]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setCurrencyCode(selected.currencyCode);
    setCurrencyMinorUnit(selected.currencyMinorUnit);
    setLines(quoteLines(selected));
  }, [selected]);

  if (!canRead) {
    return (
      <section className="et-network-panel" aria-label="Tarification du fret">
        <h3>Tarification / devis</h3>
        <p>La permission de lecture des tarifs est requise pour consulter les devis.</p>
      </section>
    );
  }

  const normalizedLines = () => {
    const parsed = lines.map((line) => {
      const amountMinor = parseAmount(line.amount, currencyMinorUnit);
      if (!line.label.trim() || !amountMinor) return null;
      return {
        kind: line.kind,
        label: line.label.trim(),
        amountMinor,
        ...(line.notes.trim() ? { notes: line.notes.trim() } : {}),
      };
    });
    return parsed.every((line) => line !== null)
      ? parsed.filter((line): line is NonNullable<typeof line> => line !== null)
      : null;
  };

  const run = async (
    action: () => Promise<{ ok: boolean; data?: RoadFreightQuote; error?: { message: string } }>,
    message: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error?.message ?? 'Action impossible.');
        return;
      }
      setNotice(message);
      await load();
      if (result.data) setSelected(result.data);
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const payload = normalizedLines();
    if (!payload) {
      setError('Chaque ligne doit avoir un libellé et un montant positif valide.');
      return;
    }
    void run(
      () =>
        auth.admin.cargo.createQuote(shipmentReference, {
          currencyCode: currencyCode.trim().toUpperCase(),
          currencyMinorUnit,
          lines: payload,
        }),
      'Brouillon de devis créé.',
    );
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || selected.status !== 'DRAFT') return;
    const payload = normalizedLines();
    if (!payload) {
      setError('Chaque ligne doit avoir un libellé et un montant positif valide.');
      return;
    }
    void run(
      () =>
        auth.admin.cargo.replaceQuoteLines(shipmentReference, selected.reference, {
          lines: payload,
          expectedUpdatedAt: selected.updatedAt,
        }),
      'Lignes du devis enregistrées.',
    );
  };

  const draft = quotes.find((quote) => quote.status === 'DRAFT');
  const selectedEditable = selected?.status === 'DRAFT' && canManage;

  return (
    <section
      className="et-network-panel"
      aria-label="Tarification du fret"
      data-testid="cargo-quotes"
    >
      <div className="et-actions">
        <h3>Tarification / devis</h3>
        <span className="et-tag">Paiement non déclenché</span>
      </div>
      <p>
        Chiffrage commercial manuel et versionné. Le montant n’est ni un paiement ni une écriture
        Finance.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {quotes.length ? (
        <div className="et-table-wrap">
          <table>
            <caption>Historique des devis fret</caption>
            <thead>
              <tr>
                <th>Version</th>
                <th>Référence</th>
                <th>Statut</th>
                <th>Total</th>
                <th>Créé le</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                <tr key={quote.reference}>
                  <td>v{quote.version}</td>
                  <td className="et-code">{quote.reference}</td>
                  <td>{STATUS_LABELS[quote.status]}</td>
                  <td>
                    {formatMoney(quote.totalMinor, quote.currencyCode, quote.currencyMinorUnit)}
                  </td>
                  <td>{new Date(quote.createdAt).toLocaleString('fr-FR')}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      onClick={() => setSelected(quote)}
                    >
                      Consulter
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Aucun devis enregistré.</p>
      )}

      {selected ? (
        <div data-testid="cargo-quote-detail">
          <p>
            <strong>{selected.reference}</strong> · {STATUS_LABELS[selected.status]} ·{' '}
            {formatMoney(selected.totalMinor, selected.currencyCode, selected.currencyMinorUnit)}
          </p>
          <p className="et-hint">
            Snapshot : {selected.snapshot.weightKg.replace('.', ',')} kg ·{' '}
            {selected.snapshot.volumeLiters.toLocaleString('fr-FR')} L ·{' '}
            {selected.snapshot.packageCount} pièce(s)
          </p>
          {selected.status === 'ISSUED' && canManage ? (
            <div className="et-actions">
              <button
                type="button"
                className="et-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      auth.admin.cargo.acceptQuote(shipmentReference, selected.reference, {
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    'Devis accepté. Aucun paiement n’a été déclenché.',
                  )
                }
              >
                Accepter le devis
              </button>
            </div>
          ) : null}
          {['DRAFT', 'ISSUED'].includes(selected.status) && canManage ? (
            <div className="et-actions">
              <TextField
                label="Motif d’annulation"
                name="cargoQuoteCancelReason"
                value={cancelReason}
                onChange={setCancelReason}
                required={false}
                autoComplete="off"
                maxLength={500}
              />
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy || cancelReason.trim().length < 3}
                onClick={() =>
                  void run(
                    () =>
                      auth.admin.cargo.cancelQuote(shipmentReference, selected.reference, {
                        reason: cancelReason.trim(),
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    'Devis annulé.',
                  )
                }
              >
                Annuler le devis
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {canManage && (!draft || selectedEditable) ? (
        <form
          className="et-form"
          aria-label={selectedEditable ? 'Modifier le devis fret' : 'Créer un devis fret'}
          onSubmit={selectedEditable ? save : create}
        >
          {!selectedEditable ? (
            <div className="et-network-adders">
              <TextField
                label="Devise"
                name="cargoQuoteCurrency"
                value={currencyCode}
                onChange={(value) => setCurrencyCode(value.toUpperCase())}
                autoComplete="off"
                maxLength={3}
              />
              <div className="et-field">
                <label htmlFor="cargo-quote-minor-unit">Décimales</label>
                <select
                  id="cargo-quote-minor-unit"
                  className="et-select"
                  value={currencyMinorUnit}
                  onChange={(event) => setCurrencyMinorUnit(Number(event.target.value))}
                >
                  {[0, 1, 2, 3].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {lines.map((line, index) => (
            <fieldset key={line.key} className="ops-content-item">
              <legend>Ligne {index + 1}</legend>
              <div className="et-network-adders">
                <div className="et-field">
                  <label htmlFor={`cargo-quote-kind-${index}`}>Type</label>
                  <select
                    id={`cargo-quote-kind-${index}`}
                    className="et-select"
                    value={line.kind}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, kind: event.target.value as RoadFreightQuoteLineKind }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="CHARGE">Frais</option>
                    <option value="DISCOUNT">Remise</option>
                  </select>
                </div>
                <TextField
                  label="Libellé"
                  name={`cargoQuoteLabel${index}`}
                  value={line.label}
                  onChange={(value) =>
                    setLines((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, label: value } : item,
                      ),
                    )
                  }
                  autoComplete="off"
                  maxLength={160}
                />
                <TextField
                  label={`Montant (${currencyCode || 'devise'})`}
                  name={`cargoQuoteAmount${index}`}
                  value={line.amount}
                  onChange={(value) =>
                    setLines((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, amount: value } : item,
                      ),
                    )
                  }
                  autoComplete="off"
                />
              </div>
              <TextField
                label="Note (facultatif)"
                name={`cargoQuoteNote${index}`}
                value={line.notes}
                onChange={(value) =>
                  setLines((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, notes: value } : item,
                    ),
                  )
                }
                required={false}
                autoComplete="off"
                maxLength={500}
              />
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  onClick={() =>
                    setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  Supprimer la ligne
                </button>
              ) : null}
            </fieldset>
          ))}

          <div className="et-actions">
            {lines.length < 100 ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                onClick={() => {
                  nextKey.current += 1;
                  setLines((current) => [
                    ...current,
                    {
                      key: `new-${nextKey.current}`,
                      kind: 'CHARGE',
                      label: '',
                      amount: '',
                      notes: '',
                    },
                  ]);
                }}
              >
                Ajouter une ligne
              </button>
            ) : null}
            <button type="submit" className="et-button" disabled={busy}>
              {selectedEditable ? 'Enregistrer le devis' : 'Créer le brouillon'}
            </button>
          </div>
        </form>
      ) : null}

      {selected?.status === 'DRAFT' && canManage ? (
        <button
          type="button"
          className="et-button"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                auth.admin.cargo.issueQuote(shipmentReference, selected.reference, {
                  expectedUpdatedAt: selected.updatedAt,
                }),
              'Devis émis. Toute ancienne version émise a été remplacée.',
            )
          }
        >
          Émettre le devis
        </button>
      ) : null}
    </section>
  );
}
