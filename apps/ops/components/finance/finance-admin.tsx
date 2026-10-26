'use client';

import type {
  FinanceExpense,
  FinanceExpenseType,
  FinanceRevenueType,
  FinanceTripSummary,
  PrivateDownload,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { ProfitabilityPanel } from './profitability-panel';

const REVENUE_LABELS: Record<FinanceRevenueType, string> = {
  BAGGAGE: 'Bagage',
  OPTION: 'Option',
  OTHER: 'Autre',
};

const EXPENSE_LABELS: Record<FinanceExpenseType, string> = {
  FUEL: 'Carburant',
  FERRY: 'Ferry',
  TOLL: 'Péage',
  CREW: 'Équipage',
  HOTEL: 'Hôtel',
  MAINTENANCE: 'Maintenance',
  BORDER: 'Frontière',
  INSURANCE: 'Assurance',
  OTHER: 'Autre',
};

function localNow(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function parseAmount(value: string, minorUnit: number): string | null {
  const cleaned = value
    .replaceAll(' ', '')
    .replaceAll(String.fromCharCode(160), '')
    .replaceAll(String.fromCharCode(8239), '')
    .replaceAll(String.fromCharCode(9), '')
    .replaceAll(String.fromCharCode(10), '')
    .replaceAll(String.fromCharCode(13), '');
  const match = /^([0-9]+)(?:[.,]([0-9]+))?$/u.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnit) return null;
  const minor =
    BigInt(whole) * 10n ** BigInt(minorUnit) + BigInt(fraction.padEnd(minorUnit, '0') || '0');
  if (minor < 1n || minor.toString().length > 18) return null;
  return minor.toString();
}

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
  const grouped = groups.join(' ');
  return (
    (negative ? '-' : '') +
    grouped +
    (minorUnit > 0 ? ',' + fraction.padEnd(minorUnit, '0') : '') +
    ' ' +
    currencyCode
  );
}

