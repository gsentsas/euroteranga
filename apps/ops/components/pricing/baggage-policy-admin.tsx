'use client';

import {
  type AdminFareTableSummary,
  type BaggagePolicy,
  type BaggagePolicyVersion,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { useCan } from '../staff-access';

interface TierDraft {
  key: number;
  code: string;
  label: string;
  maxExcessWeightKg: string;
  amount: string;
}

function parseExactMoney(input: string, minorUnit: number): string | null {
  const cleaned = input.replace(/[\s\u00a0\u202f]/g, '');
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(cleaned);
  if (!match) return null;
  const integer = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnit) return null;
  const minor =
    BigInt(integer) * 10n ** BigInt(minorUnit) + BigInt(fraction.padEnd(minorUnit, '0') || '0');
  return minor <= 9_223_372_036_854_775_807n ? minor.toString() : null;
}

function formatExactMoney(amountMinor: string, currencyCode: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  const factor = 10n ** BigInt(minorUnit);
  const integer = amount / factor;
  const fraction = (amount % factor).toString().padStart(minorUnit, '0');
  return `${integer.toString()}${minorUnit ? `,${fraction}` : ''} ${currencyCode}`;
}

function moneyInputValue(amountMinor: string, minorUnit: number): string {
  const amount = BigInt(amountMinor);
  const factor = 10n ** BigInt(minorUnit);
  const integer = amount / factor;
  const fraction = (amount % factor).toString().padStart(minorUnit, '0');
  return `${integer.toString()}${minorUnit ? `,${fraction}` : ''}`;
}

function statusLabel(status: BaggagePolicyVersion['status']) {
  return status === 'DRAFT' ? 'Brouillon' : status === 'PUBLISHED' ? 'Publiée' : 'Retirée';
}

function CreatePolicy({
  busy,
  run,
  onCreated,
}: {
  busy: boolean;
  run: ReturnType<typeof useAdminFeedback>['run'];
  onCreated: (id: string) => void;
}) {
  const unitId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [minorUnit, setMinorUnit] = useState('2');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let id: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.baggagePolicies.create({
        code,
        name,
        currencyCode,
        currencyMinorUnit: Number(minorUnit),
        active: true,
      });
      if (result.ok) id = result.data.id;
      return result;
    }, `Politique bagage ${code.trim().toUpperCase()} créée.`);
    if (ok && id) {
      setCode('');
      setName('');
      onCreated(id);
    }
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label="Créer une politique bagage"
      onSubmit={submit}
    >
      <h3>Créer une politique de franchise</h3>
      <TextField
        label="Code"
        name="baggagePolicyCode"
        value={code}
        onChange={setCode}
        autoComplete="off"
        maxLength={32}
      />
      <TextField
        label="Nom"
        name="baggagePolicyName"
        value={name}
        onChange={setName}
        autoComplete="off"
        maxLength={160}
      />
      <TextField
        label="Devise"
        name="baggagePolicyCurrency"
        value={currencyCode}
        onChange={setCurrencyCode}
        autoComplete="off"
        maxLength={3}
      />
      <div className="et-field">
        <label htmlFor={unitId}>Décimales de la devise</label>
        <select
          id={unitId}
          className="et-select"
          value={minorUnit}
          onChange={(event) => setMinorUnit(event.target.value)}
        >
          {['0', '1', '2', '3'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="et-button" disabled={busy}>
        Créer la politique
      </button>
    </form>
  );
}

