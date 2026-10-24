'use client';

import {
  createAuthClient,
  type CargoEstimateInput,
  type CargoEstimateResult,
  type CargoPricingCategory,
} from '@euroteranga/auth-client';
import { FormEvent, useMemo, useState } from 'react';
import styles from './cargo-pricing-calculator.module.css';

const categories: Array<{ value: CargoPricingCategory; label: string }> = [
  { value: 'STANDARD_PARCEL', label: 'Colis standard' },
  { value: 'PERSONAL_ITEMS', label: 'Effets personnels' },
  { value: 'CLOTHING', label: 'Vêtements' },
  { value: 'DOCUMENTS', label: 'Documents' },
  { value: 'ALLOWED_FOOD', label: 'Alimentation autorisée' },
  { value: 'EQUIPMENT', label: 'Matériel' },
  { value: 'PROFESSIONAL_GOODS', label: 'Marchandise professionnelle' },
  { value: 'UNACCOMPANIED_BAGGAGE', label: 'Bagage non accompagné' },
  { value: 'ACCOMPANIED_PARCEL', label: 'Colis accompagné' },
  { value: 'SPECIAL_HANDLING', label: 'Traitement particulier' },
  { value: 'OTHER', label: 'Autre' },
];

function decimalMinor(amountMinor: string, minorUnit: number): string {
  const value = BigInt(amountMinor);
  const factor = 10n ** BigInt(minorUnit);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(minorUnit, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return minorUnit > 0 ? `${grouped},${fraction}` : grouped;
}

function money(amountMinor: string, currencyCode: string, minorUnit: number): string {
  return `${decimalMinor(amountMinor, minorUnit)} ${currencyCode}`;
}

function categoryLabel(value: CargoPricingCategory): string {
  return categories.find((item) => item.value === value)?.label ?? value;
}

function quoteReasonLabel(result: CargoEstimateResult): string {
  switch (result.quoteReason) {
    case 'THRESHOLD_EXCEEDED':
      return 'Les caractéristiques de cet envoi nécessitent une étude personnalisée.';
    case 'VOLUME_REQUIRED':
      return 'Les dimensions ou le volume sont nécessaires pour confirmer ce tarif.';
    case 'CUSTOM_QUOTE':
    case 'OPTION_REQUIRES_QUOTE':
      return 'Cet envoi ou l’une de ses options doit être validé par notre équipe.';
    case 'NO_MATCHING_TIER':
    case 'NO_ACTIVE_RULE':
    case 'AMBIGUOUS_RULE':
    case 'OPTION_NOT_CONFIGURED':
    case 'INCOMPLETE_RULE':
    default:
      return 'Aucun tarif automatique ne peut être confirmé pour cet envoi.';
  }
}

function lineLabel(code: string): string {
  const labels: Record<string, string> = {
    BASE: 'Transport',
    MINIMUM_CHARGE: 'Minimum de facturation',
    PICKUP: 'Enlèvement',
    DELIVERY: 'Livraison',
    FRAGILE_HANDLING: 'Traitement fragile',
    PROFESSIONAL_HANDLING: 'Traitement professionnel',
    INSURANCE: 'Assurance',
  };
  return labels[code] ?? code;
}

export function CargoPricingCalculator({
  apiBaseUrl,
  quoteEmail,
}: {
  apiBaseUrl: string;
  quoteEmail?: string | null;
}) {
  const client = useMemo(() => createAuthClient(apiBaseUrl), [apiBaseUrl]);
  const [from, setFrom] = useState<'PAR' | 'DKR'>('PAR');
  const [weightKg, setWeightKg] = useState('');
  const [lengthCm, setLengthCm] = useState('');
  const [widthCm, setWidthCm] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [category, setCategory] = useState<CargoPricingCategory>('STANDARD_PARCEL');
  const [pickup, setPickup] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [fragile, setFragile] = useState(false);
  const [result, setResult] = useState<CargoEstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const to = from === 'PAR' ? 'DKR' : 'PAR';
  const directionLabel = from === 'PAR' ? 'Paris → Dakar' : 'Dakar → Paris';

  function quoteHref(current: CargoEstimateResult): string {
    if (!quoteEmail) return '#questions';
    const details = [
      'Bonjour,',
      '',
      'Je souhaite recevoir un devis EURO TERANGA pour cet envoi :',
      `Direction : ${directionLabel}`,
      `Poids : ${current.actualWeightKg} kg`,
      current.volumeM3 ? `Volume : ${current.volumeM3} m³` : null,
      `Catégorie : ${categoryLabel(current.category)}`,
      `Enlèvement : ${pickup ? 'oui' : 'non'}`,
      `Livraison : ${delivery ? 'oui' : 'non'}`,
      `Fragile : ${fragile ? 'oui' : 'non'}`,
      '',
      'Merci de me confirmer le tarif et les modalités de prise en charge.',
    ].filter((line): line is string => line !== null);
    return `mailto:${quoteEmail}?subject=${encodeURIComponent(
      `Demande de devis fret ${directionLabel}`,
    )}&body=${encodeURIComponent(details.join('\n'))}`;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);

    const dimensionValues = [lengthCm, widthCm, heightCm];
    const hasAnyDimension = dimensionValues.some(Boolean);
    const hasAllDimensions = dimensionValues.every(Boolean);
    if (hasAnyDimension && !hasAllDimensions) {
      setError('Renseignez les trois dimensions, ou laissez-les toutes vides.');
      return;
    }
    if (!weightKg.trim()) {
      setError('Renseignez le poids de votre envoi.');
      return;
    }

    const input: CargoEstimateInput = {
      from,
      to,
      weightKg: weightKg.trim().replace(',', '.'),
      category,
      pickup,
      delivery,
      fragile,
      ...(hasAllDimensions
        ? {
            dimensions: {
              lengthCm: Number(lengthCm),
              widthCm: Number(widthCm),
              heightCm: Number(heightCm),
            },
          }
        : {}),
    };

    setLoading(true);
    const response = await client.cargoPricing.estimate(input);
    setLoading(false);
    if (!response.ok) {
      setError(response.error.message);
      return;
    }
    setResult(response.data);
  }

  return (
    <section className={styles.section} aria-labelledby="cargo-pricing-title">
      <div className={styles.inner}>
        <div className={styles.heading}>
          <p className={styles.kicker}>Colis & fret</p>
          <h2 id="cargo-pricing-title">Calculez le prix de votre envoi</h2>
          <p>
            Indiquez les caractéristiques de votre colis. Si une grille tarifaire active correspond,
            le prix est calculé par EURO TERANGA. Sinon, nous vous orientons vers un devis.
          </p>
        </div>

        <form className={styles.form} onSubmit={submit} noValidate>
          <fieldset className={styles.fieldset}>
            <legend>1. Direction</legend>
            <div className={styles.segmented}>
              <label>
                <input
                  type="radio"
                  name="cargo-direction"
                  value="PAR_DKR"
                  checked={from === 'PAR'}
                  onChange={() => setFrom('PAR')}
                />
                <span>Paris → Dakar</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="cargo-direction"
                  value="DKR_PAR"
                  checked={from === 'DKR'}
                  onChange={() => setFrom('DKR')}
                />
                <span>Dakar → Paris</span>
              </label>
            </div>
          </fieldset>

          <fieldset className={styles.fieldset}>
            <legend>2. Votre envoi</legend>
            <div className={styles.grid}>
              <label>
                <span>Poids</span>
                <div className={styles.unitField}>
                  <input
                    name="weightKg"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="25"
                    value={weightKg}
                    onChange={(event) => setWeightKg(event.target.value)}
                    aria-describedby="cargo-weight-help"
                    required
                  />
                  <span>kg</span>
                </div>
                <small id="cargo-weight-help">Jusqu’à 3 décimales.</small>
              </label>

              <label>
                <span>Type d’envoi</span>
                <select
                  name="category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value as CargoPricingCategory)}
                >
                  {categories.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={styles.dimensions}>
              <span>Dimensions en cm <small>(facultatif)</small></span>
              <div className={styles.dimensionGrid}>
                {[
                  ['Longueur', lengthCm, setLengthCm, 'lengthCm'],
                  ['Largeur', widthCm, setWidthCm, 'widthCm'],
                  ['Hauteur', heightCm, setHeightCm, 'heightCm'],
                ].map(([label, value, setter, name]) => (
                  <label key={String(name)}>
                    <span>{String(label)}</span>
                    <input
                      name={String(name)}
                      type="number"
                      min="1"
                      max="1000"
                      step="1"
                      value={String(value)}
                      onChange={(event) =>
                        (setter as React.Dispatch<React.SetStateAction<string>>)(event.target.value)
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          </fieldset>

          <fieldset className={styles.fieldset}>
            <legend>3. Services</legend>
            <div className={styles.options}>
              <label>
                <input type="checkbox" checked={pickup} onChange={(e) => setPickup(e.target.checked)} />
                <span>Enlèvement souhaité</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={delivery}
                  onChange={(e) => setDelivery(e.target.checked)}
                />
                <span>Livraison souhaitée</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={fragile}
                  onChange={(e) => setFragile(e.target.checked)}
                />
                <span>Envoi fragile</span>
              </label>
            </div>
          </fieldset>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          <button className={styles.submit} type="submit" disabled={loading}>
            {loading ? 'Calcul en cours…' : 'Calculer mon tarif'}
          </button>
        </form>

        <div className={styles.result} aria-live="polite" aria-atomic="true">
          {result ? (
            result.requiresQuote ? (
              <div className={styles.quote}>
                <p className={styles.resultEyebrow}>Votre envoi</p>
                <h3>Devis personnalisé nécessaire</h3>
                <p>{quoteReasonLabel(result)}</p>
                <dl className={styles.summary}>
                  <div><dt>Direction</dt><dd>{directionLabel}</dd></div>
                  <div><dt>Poids</dt><dd>{result.actualWeightKg} kg</dd></div>
                  <div><dt>Catégorie</dt><dd>{categoryLabel(result.category)}</dd></div>
                </dl>
                <a className={styles.quoteButton} href={quoteHref(result)}>
                  Demander un devis
                </a>
              </div>
            ) : (
              <div className={styles.price}>
                <p className={styles.resultEyebrow}>Estimation calculée</p>
                <h3>
                  {result.totalMinor && result.currencyCode && result.currencyMinorUnit !== null
                    ? money(result.totalMinor, result.currencyCode, result.currencyMinorUnit)
                    : 'Tarif indisponible'}
                </h3>
                <p>{directionLabel} · {result.actualWeightKg} kg</p>
                <dl className={styles.lines}>
                  {result.lines.map((line, index) => (
                    <div key={`${line.code}-${index}`}>
                      <dt>{lineLabel(line.code)}</dt>
                      <dd>
                        {result.currencyCode && result.currencyMinorUnit !== null
                          ? money(line.amountMinor, result.currencyCode, result.currencyMinorUnit)
                          : line.amountMinor}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className={styles.disclaimer}>
                  Tarif calculé selon la grille active. La nature réelle et les caractéristiques de
                  l’envoi restent soumises à validation lors de la prise en charge.
                </p>
              </div>
            )
          ) : (
            <p className={styles.placeholder}>
              Le résultat apparaîtra ici après calcul.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
