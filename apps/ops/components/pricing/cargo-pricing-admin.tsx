'use client';

import type {
  CargoEstimateInput,
  CargoEstimateResult,
  CargoPricingCategory,
  CargoPricingMethod,
  CargoPricingOptionInput,
  CargoPricingOptionKind,
  CargoPricingRule,
  CargoPricingTierInput,
  CargoPricingVersion,
  CargoPricingVersionInput,
  RoadFreightDirection,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { useCan } from '../staff-access';

type Run = ReturnType<typeof useAdminFeedback>['run'];
type Audience = 'PUBLIC' | 'PRO' | 'NEGOTIATED';
type Rounding = 'UP' | 'HALF_UP' | 'DOWN';

const DIRECTION_LABELS: Record<RoadFreightDirection, string> = {
  PAR_DKR: 'Paris → Dakar',
  DKR_PAR: 'Dakar → Paris',
};
const AUDIENCE_LABELS: Record<Audience, string> = {
  PUBLIC: 'Public',
  PRO: 'Professionnels',
  NEGOTIATED: 'Négocié',
};
const STATUS_LABELS: Record<CargoPricingVersion['status'], string> = {
  DRAFT: 'Brouillon',
  ACTIVE: 'Active',
  DISABLED: 'Désactivée',
};
const METHOD_LABELS: Record<CargoPricingMethod, string> = {
  ACTUAL_WEIGHT: 'Poids réel',
  VOLUMETRIC_WEIGHT: 'Poids facturable (réel / volumétrique)',
  VOLUME: 'Volume',
  FLAT_RATE: 'Forfait',
  TIERED_WEIGHT: 'Paliers de poids',
  CUSTOM_QUOTE: 'Devis personnalisé',
};
const CATEGORY_LABELS: Record<CargoPricingCategory, string> = {
  STANDARD_PARCEL: 'Colis standard',
  PERSONAL_ITEMS: 'Effets personnels',
  CLOTHING: 'Vêtements',
  DOCUMENTS: 'Documents',
  ALLOWED_FOOD: 'Alimentaire autorisé',
  EQUIPMENT: 'Matériel',
  PROFESSIONAL_GOODS: 'Marchandise professionnelle',
  UNACCOMPANIED_BAGGAGE: 'Bagage non accompagné',
  ACCOMPANIED_PARCEL: 'Colis accompagné',
  SPECIAL_HANDLING: 'Traitement spécial',
  OTHER: 'Autre',
};
const OPTION_LABELS: Record<CargoPricingOptionKind, string> = {
  PICKUP: 'Enlèvement',
  DELIVERY: 'Livraison',
  FRAGILE_HANDLING: 'Traitement fragile',
  PROFESSIONAL_HANDLING: 'Traitement professionnel',
  INSURANCE: 'Assurance',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as CargoPricingCategory[];
const OPTIONS = Object.keys(OPTION_LABELS) as CargoPricingOptionKind[];

function defaultVersion(): CargoPricingVersionInput {
  return {
    method: 'CUSTOM_QUOTE',
    currencyCode: 'EUR',
    currencyMinorUnit: 2,
    roundingMode: null,
    unitPriceMinor: null,
    flatPriceMinor: null,
    minimumChargeMinor: null,
    volumetricDivisorCm3PerKg: null,
    quoteAboveWeightKg: null,
    quoteAboveVolumeLiters: null,
    effectiveFrom: new Date().toISOString(),
    effectiveTo: null,
    categories: ['STANDARD_PARCEL'],
    tiers: [],
    options: [],
  };
}

function versionInput(version: CargoPricingVersion): CargoPricingVersionInput {
  return {
    method: version.method,
    currencyCode: version.currencyCode,
    currencyMinorUnit: version.currencyMinorUnit,
    roundingMode: version.roundingMode,
    unitPriceMinor: version.unitPriceMinor,
    flatPriceMinor: version.flatPriceMinor,
    minimumChargeMinor: version.minimumChargeMinor,
    volumetricDivisorCm3PerKg: version.volumetricDivisorCm3PerKg,
    quoteAboveWeightKg: version.quoteAboveWeightKg,
    quoteAboveVolumeLiters: version.quoteAboveVolumeLiters,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    categories: [...version.categories],
    tiers: version.tiers.map((tier) => ({ ...tier })),
    options: version.options.map((option) => ({ ...option })),
  };
}

function setOptionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function CreateCargoRuleForm({
  run,
  busy,
  onCreated,
}: {
  run: Run;
  busy: boolean;
  onCreated: (id: string) => void;
}) {
  const directionId = useId();
  const audienceId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<RoadFreightDirection>('PAR_DKR');
  const [audience, setAudience] = useState<Audience>('PUBLIC');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let id: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.pricing.createCargoRule({ code, name, direction, audience });
      if (result.ok) id = result.data.id;
      return result;
    }, `Règle fret ${code.trim().toUpperCase()} créée.`);
    if (ok && id) {
      setCode('');
      setName('');
      onCreated(id);
    }
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label="Créer une règle tarifaire fret"
      onSubmit={submit}
    >
      <h3>Créer une règle fret</h3>
      <p className="et-hint">
        La création d’une règle ne publie aucun prix. Une version doit ensuite être configurée et
        activée explicitement.
      </p>
      <TextField
        label="Code de la règle"
        name="cargoRuleCode"
        value={code}
        onChange={setCode}
        maxLength={32}
        autoComplete="off"
      />
      <TextField
        label="Nom de la règle"
        name="cargoRuleName"
        value={name}
        onChange={setName}
        maxLength={160}
        autoComplete="off"
      />
      <div className="et-field">
        <label htmlFor={directionId}>Direction</label>
        <select
          id={directionId}
          className="et-select"
          value={direction}
          onChange={(event) => setDirection(event.target.value as RoadFreightDirection)}
        >
          {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="et-field">
        <label htmlFor={audienceId}>Audience</label>
        <select
          id={audienceId}
          className="et-select"
          value={audience}
          onChange={(event) => setAudience(event.target.value as Audience)}
        >
          {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <button className="et-button" type="submit" disabled={busy || !code.trim() || !name.trim()}>
        Créer la règle fret
      </button>
    </form>
  );
}

function TierEditor({
  tiers,
  onChange,
  disabled,
}: {
  tiers: CargoPricingTierInput[];
  onChange: (tiers: CargoPricingTierInput[]) => void;
  disabled: boolean;
}) {
  const add = () => {
    const previous = tiers.at(-1);
    const minWeightKg =
      previous?.maxWeightKg ?? (tiers.length === 0 ? '0.000' : (previous?.minWeightKg ?? '0.000'));
    onChange([
      ...tiers,
      {
        position: tiers.length,
        minWeightKg,
        maxWeightKg: null,
        method: 'UNIT_WEIGHT',
        unitPriceMinor: null,
        flatPriceMinor: null,
        minimumChargeMinor: null,
      },
    ]);
  };
  const update = (index: number, patch: Partial<CargoPricingTierInput>) =>
    onChange(tiers.map((tier, candidate) => (candidate === index ? { ...tier, ...patch } : tier)));
  const remove = (index: number) =>
    onChange(
      tiers
        .filter((_, candidate) => candidate !== index)
        .map((tier, position) => ({ ...tier, position })),
    );

  return (
    <fieldset className="et-form" disabled={disabled}>
      <legend>Paliers</legend>
      {tiers.map((tier, index) => (
        <div className="et-network-panel" key={`${tier.position}-${index}`}>
          <strong>Palier {index + 1}</strong>
          <div className="et-field">
            <label>Poids minimum (kg)</label>
            <input
              className="et-input"
              value={tier.minWeightKg}
              onChange={(event) => update(index, { minWeightKg: event.target.value })}
            />
          </div>
          <div className="et-field">
            <label>Poids maximum (kg)</label>
            <input
              className="et-input"
              value={tier.maxWeightKg ?? ''}
              placeholder="Ouvert"
              onChange={(event) =>
                update(index, { maxWeightKg: setOptionalString(event.target.value) })
              }
            />
          </div>
          <div className="et-field">
            <label>Méthode du palier</label>
            <select
              className="et-select"
              value={tier.method}
              onChange={(event) =>
                update(index, {
                  method: event.target.value as CargoPricingTierInput['method'],
                  unitPriceMinor: null,
                  flatPriceMinor: null,
                  minimumChargeMinor:
                    event.target.value === 'CUSTOM_QUOTE' ? null : tier.minimumChargeMinor,
                })
              }
            >
              <option value="UNIT_WEIGHT">Prix / kg</option>
              <option value="UNIT_VOLUME">Prix / m³</option>
              <option value="FLAT_RATE">Forfait</option>
              <option value="CUSTOM_QUOTE">Devis personnalisé</option>
            </select>
          </div>
          {tier.method === 'UNIT_WEIGHT' || tier.method === 'UNIT_VOLUME' ? (
            <div className="et-field">
              <label>Prix unitaire (unités mineures)</label>
              <input
                className="et-input"
                value={tier.unitPriceMinor ?? ''}
                onChange={(event) =>
                  update(index, {
                    unitPriceMinor: setOptionalString(event.target.value),
                    flatPriceMinor: null,
                  })
                }
              />
            </div>
          ) : null}
          {tier.method === 'FLAT_RATE' ? (
            <div className="et-field">
              <label>Forfait (unités mineures)</label>
              <input
                className="et-input"
                value={tier.flatPriceMinor ?? ''}
                onChange={(event) =>
                  update(index, {
                    flatPriceMinor: setOptionalString(event.target.value),
                    unitPriceMinor: null,
                  })
                }
              />
            </div>
          ) : null}
          {tier.method !== 'CUSTOM_QUOTE' ? (
            <div className="et-field">
              <label>Minimum du palier (unités mineures)</label>
              <input
                className="et-input"
                value={tier.minimumChargeMinor ?? ''}
                onChange={(event) =>
                  update(index, { minimumChargeMinor: setOptionalString(event.target.value) })
                }
              />
            </div>
          ) : null}
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => remove(index)}
          >
            Retirer ce palier
          </button>
        </div>
      ))}
      <button type="button" className="et-button et-button--secondary" onClick={add}>
        Ajouter un palier
      </button>
    </fieldset>
  );
}

function OptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: CargoPricingOptionInput[];
  onChange: (options: CargoPricingOptionInput[]) => void;
  disabled: boolean;
}) {
  const byKind = useMemo(() => new Map(options.map((option) => [option.kind, option])), [options]);
  const toggle = (kind: CargoPricingOptionKind, checked: boolean) => {
    if (!checked) {
      onChange(options.filter((option) => option.kind !== kind));
      return;
    }
    onChange([...options, { kind, mode: 'INCLUDED', amountMinor: null }]);
  };
  const update = (kind: CargoPricingOptionKind, patch: Partial<CargoPricingOptionInput>) =>
    onChange(options.map((option) => (option.kind === kind ? { ...option, ...patch } : option)));

  return (
    <fieldset className="et-form" disabled={disabled}>
      <legend>Options</legend>
      {OPTIONS.map((kind) => {
        const option = byKind.get(kind);
        return (
          <div className="et-network-panel" key={kind}>
            <label>
              <input
                type="checkbox"
                checked={Boolean(option)}
                onChange={(event) => toggle(kind, event.target.checked)}
              />{' '}
              {OPTION_LABELS[kind]}
            </label>
            {option ? (
              <>
                <div className="et-field">
                  <label>Traitement</label>
                  <select
                    className="et-select"
                    value={option.mode}
                    onChange={(event) =>
                      update(kind, {
                        mode: event.target.value as CargoPricingOptionInput['mode'],
                        amountMinor: event.target.value === 'FLAT_RATE' ? option.amountMinor : null,
                      })
                    }
                  >
                    <option value="INCLUDED">Inclus</option>
                    <option value="FLAT_RATE">Forfait</option>
                    <option value="CUSTOM_QUOTE">Devis personnalisé</option>
                  </select>
                </div>
                {option.mode === 'FLAT_RATE' ? (
                  <div className="et-field">
                    <label>Montant (unités mineures)</label>
                    <input
                      className="et-input"
                      value={option.amountMinor ?? ''}
                      onChange={(event) =>
                        update(kind, { amountMinor: setOptionalString(event.target.value) })
                      }
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

function VersionEditor({
  rule,
  draft,
  run,
  busy,
  onReload,
}: {
  rule: CargoPricingRule;
  draft: CargoPricingVersion;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const methodId = useId();
  const roundingId = useId();
  const minorId = useId();
  const [value, setValue] = useState<CargoPricingVersionInput>(() => versionInput(draft));

  useEffect(() => setValue(versionInput(draft)), [draft]);

  const patch = (next: Partial<CargoPricingVersionInput>) =>
    setValue((current) => ({ ...current, ...next }));
  const selectMethod = (method: CargoPricingMethod) => {
    const next = { ...value, method };
    next.unitPriceMinor = null;
    next.flatPriceMinor = null;
    next.volumetricDivisorCm3PerKg = null;
    next.tiers = method === 'TIERED_WEIGHT' ? value.tiers : [];
    next.roundingMode = ['ACTUAL_WEIGHT', 'VOLUMETRIC_WEIGHT', 'VOLUME', 'TIERED_WEIGHT'].includes(
      method,
    )
      ? (value.roundingMode ?? 'UP')
      : null;
    next.minimumChargeMinor = method === 'CUSTOM_QUOTE' ? null : value.minimumChargeMinor;
    if (method === 'VOLUMETRIC_WEIGHT')
      next.volumetricDivisorCm3PerKg = value.volumetricDivisorCm3PerKg;
    setValue(next);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      () => auth.admin.pricing.updateCargoVersion(rule.id, draft.id, value),
      `Version ${draft.version} de ${rule.code} enregistrée.`,
    );
    if (ok) await onReload();
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label={`Configurer la version ${draft.version} de ${rule.code}`}
      onSubmit={save}
    >
      <h4>Configurer le brouillon v{draft.version}</h4>
      <div className="et-field">
        <label htmlFor={methodId}>Méthode</label>
        <select
          id={methodId}
          className="et-select"
          value={value.method}
          onChange={(event) => selectMethod(event.target.value as CargoPricingMethod)}
        >
          {Object.entries(METHOD_LABELS).map(([method, label]) => (
            <option key={method} value={method}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Devise"
        name="cargoCurrency"
        value={value.currencyCode}
        onChange={(currencyCode) => patch({ currencyCode: currencyCode.toUpperCase() })}
        maxLength={3}
        autoComplete="off"
      />
      <div className="et-field">
        <label htmlFor={minorId}>Décimales devise</label>
        <select
          id={minorId}
          className="et-select"
          value={String(value.currencyMinorUnit)}
          onChange={(event) => patch({ currencyMinorUnit: Number(event.target.value) })}
        >
          {[0, 1, 2, 3].map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </div>
      {value.roundingMode ? (
        <div className="et-field">
          <label htmlFor={roundingId}>Arrondi</label>
          <select
            id={roundingId}
            className="et-select"
            value={value.roundingMode}
            onChange={(event) => patch({ roundingMode: event.target.value as Rounding })}
          >
            <option value="UP">Supérieur</option>
            <option value="HALF_UP">Au plus proche</option>
            <option value="DOWN">Inférieur</option>
          </select>
        </div>
      ) : null}
      {['ACTUAL_WEIGHT', 'VOLUMETRIC_WEIGHT', 'VOLUME'].includes(value.method) ? (
        <TextField
          label="Prix unitaire (unités mineures)"
          name="cargoUnitPrice"
          value={value.unitPriceMinor ?? ''}
          onChange={(unitPriceMinor) =>
            patch({ unitPriceMinor: setOptionalString(unitPriceMinor) })
          }
          autoComplete="off"
        />
      ) : null}
      {value.method === 'FLAT_RATE' ? (
        <TextField
          label="Forfait (unités mineures)"
          name="cargoFlatPrice"
          value={value.flatPriceMinor ?? ''}
          onChange={(flatPriceMinor) =>
            patch({ flatPriceMinor: setOptionalString(flatPriceMinor) })
          }
          autoComplete="off"
        />
      ) : null}
      {value.method !== 'CUSTOM_QUOTE' ? (
        <TextField
          label="Minimum de facturation (unités mineures)"
          name="cargoMinimum"
          value={value.minimumChargeMinor ?? ''}
          onChange={(minimumChargeMinor) =>
            patch({ minimumChargeMinor: setOptionalString(minimumChargeMinor) })
          }
          autoComplete="off"
        />
      ) : null}
      {value.method === 'VOLUMETRIC_WEIGHT' || value.method === 'TIERED_WEIGHT' ? (
        <div className="et-field">
          <label>Diviseur volumétrique cm³/kg</label>
          <input
            className="et-input"
            type="number"
            min={1}
            value={value.volumetricDivisorCm3PerKg ?? ''}
            onChange={(event) =>
              patch({
                volumetricDivisorCm3PerKg: event.target.value ? Number(event.target.value) : null,
              })
            }
          />
        </div>
      ) : null}
      <TextField
        label="Devis au-delà du poids (kg)"
        name="cargoQuoteWeight"
        value={value.quoteAboveWeightKg ?? ''}
        onChange={(quoteAboveWeightKg) =>
          patch({ quoteAboveWeightKg: setOptionalString(quoteAboveWeightKg) })
        }
        autoComplete="off"
      />
      <div className="et-field">
        <label>Devis au-delà du volume (litres)</label>
        <input
          className="et-input"
          type="number"
          min={1}
          value={value.quoteAboveVolumeLiters ?? ''}
          onChange={(event) =>
            patch({
              quoteAboveVolumeLiters: event.target.value ? Number(event.target.value) : null,
            })
          }
        />
      </div>
      <TextField
        label="Date d’effet (ISO)"
        name="cargoEffectiveFrom"
        value={value.effectiveFrom}
        onChange={(effectiveFrom) => patch({ effectiveFrom })}
        autoComplete="off"
      />
      <TextField
        label="Date de fin (ISO, optionnelle)"
        name="cargoEffectiveTo"
        value={value.effectiveTo ?? ''}
        onChange={(effectiveTo) => patch({ effectiveTo: setOptionalString(effectiveTo) })}
        autoComplete="off"
      />

      <fieldset>
        <legend>Catégories tarifées</legend>
        <div className="et-actions">
          {CATEGORIES.map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                checked={value.categories.includes(category)}
                onChange={(event) =>
                  patch({
                    categories: event.target.checked
                      ? [...value.categories, category]
                      : value.categories.filter((candidate) => candidate !== category),
                  })
                }
              />{' '}
              {CATEGORY_LABELS[category]}
            </label>
          ))}
        </div>
      </fieldset>

      {value.method === 'TIERED_WEIGHT' ? (
        <TierEditor tiers={value.tiers} onChange={(tiers) => patch({ tiers })} disabled={busy} />
      ) : null}
      <OptionsEditor
        options={value.options}
        onChange={(options) => patch({ options })}
        disabled={busy}
      />

      <button type="submit" className="et-button" disabled={busy || value.categories.length === 0}>
        Enregistrer le brouillon
      </button>
    </form>
  );
}

function PreviewForm({
  rule,
  version,
  run,
  busy,
}: {
  rule: CargoPricingRule;
  version: CargoPricingVersion;
  run: Run;
  busy: boolean;
}) {
  const categoryId = useId();
  const [direction, setDirection] = useState<RoadFreightDirection>(rule.direction);
  const [weight, setWeight] = useState('10.000');
  const [category, setCategory] = useState<CargoPricingCategory>(
    version.categories[0] ?? 'STANDARD_PARCEL',
  );
  const [result, setResult] = useState<CargoEstimateResult | null>(null);
  const input: CargoEstimateInput = {
    from: direction === 'PAR_DKR' ? 'PAR' : 'DKR',
    to: direction === 'PAR_DKR' ? 'DKR' : 'PAR',
    weightKg: weight,
    category,
    pickup: false,
    delivery: false,
    fragile: false,
  };

  useEffect(() => setDirection(rule.direction), [rule.direction]);
  useEffect(() => setCategory(version.categories[0] ?? 'STANDARD_PARCEL'), [version]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    await run(async () => {
      const response = await auth.admin.pricing.previewCargoVersion(rule.id, version.id, input);
      if (response.ok) setResult(response.data);
      return response;
    }, 'Aperçu calculé.');
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label={`Prévisualiser la version ${version.version} de ${rule.code}`}
      onSubmit={submit}
    >
      <h4>Prévisualisation</h4>
      <p className="et-hint">
        La prévisualisation ne crée ni devis, ni expédition, ni réservation.
      </p>
      <div className="et-field">
        <label>Direction</label>
        <select
          className="et-select"
          value={direction}
          onChange={(event) => setDirection(event.target.value as RoadFreightDirection)}
        >
          {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <TextField
        label="Poids test (kg)"
        name="cargoPreviewWeight"
        value={weight}
        onChange={setWeight}
        autoComplete="off"
      />
      <div className="et-field">
        <label htmlFor={categoryId}>Catégorie test</label>
        <select
          id={categoryId}
          className="et-select"
          value={category}
          onChange={(event) => setCategory(event.target.value as CargoPricingCategory)}
        >
          {CATEGORIES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {CATEGORY_LABELS[candidate]}
            </option>
          ))}
        </select>
      </div>
      <button className="et-button et-button--secondary" type="submit" disabled={busy}>
        Prévisualiser
      </button>
      {result ? (
        <dl data-testid="cargo-pricing-preview">
          <dt>Résultat</dt>
          <dd>{result.requiresQuote ? 'Devis requis' : 'Tarif automatique'}</dd>
          <dt>Motif</dt>
          <dd>{result.quoteReason ?? '—'}</dd>
          <dt>Total</dt>
          <dd>
            {result.totalMinor ?? '—'} {result.currencyCode ?? ''}
          </dd>
          <dt>Version</dt>
          <dd>{result.pricingVersion ?? '—'}</dd>
        </dl>
      ) : null}
    </form>
  );
}

function CargoRuleDetail({
  rule,
  canManage,
  run,
  busy,
  onReload,
}: {
  rule: CargoPricingRule;
  canManage: boolean;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const [name, setName] = useState(rule.name);
  const draft = rule.versions.find((version) => version.status === 'DRAFT');
  const active = rule.versions.find((version) => version.status === 'ACTIVE');

  useEffect(() => setName(rule.name), [rule.name]);

  const createDraft = async () => {
    const ok = await run(
      () => auth.admin.pricing.createCargoVersion(rule.id, defaultVersion()),
      `Brouillon fret créé pour ${rule.code}.`,
    );
    if (ok) await onReload();
  };
  const duplicate = async (version: CargoPricingVersion) => {
    const ok = await run(
      () => auth.admin.pricing.createCargoVersion(rule.id, { sourceVersionId: version.id }),
      `Version ${version.version} dupliquée en brouillon.`,
    );
    if (ok) await onReload();
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(
      () => auth.admin.pricing.updateCargoRule(rule.id, name),
      `Règle ${rule.code} renommée.`,
    );
    if (ok) await onReload();
  };
  const activate = async (event: FormEvent, version: CargoPricingVersion) => {
    event.preventDefault();
    const ok = await run(
      () => auth.admin.pricing.activateCargoVersion(rule.id, version.id),
      `Version ${version.version} de ${rule.code} activée.`,
    );
    if (ok) await onReload();
  };
  const disable = async (event: FormEvent, version: CargoPricingVersion) => {
    event.preventDefault();
    const ok = await run(
      () => auth.admin.pricing.disableCargoVersion(rule.id, version.id),
      `Version ${version.version} de ${rule.code} désactivée.`,
    );
    if (ok) await onReload();
  };

  return (
    <section className="et-network-panel" aria-labelledby="cargo-rule-detail-title">
      <h3 id="cargo-rule-detail-title">
        Règle fret {rule.code} — {rule.name}
      </h3>
      <dl data-testid="cargo-rule-detail">
        <dt>Direction</dt>
        <dd>{DIRECTION_LABELS[rule.direction]}</dd>
        <dt>Audience</dt>
        <dd>{AUDIENCE_LABELS[rule.audience]}</dd>
        <dt>Version active</dt>
        <dd>
          {active
            ? `v${active.version} — ${METHOD_LABELS[active.method]}`
            : 'Aucune — estimation publique en devis requis'}
        </dd>
      </dl>

      {canManage ? (
        <form
          className="et-form et-network-form"
          aria-label={`Renommer la règle ${rule.code}`}
          onSubmit={rename}
        >
          <TextField
            label="Nom de la règle"
            name="cargoRuleRename"
            value={name}
            onChange={setName}
            maxLength={160}
            autoComplete="off"
          />
          <button
            className="et-button et-button--secondary"
            type="submit"
            disabled={busy || !name.trim()}
          >
            Enregistrer le nom
          </button>
        </form>
      ) : null}

      <h4>Versions</h4>
      <ol className="et-network-versions" aria-label={`Versions fret de ${rule.code}`}>
        {rule.versions.map((version) => (
          <li key={version.id}>
            <strong>v{version.version}</strong>{' '}
            <span className="et-tag">{STATUS_LABELS[version.status]}</span> —{' '}
            {METHOD_LABELS[version.method]} — effet{' '}
            {new Date(version.effectiveFrom).toLocaleString('fr-FR')}
            {version.status !== 'DRAFT' && canManage && !draft ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy}
                onClick={() => void duplicate(version)}
              >
                Dupliquer v{version.version}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {rule.versions.length === 0 ? <p>Aucune version.</p> : null}

      {canManage && !draft ? (
        <button
          type="button"
          className="et-button"
          disabled={busy}
          onClick={() => void createDraft()}
        >
          Créer un brouillon fail-closed
        </button>
      ) : null}

      {draft && canManage ? (
        <>
          <VersionEditor rule={rule} draft={draft} run={run} busy={busy} onReload={onReload} />
          <PreviewForm rule={rule} version={draft} run={run} busy={busy} />
          <form onSubmit={(event) => void activate(event, draft)}>
            <OpsConfirmSubmit
              actionLabel={`Activer la version ${draft.version}`}
              confirmLabel="Confirmer l’activation"
              title="Activer cette grille fret ?"
              description="Cette version deviendra l’autorité tarifaire active de cette règle. Vérifiez la prévisualisation et les données commerciales avant de confirmer."
              disabled={busy}
            />
          </form>
        </>
      ) : null}

      {active ? (
        <>
          <PreviewForm rule={rule} version={active} run={run} busy={busy} />
          {canManage ? (
            <form onSubmit={(event) => void disable(event, active)}>
              <OpsConfirmSubmit
                actionLabel={`Désactiver la version ${active.version}`}
                confirmLabel="Confirmer la désactivation"
                title="Désactiver cette grille fret ?"
                description="Sans autre règle active applicable, les estimations publiques repasseront automatiquement en devis requis."
                disabled={busy}
              />
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function CargoPricingAdmin() {
  const canManage = useCan('pricing.manage');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [items, setItems] = useState<CargoPricingRule[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [direction, setDirection] = useState<RoadFreightDirection | ''>('');
  const [audience, setAudience] = useState<Audience | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CargoPricingRule | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.pricing.cargoRules({
        ...(cursor ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(audience ? { audience } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [audience, direction, setError],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      const result = await auth.admin.pricing.cargoRule(id);
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

  if (!items) return <p role="status">Chargement des règles tarifaires fret…</p>;

  return (
    <section
      className="et-network"
      data-testid="cargo-pricing-workspace"
      aria-labelledby="cargo-pricing-title"
    >
      <h2 id="cargo-pricing-title">Colis & fret</h2>
      <p>
        Les règles fret sont versionnées et indépendantes des billets voyageurs et des devis
        manuels. En l’absence d’une règle active applicable, le calculateur reste volontairement en{' '}
        <strong>devis requis</strong>.
      </p>
      {feedback}

      {canManage ? (
        <CreateCargoRuleForm
          run={run}
          busy={busy}
          onCreated={(id) => {
            void load().then(() => setSelectedId(id));
          }}
        />
      ) : null}

      <div className="et-actions" aria-label="Filtres des règles fret">
        <label>
          Direction{' '}
          <select
            className="et-select"
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as RoadFreightDirection | '');
              setSelectedId(null);
            }}
          >
            <option value="">Toutes</option>
            {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Audience{' '}
          <select
            className="et-select"
            value={audience}
            onChange={(event) => {
              setAudience(event.target.value as Audience | '');
              setSelectedId(null);
            }}
          >
            <option value="">Toutes</option>
            {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="et-table-wrap">
        <table className="et-table">
          <caption>Règles tarifaires colis & fret</caption>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Direction</th>
              <th scope="col">Audience</th>
              <th scope="col">Active</th>
              <th scope="col">Fiche</th>
            </tr>
          </thead>
          <tbody>
            {items.map((rule) => {
              const active = rule.versions.find((version) => version.status === 'ACTIVE');
              return (
                <tr key={rule.id}>
                  <th scope="row">
                    <span className="et-tag">{rule.code}</span> {rule.name}
                  </th>
                  <td>{DIRECTION_LABELS[rule.direction]}</td>
                  <td>{AUDIENCE_LABELS[rule.audience]}</td>
                  <td>{active ? `v${active.version}` : 'Aucune'}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Consulter la règle fret ${rule.code}`}
                      onClick={() => setSelectedId(rule.id)}
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
      {items.length === 0 ? <p>Aucune règle fret. Aucun prix automatique n’est publié.</p> : null}
      {nextCursor ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load(nextCursor)}
        >
          Afficher plus
        </button>
      ) : null}

      {selectedId && !detail ? <p role="status">Chargement de la règle fret…</p> : null}
      {detail ? (
        <CargoRuleDetail
          rule={detail}
          canManage={canManage}
          run={run}
          busy={busy}
          onReload={reload}
        />
      ) : null}
    </section>
  );
}