function DraftEditor({
  policy,
  draft,
  busy,
  run,
  onReload,
}: {
  policy: BaggagePolicy;
  draft: BaggagePolicyVersion;
  busy: boolean;
  run: ReturnType<typeof useAdminFeedback>['run'];
  onReload: () => Promise<void>;
}) {
  const [tiers, setTiers] = useState<TierDraft[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setTiers(
      draft.tiers.map((tier, index) => ({
        key: index + 1,
        code: tier.code,
        label: tier.label,
        maxExcessWeightKg: tier.maxExcessWeightKg,
        amount: moneyInputValue(tier.chargeMinor, policy.currencyMinorUnit),
      })),
    );
    setNextKey(draft.tiers.length + 1);
  }, [draft, policy.currencyCode, policy.currencyMinorUnit]);

  const addTier = () => {
    setTiers((current) => [
      ...current,
      { key: nextKey, code: '', label: '', maxExcessWeightKg: '', amount: '' },
    ]);
    setNextKey((value) => value + 1);
  };

  const save = async () => {
    if (tiers.length === 0) {
      setLocalError('Ajoutez au moins un palier d’excédent.');
      return;
    }
    const parsed = tiers.map((tier, position) => {
      const amountMinor = parseExactMoney(tier.amount, policy.currencyMinorUnit);
      return {
        ...tier,
        position,
        amountMinor,
      };
    });
    if (
      parsed.some(
        (tier) =>
          !tier.code.trim() ||
          !tier.label.trim() ||
          !tier.maxExcessWeightKg.trim() ||
          tier.amountMinor === null,
      )
    ) {
      setLocalError('Complétez chaque palier avec un poids maximal et un prix exact valide.');
      return;
    }
    setLocalError(null);
    const ok = await run(
      () =>
        auth.admin.baggagePolicies.replaceTiers(policy.id, draft.id, {
          tiers: parsed.map((tier) => ({
            code: tier.code,
            label: tier.label,
            maxExcessWeightKg: tier.maxExcessWeightKg.replace(',', '.'),
            chargeMinor: tier.amountMinor!,
            position: tier.position,
          })),
        }),
      `Paliers de la politique ${policy.code} enregistrés.`,
    );
    if (ok) await onReload();
  };

  const publish = async () => {
    if (draft.tiers.length === 0) return;
    const ok = await run(
      () => auth.admin.baggagePolicies.publishVersion(policy.id, draft.id),
      `Version ${draft.version} de la politique ${policy.code} publiée.`,
    );
    if (ok) await onReload();
  };

  return (
    <section className="et-network-panel" aria-labelledby="baggage-policy-draft-title">
      <h4 id="baggage-policy-draft-title">Brouillon version {draft.version}</h4>
      <p>
        Franchise : {draft.includedPieces} pièce(s) ×{' '}
        {draft.includedWeightKgPerPiece.replace('.', ',')} kg. Les paliers ci-dessous portent sur le{' '}
        <strong>poids d’excédent</strong>. Aucun paiement n’est créé.
      </p>
      {localError ? (
        <p className="et-error" role="status">
          {localError}
        </p>
      ) : null}
      {tiers.map((tier, index) => (
        <div className="et-network-adders" key={tier.key}>
          <TextField
            label={`Code palier ${index + 1}`}
            name={`tierCode${tier.key}`}
            value={tier.code}
            onChange={(value) =>
              setTiers((current) =>
                current.map((row) => (row.key === tier.key ? { ...row, code: value } : row)),
              )
            }
            autoComplete="off"
            maxLength={32}
          />
          <TextField
            label="Libellé"
            name={`tierLabel${tier.key}`}
            value={tier.label}
            onChange={(value) =>
              setTiers((current) =>
                current.map((row) => (row.key === tier.key ? { ...row, label: value } : row)),
              )
            }
            autoComplete="off"
            maxLength={160}
          />
          <TextField
            label="Excédent maximal (kg)"
            name={`tierWeight${tier.key}`}
            value={tier.maxExcessWeightKg}
            onChange={(value) =>
              setTiers((current) =>
                current.map((row) =>
                  row.key === tier.key ? { ...row, maxExcessWeightKg: value } : row,
                ),
              )
            }
            autoComplete="off"
            maxLength={7}
          />
          <TextField
            label={`Prix (${policy.currencyCode})`}
            name={`tierAmount${tier.key}`}
            value={tier.amount}
            onChange={(value) =>
              setTiers((current) =>
                current.map((row) => (row.key === tier.key ? { ...row, amount: value } : row)),
              )
            }
            autoComplete="off"
            maxLength={32}
          />
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => setTiers((current) => current.filter((row) => row.key !== tier.key))}
          >
            Retirer
          </button>
        </div>
      ))}
      <div className="et-actions">
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={addTier}
          disabled={busy}
        >
          Ajouter un palier
        </button>
        <button type="button" className="et-button" onClick={() => void save()} disabled={busy}>
          Enregistrer les paliers
        </button>
        <button
          type="button"
          className="et-button"
          onClick={() => void publish()}
          disabled={busy || draft.tiers.length === 0}
        >
          Publier la version {draft.version}
        </button>
      </div>
    </section>
  );
}