function instant(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
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

function MoneyFields({
  amount,
  setAmount,
  currencyCode,
  setCurrencyCode,
  minorUnit,
  setMinorUnit,
  idPrefix,
}: {
  amount: string;
  setAmount: (value: string) => void;
  currencyCode: string;
  setCurrencyCode: (value: string) => void;
  minorUnit: number;
  setMinorUnit: (value: number) => void;
  idPrefix: string;
}) {
  return (
    <div className="et-network-adders">
      <div className="et-field">
        <label htmlFor={idPrefix + '-amount'}>Montant</label>
        <input
          id={idPrefix + '-amount'}
          className="et-input"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder={minorUnit === 0 ? '15000' : '125,50'}
        />
      </div>
      <div className="et-field">
        <label htmlFor={idPrefix + '-currency'}>Devise</label>
        <input
          id={idPrefix + '-currency'}
          className="et-input"
          value={currencyCode}
          maxLength={3}
          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())}
        />
      </div>
      <div className="et-field">
        <label htmlFor={idPrefix + '-minor-unit'}>Décimales</label>
        <select
          id={idPrefix + '-minor-unit'}
          className="et-select"
          value={minorUnit}
          onChange={(event) => setMinorUnit(Number(event.target.value))}
        >
          {[0, 1, 2, 3].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Summary({ summary }: { summary: FinanceTripSummary }) {
  return (
    <section className="et-network-panel" aria-labelledby="finance-summary-title">
      <div className="et-actions">
        <h2 id="finance-summary-title">Contribution du voyage {summary.trip.reference}</h2>
        <OpsStatusBadge tone="info">{summary.trip.status}</OpsStatusBadge>
      </div>
      <p>
        Les devises restent séparées. Aucune conversion de change n’est appliquée par EURO TERANGA.
      </p>
      <div className="et-table-wrap">
        <table className="et-table">
          <caption>Rentabilité opérationnelle par devise</caption>
          <thead>
            <tr>
              <th>Devise</th>
              <th>Billets</th>
              <th>Autres revenus</th>
              <th>Remboursements</th>
              <th>Revenu net</th>
              <th>Dépenses</th>
              <th>Contribution</th>
              <th>À régler</th>
            </tr>
          </thead>
          <tbody>
            {summary.currencies.length === 0 ? (
              <tr>
                <td colSpan={8}>Aucune écriture financière pour ce voyage.</td>
              </tr>
            ) : (
              summary.currencies.map((currency) => (
                <tr key={currency.currencyCode + ':' + String(currency.currencyMinorUnit)}>
                  <td>{currency.currencyCode}</td>
                  <td>
                    {money(
                      currency.ticketRevenueMinor,
                      currency.currencyCode,
                      currency.currencyMinorUnit,
                    )}
                  </td>
                  <td>
                    {money(
                      currency.additionalRevenueMinor,
                      currency.currencyCode,
                      currency.currencyMinorUnit,
                    )}
                  </td>
                  <td>
                    {money(currency.refundMinor, currency.currencyCode, currency.currencyMinorUnit)}
                  </td>
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
                    <strong>
                      {money(
                        currency.contributionMinor,
                        currency.currencyCode,
                        currency.currencyMinorUnit,
                      )}
                    </strong>
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
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RevenueForm({
  tripReference,
  onSaved,
}: {
  tripReference: string;
  onSaved: () => Promise<void>;
}) {
  const [type, setType] = useState<FinanceRevenueType>('OPTION');
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [minorUnit, setMinorUnit] = useState(2);
  const [description, setDescription] = useState('');
  const [baggageReference, setBaggageReference] = useState('');
  const [occurredAt, setOccurredAt] = useState(localNow());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseAmount(amount, minorUnit);
    if (!amountMinor || !/^[A-Z]{3}$/u.test(currencyCode)) {
      setError('Vérifiez le montant, la devise et le nombre de décimales.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.finance.createRevenue(tripReference, {
        type,
        amountMinor,
        currencyCode,
        currencyMinorUnit: minorUnit,
        description: description.trim(),
        occurredAt: new Date(occurredAt).toISOString(),
        ...(type === 'BAGGAGE' ? { baggageReference: baggageReference.trim().toUpperCase() } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAmount('');
      setDescription('');
      setBaggageReference('');
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="et-form et-network-form" aria-label="Ajouter une recette" onSubmit={submit}>
      <h3>Ajouter une recette hors billet</h3>
      <FormAlert message={error} />
      <div className="et-network-adders">
        <div className="et-field">
          <label htmlFor="finance-revenue-type">Type</label>
          <select
            id="finance-revenue-type"
            className="et-select"
            value={type}
            onChange={(event) => setType(event.target.value as FinanceRevenueType)}
          >
            {(Object.keys(REVENUE_LABELS) as FinanceRevenueType[]).map((value) => (
              <option key={value} value={value}>
                {REVENUE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor="finance-revenue-description">Description</label>
          <input
            id="finance-revenue-description"
            className="et-input"
            value={description}
            minLength={3}
            maxLength={500}
            required
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="et-field">
          <label htmlFor="finance-revenue-date">Date</label>
          <input
            id="finance-revenue-date"
            className="et-input"
            type="datetime-local"
            value={occurredAt}
            required
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </div>
      </div>
      <MoneyFields
        amount={amount}
        setAmount={setAmount}
        currencyCode={currencyCode}
        setCurrencyCode={setCurrencyCode}
        minorUnit={minorUnit}
        setMinorUnit={setMinorUnit}
        idPrefix="finance-revenue"
      />
      {type === 'BAGGAGE' ? (
        <div className="et-field">
          <label htmlFor="finance-baggage-reference">Référence bagage</label>
          <input
            id="finance-baggage-reference"
            className="et-input"
            value={baggageReference}
            maxLength={16}
            required
            onChange={(event) => setBaggageReference(event.target.value.toUpperCase())}
          />
        </div>
      ) : null}
      <button className="et-button" type="submit" disabled={busy || description.trim().length < 3}>
        Enregistrer la recette
      </button>
    </form>
  );
}

function ExpenseForm({
  tripReference,
  onSaved,
}: {
  tripReference: string;
  onSaved: () => Promise<void>;
}) {
  const [type, setType] = useState<FinanceExpenseType>('FUEL');
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [minorUnit, setMinorUnit] = useState(2);
  const [description, setDescription] = useState('');
  const [vendorLabel, setVendorLabel] = useState('');
  const [occurredAt, setOccurredAt] = useState(localNow());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseAmount(amount, minorUnit);
    if (!amountMinor || !/^[A-Z]{3}$/u.test(currencyCode)) {
      setError('Vérifiez le montant, la devise et le nombre de décimales.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.finance.createExpense(tripReference, {
        type,
        amountMinor,
        currencyCode,
        currencyMinorUnit: minorUnit,
        description: description.trim(),
        ...(vendorLabel.trim() ? { vendorLabel: vendorLabel.trim() } : {}),
        occurredAt: new Date(occurredAt).toISOString(),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAmount('');
      setDescription('');
      setVendorLabel('');
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="et-form et-network-form" aria-label="Ajouter une dépense" onSubmit={submit}>
      <h3>Ajouter une dépense</h3>
      <FormAlert message={error} />
      <div className="et-network-adders">
        <div className="et-field">
          <label htmlFor="finance-expense-type">Type</label>
          <select
            id="finance-expense-type"
            className="et-select"
            value={type}
            onChange={(event) => setType(event.target.value as FinanceExpenseType)}
          >
            {(Object.keys(EXPENSE_LABELS) as FinanceExpenseType[]).map((value) => (
              <option key={value} value={value}>
                {EXPENSE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor="finance-expense-description">Description</label>
          <input
            id="finance-expense-description"
            className="et-input"
            value={description}
            minLength={3}
            maxLength={500}
            required
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="et-field">
          <label htmlFor="finance-expense-vendor">Fournisseur / bénéficiaire</label>
          <input
            id="finance-expense-vendor"
            className="et-input"
            value={vendorLabel}
            maxLength={160}
            onChange={(event) => setVendorLabel(event.target.value)}
          />
        </div>
        <div className="et-field">
          <label htmlFor="finance-expense-date">Date</label>
          <input
            id="finance-expense-date"
            className="et-input"
            type="datetime-local"
            value={occurredAt}
            required
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </div>
      </div>
      <MoneyFields
        amount={amount}
        setAmount={setAmount}
        currencyCode={currencyCode}
        setCurrencyCode={setCurrencyCode}
        minorUnit={minorUnit}
        setMinorUnit={setMinorUnit}
        idPrefix="finance-expense"
      />
      <button className="et-button" type="submit" disabled={busy || description.trim().length < 3}>
        Enregistrer la dépense
      </button>
    </form>
  );
}

function RefundForm({
  paymentReference,
  currencyCode,
  minorUnit,
  onSaved,
}: {
  paymentReference: string;
  currencyCode: string;
  minorUnit: number;
  onSaved: () => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseAmount(amount, minorUnit);
    if (!amountMinor) {
      setError('Montant de remboursement invalide.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.finance.refundPayment(paymentReference, {
        clientRefundId: crypto.randomUUID(),
        amountMinor,
        reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAmount('');
      setReason('');
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="et-form" aria-label={'Rembourser ' + paymentReference} onSubmit={submit}>
      <FormAlert message={error} />
      <p className="et-hint" data-testid={'refund-not-sent-' + paymentReference}>
        Enregistre le remboursement et son avoir dans EURO TERANGA uniquement : aucun ordre de
        remboursement n’est envoyé au prestataire de paiement. Exécutez-le d’abord chez le
        prestataire (pour Stripe ou PayPal, dans leur tableau de bord).
      </p>
      <div className="et-network-adders">
        <div className="et-field">
          <label htmlFor={'refund-amount-' + paymentReference}>Montant ({currencyCode})</label>
          <input
            id={'refund-amount-' + paymentReference}
            className="et-input"
            value={amount}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="et-field">
          <label htmlFor={'refund-reason-' + paymentReference}>Motif</label>
          <input
            id={'refund-reason-' + paymentReference}
            className="et-input"
            value={reason}
            minLength={3}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <button
        className="et-button et-button--secondary"
        type="submit"
        disabled={busy || reason.trim().length < 3}
      >
        Enregistrer le remboursement et l’avoir
      </button>
    </form>
  );
}

function ExpenseActions({
  expense,
  onSaved,
  onError,
}: {
  expense: FinanceExpense;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const payout = async (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseAmount(payoutAmount, expense.currencyMinorUnit);
    if (!amountMinor) {
      onError('Montant de règlement invalide.');
      return;
    }
    setBusy(true);
    try {
      const result = await auth.admin.finance.recordPayout(expense.reference, {
        clientPayoutId: crypto.randomUUID(),
        amountMinor,
        paidAt: new Date().toISOString(),
        ...(payoutNote.trim() ? { note: payoutNote.trim() } : {}),
      });
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      setPayoutAmount('');
      setPayoutNote('');
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await auth.admin.finance.uploadReceipt(expense.reference, file);
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      setFile(null);
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  const download = async (receiptId: string) => {
    const result = await auth.admin.finance.downloadReceipt(expense.reference, receiptId);
    if (result.ok) saveDownload(result.data);
    else onError(result.error.message);
  };

  return (
    <div className="et-form">
      <form onSubmit={payout}>
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={'payout-' + expense.reference}>Règlement</label>
            <input
              id={'payout-' + expense.reference}
              className="et-input"
              value={payoutAmount}
              inputMode="decimal"
              onChange={(event) => setPayoutAmount(event.target.value)}
            />
          </div>
          <div className="et-field">
            <label htmlFor={'payout-note-' + expense.reference}>Note</label>
            <input
              id={'payout-note-' + expense.reference}
              className="et-input"
              value={payoutNote}
              maxLength={500}
              onChange={(event) => setPayoutNote(event.target.value)}
            />
          </div>
        </div>
        <button className="et-button et-button--secondary" type="submit" disabled={busy}>
          Enregistrer le règlement
        </button>
      </form>
      <div className="et-field">
        <label htmlFor={'receipt-' + expense.reference}>Justificatif PDF/JPEG/PNG</label>
        <input
          id={'receipt-' + expense.reference}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>
      <button
        type="button"
        className="et-button et-button--secondary"
        disabled={busy || !file}
        onClick={upload}
      >
        Ajouter le justificatif
      </button>
      {expense.receipts.length ? (
        <ul>
          {expense.receipts.map((receipt) => (
            <li key={receipt.id}>
              {receipt.reference} · {Math.ceil(receipt.sizeBytes / 1024)} Ko{' '}
              <button
                type="button"
                className="et-button et-button--secondary"
                onClick={() => download(receipt.id)}
              >
                Télécharger
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FinanceAdmin() {
  const canManage = useCan('finance.manage');
  const canRefund = useCan('payment.refund');
  const [tripReference, setTripReference] = useState('');
  const [activeReference, setActiveReference] = useState('');
  const [summary, setSummary] = useState<FinanceTripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (reference = activeReference) => {
    if (!reference) return;
    const result = await auth.admin.finance.trip(reference);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSummary(result.data);
    setError(null);
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const reference = tripReference.trim().toUpperCase();
    if (!reference || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.finance.trip(reference);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setActiveReference(reference);
      setSummary(result.data);
    } finally {
      setBusy(false);
    }
  };

  const downloadExport = async (kind: 'csv' | 'xlsx') => {
    if (!activeReference) return;
    const result =
      kind === 'csv'
        ? await auth.admin.finance.exportCsv(activeReference)
        : await auth.admin.finance.exportXlsx(activeReference);
    if (result.ok) saveDownload(result.data);
    else setError(result.error.message);
  };

  const voidEntry = async (kind: 'revenue' | 'expense', reference: string) => {
    const reason = window.prompt("Motif d'annulation de cette écriture :");
    if (!reason || reason.trim().length < 3) return;
    const result =
      kind === 'revenue'
        ? await auth.admin.finance.voidRevenue(reference, reason.trim())
        : await auth.admin.finance.voidExpense(reference, reason.trim());
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setNotice('Écriture annulée. Son historique reste conservé.');
    await load();
  };

  return (
    <div
      className="et-network ops-operations-workspace ops-finance-workspace"
      data-testid="finance-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Pilotage financier</p>
          <h2>Finance opérationnelle</h2>
          <p>
            Finance opérationnelle par voyage. Les paiements réussis restent la source des revenus
            billets. Les règlements de dépenses ne sont jamais comptés une seconde fois dans la
            marge.
          </p>
        </div>
      </div>

      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      <form
        className="et-form et-network-form ops-finance-search"
        aria-label="Charger la finance d’un voyage"
        onSubmit={search}
      >
        <div className="et-field">
          <label htmlFor="finance-trip-reference">Référence voyage</label>
          <input
            id="finance-trip-reference"
            className="et-input"
            value={tripReference}
            maxLength={32}
            placeholder="ET-..."
            onChange={(event) => setTripReference(event.target.value.toUpperCase())}
          />
        </div>
        <button type="submit" className="et-button" disabled={busy || !tripReference.trim()}>
          Charger le voyage
        </button>
      </form>

      {summary ? (
        <>
          <section className="ops-operations-kpis" aria-label="Indicateurs finance">
            <OpsKpiCard
              label="Devises"
              value={summary.currencies.length}
              helper="Jamais agrégées entre elles"
              icon="finance"
              tone="info"
            />
            <OpsKpiCard
              label="Paiements réussis"
              value={summary.payments.length}
              helper="Source des revenus billets"
              icon="payment"
              tone="success"
            />
            <OpsKpiCard
              label="Recettes additionnelles"
              value={summary.revenues.length}
              helper="Écritures du voyage"
              icon="chart"
              tone="info"
            />
            <OpsKpiCard
              label="Dépenses"
              value={summary.expenses.length}
              helper="Écritures et règlements suivis"
              icon="audit"
              tone="neutral"
            />
          </section>

          <Summary summary={summary} />
          <ProfitabilityPanel
            key={activeReference}
            tripReference={activeReference}
            refreshKey={summary}
          />
          <div className="et-actions ops-finance-export-actions">
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => downloadExport('csv')}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => downloadExport('xlsx')}
            >
              Export XLSX
            </button>
          </div>

          {canManage ? (
            <div className="et-network-grid ops-finance-entry-grid">
              <RevenueForm tripReference={activeReference} onSaved={() => load()} />
              <ExpenseForm tripReference={activeReference} onSaved={() => load()} />
            </div>
          ) : null}

          <section
            className="et-network-panel ops-finance-panel"
            aria-labelledby="finance-payments-title"
          >
            <h2 id="finance-payments-title">Billets et remboursements</h2>
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>Paiements réussis du voyage</caption>
                <thead>
                  <tr>
                    <th>Paiement</th>
                    <th>Réservation</th>
                    <th>Montant</th>
                    <th>Remboursé</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.payments.map((payment) => {
                    const refunded = payment.refunds.reduce(
                      (total, refund) => total + BigInt(refund.amountMinor),
                      0n,
                    );
                    return (
                      <tr key={payment.id}>
                        <td className="et-code">{payment.reference}</td>
                        <td className="et-code">{payment.booking.reference}</td>
                        <td>
                          {money(
                            payment.amountMinor,
                            payment.currencyCode,
                            payment.currencyMinorUnit,
                          )}
                        </td>
                        <td>
                          {money(
                            refunded.toString(),
                            payment.currencyCode,
                            payment.currencyMinorUnit,
                          )}
                          {payment.refunds.map((refund) => (
                            <div key={refund.id}>
                              <span className="et-code">{refund.reference}</span> ·{' '}
                              {instant(refund.recordedAt)}
                              {refund.creditNote ? (
                                <>
                                  {' '}
                                  · avoir{' '}
                                  <span className="et-code">{refund.creditNote.reference}</span>
                                </>
                              ) : null}
                            </div>
                          ))}
                          {canRefund && refunded < BigInt(payment.amountMinor) ? (
                            <RefundForm
                              paymentReference={payment.reference}
                              currencyCode={payment.currencyCode}
                              minorUnit={payment.currencyMinorUnit}
                              onSaved={() => load()}
                            />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className="et-network-panel ops-finance-panel"
            aria-labelledby="finance-revenues-title"
          >
            <h2 id="finance-revenues-title">Recettes additionnelles</h2>
            <div className="et-table-wrap">
              <table className="et-table">
                <thead>
                  <tr>
                    <th>Référence</th>
                    <th>Type</th>
                    <th>Montant</th>
                    <th>Description</th>
                    <th>État</th>
                    {canManage ? <th>Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {summary.revenues.map((revenue) => (
                    <tr key={revenue.id}>
                      <td className="et-code">{revenue.reference}</td>
                      <td>{REVENUE_LABELS[revenue.type]}</td>
                      <td>
                        {money(
                          revenue.amountMinor,
                          revenue.currencyCode,
                          revenue.currencyMinorUnit,
                        )}
                      </td>
                      <td>{revenue.description}</td>
                      <td>
                        <OpsStatusBadge tone={revenue.status === 'ACTIVE' ? 'success' : 'neutral'}>
                          {revenue.status === 'ACTIVE' ? 'Active' : 'Annulée'}
                        </OpsStatusBadge>
                      </td>
                      {canManage ? (
                        <td>
                          {revenue.status === 'ACTIVE' ? (
                            <button
                              type="button"
                              className="et-button et-button--secondary"
                              onClick={() => void voidEntry('revenue', revenue.reference)}
                            >
                              Annuler
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className="et-network-panel ops-finance-panel"
            aria-labelledby="finance-expenses-title"
          >
            <h2 id="finance-expenses-title">Dépenses et règlements</h2>
            {summary.expenses.map((expense) => (
              <article key={expense.id} className="et-network-panel ops-finance-expense">
                <div className="et-actions">
                  <h3>
                    {EXPENSE_LABELS[expense.type]} ·{' '}
                    <span className="et-code">{expense.reference}</span>
                  </h3>
                  <strong>
                    {money(expense.amountMinor, expense.currencyCode, expense.currencyMinorUnit)}
                  </strong>
                </div>
                <p>
                  {expense.description}
                  {expense.vendorLabel ? ' · ' + expense.vendorLabel : ''}
                  {' · '}
                  {instant(expense.occurredAt)}
                </p>
                <p className="ops-finance-expense-status">
                  <OpsStatusBadge tone={expense.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {expense.status === 'ACTIVE' ? 'Active' : 'Annulée'}
                  </OpsStatusBadge>
                  <span>
                    Règlements :{' '}
                    {money(
                      expense.payouts
                        .reduce((total, payout) => total + BigInt(payout.amountMinor), 0n)
                        .toString(),
                      expense.currencyCode,
                      expense.currencyMinorUnit,
                    )}
                  </span>
                </p>
                {canManage && expense.status === 'ACTIVE' ? (
                  <>
                    <ExpenseActions expense={expense} onSaved={() => load()} onError={setError} />
                    {expense.payouts.length === 0 ? (
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        onClick={() => void voidEntry('expense', expense.reference)}
                      >
                        Annuler la dépense
                      </button>
                    ) : null}
                  </>
                ) : null}
              </article>
            ))}
          </section>
        </>
      ) : null}
    </div>
  );
}