function PolicyDetail({
  policy,
  fareTables,
  canManage,
  busy,
  run,
  onReload,
}: {
  policy: BaggagePolicy;
  fareTables: AdminFareTableSummary[];
  canManage: boolean;
  busy: boolean;
  run: ReturnType<typeof useAdminFeedback>['run'];
  onReload: () => Promise<void>;
}) {
  const fareId = useId();
  const [fareTableVersionId, setFareTableVersionId] = useState('');
  const [includedPieces, setIncludedPieces] = useState('');
  const [includedWeight, setIncludedWeight] = useState('');
  const draft = policy.versions.find((version) => version.status === 'DRAFT');

  const compatible = fareTables.flatMap((table) =>
    table.currencyCode === policy.currencyCode &&
    table.currencyMinorUnit === policy.currencyMinorUnit
      ? table.versions
          .filter((version) => version.status === 'PUBLISHED')
          .map((version) => ({
            id: version.id,
            label: `${table.code} v${version.version} — ${table.route.name}`,
          }))
      : [],
  );

  const createVersion = async (event: FormEvent) => {
    event.preventDefault();
    const pieces = Number(includedPieces);
    if (!fareTableVersionId || !Number.isInteger(pieces) || pieces < 0 || !includedWeight.trim())
      return;
    const ok = await run(
      () =>
        auth.admin.baggagePolicies.createVersion(policy.id, {
          fareTableVersionId,
          includedPieces: pieces,
          includedWeightKgPerPiece: includedWeight.replace(',', '.'),
        }),
      `Brouillon de franchise ${policy.code} créé.`,
    );
    if (ok) {
      setIncludedPieces('');
      setIncludedWeight('');
      await onReload();
    }
  };

  const toggle = async () => {
    const ok = await run(
      () => auth.admin.baggagePolicies.update(policy.id, { active: !policy.active }),
      `Politique ${policy.code} ${policy.active ? 'désactivée' : 'activée'}.`,
    );
    if (ok) await onReload();
  };

  return (
    <section className="et-network-panel" data-testid="baggage-policy-detail">
      <h3>
        {policy.code} — {policy.name}
      </h3>
      <p>
        Devise : {policy.currencyCode} · état : {policy.active ? 'active' : 'désactivée'}. La
        politique est figée sur chaque bagage lors de son enregistrement.
      </p>
      {canManage ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void toggle()}
          disabled={busy}
        >
          {policy.active ? 'Désactiver' : 'Activer'} la politique
        </button>
      ) : null}
      {canManage && !draft ? (
        <form
          className="et-form et-network-form"
          aria-label="Créer une version de franchise"
          onSubmit={createVersion}
        >
          <div className="et-field">
            <label htmlFor={fareId}>Version tarifaire historique</label>
            <select
              id={fareId}
              className="et-select"
              value={fareTableVersionId}
              onChange={(event) => setFareTableVersionId(event.target.value)}
            >
              <option value="">Choisir une version publiée</option>
              {compatible.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Nombre de pièces incluses"
            name="includedPieces"
            value={includedPieces}
            onChange={setIncludedPieces}
            autoComplete="off"
            maxLength={2}
          />
          <TextField
            label="Poids inclus par pièce (kg)"
            name="includedWeight"
            value={includedWeight}
            onChange={setIncludedWeight}
            autoComplete="off"
            maxLength={7}
          />
          <button type="submit" className="et-button" disabled={busy}>
            Créer le brouillon
          </button>
        </form>
      ) : null}

      <h4>Versions</h4>
      {policy.versions.map((version) => (
        <details key={version.id} open={version.status === 'DRAFT'}>
          <summary>
            Version {version.version} · {statusLabel(version.status)} · {version.includedPieces} ×{' '}
            {version.includedWeightKgPerPiece.replace('.', ',')} kg · {version.baggageCount}{' '}
            bagage(s)
          </summary>
          <p>
            Tarification : {version.fareTableVersion.fareTable.code} v
            {version.fareTableVersion.version}.
          </p>
          {version.status === 'DRAFT' && canManage ? (
            <DraftEditor
              policy={policy}
              draft={version}
              busy={busy}
              run={run}
              onReload={onReload}
            />
          ) : version.tiers.length === 0 ? (
            <p>Aucun palier.</p>
          ) : (
            <div className="et-table-wrap">
              <table className="et-table">
                <caption>Paliers de la version {version.version}</caption>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Excédent max.</th>
                    <th>Prix</th>
                  </tr>
                </thead>
                <tbody>
                  {version.tiers.map((tier) => (
                    <tr key={tier.id}>
                      <th>
                        {tier.code} — {tier.label}
                      </th>
                      <td>{tier.maxExcessWeightKg.replace('.', ',')} kg</td>
                      <td>
                        {formatExactMoney(
                          tier.chargeMinor,
                          policy.currencyCode,
                          policy.currencyMinorUnit,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ))}
    </section>
  );
}

export function BaggagePolicyAdmin() {
  const canManage = useCan('pricing.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [policies, setPolicies] = useState<BaggagePolicy[] | null>(null);
  const [fareTables, setFareTables] = useState<AdminFareTableSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BaggagePolicy | null>(null);

  const load = useCallback(async () => {
    const [policyResult, fareResult] = await Promise.all([
      auth.admin.baggagePolicies.list({ limit: 100 }),
      auth.admin.pricing.fareTables({ limit: 100 }),
    ]);
    if (!policyResult.ok) {
      setError(policyResult.error.message);
      return;
    }
    setPolicies(policyResult.data.items);
    if (fareResult.ok) setFareTables(fareResult.data.items);
  }, [setError]);

  const loadDetail = useCallback(
    async (id: string) => {
      const result = await auth.admin.baggagePolicies.detail(id);
      if (result.ok) setDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  return (
    <section
      className="et-network"
      aria-labelledby="baggage-policy-title"
      data-testid="baggage-policy-workspace"
    >
      <h2 id="baggage-policy-title">Franchises & bagages supplémentaires</h2>
      <p>
        Configurez le nombre de pièces incluses, le poids par pièce et les paliers d’excédent. Les
        montants sont versionnés avec la tarification ; aucun paiement n’est déclenché ici.
      </p>
      {feedback}
      {canManage ? (
        <CreatePolicy
          busy={busy}
          run={run}
          onCreated={(id) => {
            void load().then(() => setSelectedId(id));
          }}
        />
      ) : null}
      {!policies ? <p role="status">Chargement des politiques bagage…</p> : null}
      {policies ? (
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Politiques de franchise bagage</caption>
            <thead>
              <tr>
                <th>Code</th>
                <th>Devise</th>
                <th>Version publiée</th>
                <th>État</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => {
                const published = policy.versions.find((version) => version.status === 'PUBLISHED');
                return (
                  <tr key={policy.id}>
                    <th>
                      {policy.code} — {policy.name}
                    </th>
                    <td>{policy.currencyCode}</td>
                    <td>
                      {published
                        ? `v${published.version} · ${published.includedPieces} × ${published.includedWeightKgPerPiece.replace('.', ',')} kg`
                        : '—'}
                    </td>
                    <td>{policy.active ? 'Active' : 'Désactivée'}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        onClick={() => setSelectedId(policy.id)}
                      >
                        Consulter
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {selectedId && !detail ? <p role="status">Chargement de la politique…</p> : null}
      {detail ? (
        <PolicyDetail
          policy={detail}
          fareTables={fareTables}
          canManage={canManage}
          busy={busy}
          run={run}
          onReload={reload}
        />
      ) : null}
    </section>
  );
}
