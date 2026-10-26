'use client';

import type {
  ComplianceRule,
  ComplianceRuleSummary,
  ComplianceRuleVersion,
  ComplianceRuleVersionInput,
  ComplianceRuleVersionStatus,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';

const STATUS_LABELS: Record<ComplianceRuleVersionStatus, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
};

/** Version lifecycle, kept visually separate from source verification. */
const STATUS_TONES: Record<ComplianceRuleVersionStatus, 'neutral' | 'info' | 'danger'> = {
  DRAFT: 'neutral',
  PUBLISHED: 'info',
  RETIRED: 'danger',
};

/** Outlined badge: a verified source is not a compliance conclusion. */
function SourceBadge({ verified }: { verified: boolean }) {
  return (
    <OpsStatusBadge tone={verified ? 'info' : 'warning'} className="ops-status-badge--outline">
      {verified ? 'Source vérifiée' : 'Source non vérifiée'}
    </OpsStatusBadge>
  );
}

const formatAt = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

const today = () => new Date().toISOString().slice(0, 10);

interface ContentState {
  definition: string;
  customerGuidance: string;
  effectiveFrom: string;
  effectiveTo: string;
  authority: string;
  title: string;
  url: string;
  reference: string;
}

const emptyContent = (): ContentState => ({
  definition: '',
  customerGuidance: '',
  effectiveFrom: today(),
  effectiveTo: '',
  authority: '',
  title: '',
  url: '',
  reference: '',
});

const fromVersion = (version: ComplianceRuleVersion): ContentState => ({
  definition: JSON.stringify(version.definition, null, 2),
  customerGuidance: version.customerGuidance,
  effectiveFrom: version.effectiveFrom,
  effectiveTo: version.effectiveTo ?? '',
  authority: version.source.authority ?? '',
  title: version.source.title ?? '',
  url: version.source.url ?? '',
  reference: version.source.reference ?? '',
});

/** Parses the text fields; the server validates the rule language again. */
function toInput(
  content: ContentState,
): { ok: true; input: ComplianceRuleVersionInput } | { ok: false; message: string } {
  let definition: unknown;
  try {
    definition = JSON.parse(content.definition);
  } catch {
    return { ok: false, message: 'La définition doit être un JSON valide.' };
  }
  const optional = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    ok: true,
    input: {
      definition,
      customerGuidance: content.customerGuidance,
      effectiveFrom: content.effectiveFrom,
      effectiveTo: optional(content.effectiveTo),
      source: {
        authority: optional(content.authority),
        title: optional(content.title),
        url: optional(content.url),
        reference: optional(content.reference),
      },
    },
  };
}

function ContentFields({
  content,
  onChange,
  idPrefix,
}: {
  content: ContentState;
  onChange: (next: ContentState) => void;
  idPrefix: string;
}) {
  const field = (key: keyof ContentState) => ({
    id: `${idPrefix}-${key}`,
    value: content[key],
    onChange: (event: { target: { value: string } }) =>
      onChange({ ...content, [key]: event.target.value }),
  });
  return (
    <div className="ops-compliance-fields">
      <fieldset className="ops-compliance-fieldset">
        <legend>Contenu de la règle</legend>
        <div className="et-field">
          <label htmlFor={`${idPrefix}-definition`}>Définition (langage de règle v1, JSON)</label>
          <textarea
            {...field('definition')}
            className="et-input ops-compliance-json-input"
            rows={8}
            spellCheck={false}
            required
          />
          <p className="ops-ground-form__hint">
            Le contrôle JSON local n’est qu’un premier filtre : le serveur revalide le langage de
            règle, et aucun de ces contrôles n’est une validation réglementaire.
          </p>
        </div>
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={`${idPrefix}-customerGuidance`}>Consigne affichée au client</label>
            <input {...field('customerGuidance')} className="et-input" maxLength={500} required />
          </div>
          <div className="et-field">
            <label htmlFor={`${idPrefix}-effectiveFrom`}>
              En vigueur à partir du (date de voyage)
            </label>
            <input {...field('effectiveFrom')} className="et-input" type="date" required />
          </div>
          <div className="et-field">
            <label htmlFor={`${idPrefix}-effectiveTo`}>
              En vigueur jusqu’au (inclus, facultatif)
            </label>
            <input {...field('effectiveTo')} className="et-input" type="date" />
          </div>
        </div>
      </fieldset>
      <fieldset className="ops-compliance-fieldset">
        <legend>Source officielle</legend>
        <div className="et-network-adders">
          <div className="et-field">
            <label htmlFor={`${idPrefix}-authority`}>Autorité source</label>
            <input {...field('authority')} className="et-input" maxLength={200} />
          </div>
          <div className="et-field">
            <label htmlFor={`${idPrefix}-title`}>Titre du texte source</label>
            <input {...field('title')} className="et-input" maxLength={300} />
          </div>
          <div className="et-field">
            <label htmlFor={`${idPrefix}-url`}>URL officielle (https)</label>
            <input {...field('url')} className="et-input" type="url" maxLength={2048} />
          </div>
          <div className="et-field">
            <label htmlFor={`${idPrefix}-reference`}>Référence officielle</label>
            <input {...field('reference')} className="et-input" maxLength={200} />
          </div>
        </div>
      </fieldset>
    </div>
  );
}

function VersionCard({
  rule,
  version,
  canManage,
  busy,
  run,
}: {
  rule: ComplianceRule;
  version: ComplianceRuleVersion;
  canManage: boolean;
  busy: boolean;
  run: (
    work: () => Promise<
      { ok: true; data: ComplianceRule } | { ok: false; error: { message: string } }
    >,
    success: string,
  ) => Promise<void>;
}) {
  const prefix = useId();
  const [content, setContent] = useState(() => fromVersion(version));
  const [checkedOn, setCheckedOn] = useState(today());
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => setContent(fromVersion(version)), [version]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = toInput(content);
    if (!parsed.ok) {
      setLocalError(parsed.message);
      return;
    }
    setLocalError(null);
    void run(
      () => auth.admin.compliance.updateVersion(rule.reference, version.version, parsed.input),
      `Brouillon v${version.version} enregistré : il doit être vérifié à nouveau.`,
    );
  };

  return (
    <article
      className="et-network-panel ops-compliance-version"
      data-testid={`compliance-rule-version-${version.version}`}
    >
      <div className="et-actions ops-ground-detail__header">
        <h3>Version {version.version}</h3>
        <div className="ops-ground-badges">
          <OpsStatusBadge tone={STATUS_TONES[version.status]}>
            {STATUS_LABELS[version.status]}
          </OpsStatusBadge>
          <SourceBadge verified={version.verification.status === 'VERIFIED'} />
        </div>
      </div>
      <dl className="ops-ground-facts">
        <div>
          <dt>En vigueur</dt>
          <dd>
            du {version.effectiveFrom}{' '}
            {version.effectiveTo ? `au ${version.effectiveTo} inclus` : 'sans date de fin'}
          </dd>
        </div>
        <div>
          <dt>Vérification</dt>
          <dd>
            {version.verification.status === 'VERIFIED'
              ? `par ${version.verification.verifiedBy ?? '—'}, source consultée le ${version.source.checkedOn ?? '—'}`
              : 'non vérifiée'}
          </dd>
        </div>
        {version.publishedAt ? (
          <div>
            <dt>Publication</dt>
            <dd>
              par {version.publishedBy ?? '—'} · {formatAt(version.publishedAt)}
            </dd>
          </div>
        ) : null}
        <div className="ops-ground-facts__wide">
          <dt>Source</dt>
          <dd>
            {version.source.authority ?? '—'} · {version.source.title ?? '—'}
            {version.source.url?.startsWith('https://') ? (
              <>
                {' '}
                ·{' '}
                <a href={version.source.url} target="_blank" rel="noopener noreferrer nofollow">
                  lien officiel
                </a>
              </>
            ) : null}
            {version.source.reference ? ` · ${version.source.reference}` : ''}
          </dd>
        </div>
        <div className="ops-ground-facts__wide">
          <dt>Consigne client</dt>
          <dd>{version.customerGuidance}</dd>
        </div>
        <div className="ops-ground-facts__wide">
          <dt>Empreinte SHA-256 de la définition</dt>
          <dd className="et-code">{version.definitionSha256}</dd>
        </div>
        {version.retiredAt ? (
          <div className="ops-ground-facts__wide">
            <dt>Retrait</dt>
            <dd>
              par {version.retiredBy ?? '—'} · {formatAt(version.retiredAt)} :{' '}
              {version.retirementReason}
            </dd>
          </div>
        ) : null}
      </dl>
      <details className="ops-compliance-json">
        <summary>Définition technique (JSON, langage v{version.languageVersion})</summary>
        <pre className="et-json et-code" aria-label={`Définition de la version ${version.version}`}>
          {JSON.stringify(version.definition, null, 2)}
        </pre>
      </details>
      <FormAlert message={localError} />

      {version.status === 'DRAFT' && canManage ? (
        <div className="ops-ground-forms">
          <form
            className="et-form ops-ground-form ops-ground-form--wide"
            onSubmit={save}
            aria-label={`Modifier le brouillon v${version.version}`}
          >
            <h4>Brouillon : modification</h4>
            <p className="ops-ground-form__hint">
              Toute modification annule la vérification précédente : la source devra être vérifiée à
              nouveau.
            </p>
            <ContentFields content={content} onChange={setContent} idPrefix={`${prefix}-edit`} />
            <button type="submit" className="et-button et-button--secondary" disabled={busy}>
              Enregistrer le brouillon
            </button>
          </form>
          <form
            className="et-form ops-ground-form"
            aria-label={`Vérifier la source v${version.version}`}
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  auth.admin.compliance.verifyVersion(rule.reference, version.version, {
                    definitionSha256: version.definitionSha256,
                    sourceCheckedOn: checkedOn,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  }),
                `Source de la version ${version.version} vérifiée.`,
              );
            }}
          >
            <h4>Vérification de la source officielle</h4>
            <div className="et-field">
              <label htmlFor={`${prefix}-checked`}>Source consultée le</label>
              <input
                id={`${prefix}-checked`}
                className="et-input"
                type="date"
                max={today()}
                value={checkedOn}
                onChange={(event) => setCheckedOn(event.target.value)}
                required
              />
            </div>
            <div className="et-field">
              <label htmlFor={`${prefix}-note`}>Note de vérification (facultative)</label>
              <input
                id={`${prefix}-note`}
                className="et-input"
                value={note}
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <button type="submit" className="et-button et-button--secondary" disabled={busy}>
              Marquer la source comme vérifiée
            </button>
          </form>
          <div className="ops-ground-form">
            <h4>Publication</h4>
            <p className="ops-ground-form__hint">
              Seul un brouillon vérifié et inchangé depuis sa vérification peut être publié.
            </p>
            <button
              type="button"
              className="et-button"
              disabled={busy || version.verification.status !== 'VERIFIED'}
              onClick={() =>
                void run(
                  () =>
                    auth.admin.compliance.publishVersion(
                      rule.reference,
                      version.version,
                      version.definitionSha256,
                    ),
                  `Version ${version.version} publiée.`,
                )
              }
            >
              Publier la version {version.version}
            </button>
          </div>
        </div>
      ) : null}

      {version.status === 'PUBLISHED' ? (
        <>
          <p className="ops-ground-guardrail">
            Version publiée : lecture seule. Toute correction passe par une nouvelle version.
          </p>
          {canManage ? (
            <form
              className="et-form ops-ground-form"
              aria-label={`Retirer la version ${version.version}`}
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () =>
                    auth.admin.compliance.retireVersion(
                      rule.reference,
                      version.version,
                      reason.trim(),
                    ),
                  `Version ${version.version} retirée.`,
                );
              }}
            >
              <h4>Retrait</h4>
              <p className="ops-ground-form__hint">
                Le retrait est motivé et conserve l’historique de la version.
              </p>
              <div className="et-field">
                <label htmlFor={`${prefix}-reason`}>Motif du retrait</label>
                <input
                  id={`${prefix}-reason`}
                  className="et-input"
                  value={reason}
                  minLength={10}
                  maxLength={500}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <button type="submit" className="et-button et-button--secondary" disabled={busy}>
                Retirer la version {version.version}
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

/**
 * Regulatory rule catalogue. CODE_IS_NOT_LEGAL_AUTHORITY: rules are entered
 * from official sources, verified, then published by authorized STAFF; the
 * software ships none. Drafting, verification, publication and retirement are
 * separate steps and a published version is never edited.
 */
export function ComplianceRulesAdmin() {
  const canManage = useCan('compliance.rule.manage');
  const [rules, setRules] = useState<ComplianceRuleSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ComplianceRule | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(emptyContent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    const result = await auth.admin.compliance.rules({ limit: 100 });
    if (result.ok) {
      setRules(result.data.items);
      setNextCursor(result.data.nextCursor);
    } else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (reference: string) => {
    setError(null);
    const result = await auth.admin.compliance.rule(reference);
    if (result.ok) setSelected(result.data);
    else setError(result.error.message);
  };

  const run = async (
    work: () => Promise<
      { ok: true; data: ComplianceRule } | { ok: false; error: { message: string } }
    >,
    success: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSelected(result.data);
      setNotice(success);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const parsed = toInput(content);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(async () => {
      const result = await auth.admin.compliance.createRule({ title, version: parsed.input });
      if (result.ok) {
        setTitle('');
        setContent(emptyContent());
      }
      return result;
    }, 'Règle créée en brouillon non vérifié.');
  };

  const hasDraft = selected?.versions.some((version) => version.status === 'DRAFT') ?? false;

  const versions = rules?.flatMap((rule) => rule.versions) ?? [];
  const draftCount = versions.filter((version) => version.status === 'DRAFT').length;
  const publishedCount = versions.filter((version) => version.status === 'PUBLISHED').length;
  const verifiedCount = versions.filter(
    (version) => version.verificationStatus === 'VERIFIED',
  ).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-compliance-workspace"
      data-testid="compliance-rules-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Référentiel réglementaire</p>
          <h2>Sources vérifiées, versions et publication</h2>
          <p>
            Chaque version suit le même cycle : brouillon, vérification de la source officielle,
            publication, puis retrait motivé si nécessaire. Une version publiée n’est jamais
            modifiée.
          </p>
        </div>
      </div>
      <div className="ops-ground-guardrail ops-ground-guardrail--strong">
        <p>
          <strong>Le code n’est pas une autorité juridique.</strong> Chaque règle provient d’une
          source officielle, est vérifiée puis publiée par une personne habilitée. Aucune règle
          réelle n’est fournie par le logiciel.
        </p>
        <p>
          Sans règle publiée et vérifiée, un dossier reste « à vérifier » : l’absence de règle
          applicable ne vaut jamais conformité.
        </p>
      </div>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {rules ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des règles chargées">
          <OpsKpiCard
            label="Règles chargées"
            value={rules.length}
            helper={
              nextCursor ? 'Éléments chargés · liste partielle' : 'Toutes les règles sont chargées'
            }
            icon="permit"
            tone="info"
          />
          <OpsKpiCard
            label="Versions brouillon"
            value={draftCount}
            helper="Modifiables, non exploitées"
            icon="document"
            tone="neutral"
          />
          <OpsKpiCard
            label="Versions publiées"
            value={publishedCount}
            helper="Lecture seule"
            icon="check"
            tone="info"
          />
          <OpsKpiCard
            label="Sources vérifiées"
            value={verifiedCount}
            helper="Versions dont la source a été vérifiée"
            icon="shield"
            tone="info"
          />
        </section>
      ) : null}
      {rules && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {rules.length} règles chargées.
        </p>
      ) : null}

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="compliance-rules-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Catalogue</p>
            <h2 id="compliance-rules-list-title">Règles</h2>
          </div>
        </div>
        {!rules && !error ? <OpsLoadingState title="Chargement des règles…" /> : null}
        {rules?.length === 0 ? (
          <OpsEmptyState
            title="Aucune règle enregistrée."
            description="Le logiciel ne fournit aucune règle : chacune est saisie à partir d’une source officielle."
          />
        ) : null}
        {rules && rules.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Règles réglementaires et versions</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Titre</th>
                  <th scope="col">Versions</th>
                  <th scope="col">Statuts</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr
                    key={rule.reference}
                    className={
                      selected?.reference === rule.reference ? 'ops-table-row--selected' : undefined
                    }
                  >
                    <th scope="row" className="et-code">
                      {rule.reference}
                    </th>
                    <td>{rule.title}</td>
                    <td>{rule.versions.length}</td>
                    <td>
                      <ul className="ops-compliance-version-list">
                        {rule.versions.map((version) => (
                          <li key={version.version}>
                            <span className="ops-compliance-version-label">v{version.version}</span>
                            <OpsStatusBadge tone={STATUS_TONES[version.status]}>
                              {STATUS_LABELS[version.status]}
                            </OpsStatusBadge>
                            <SourceBadge verified={version.verificationStatus === 'VERIFIED'} />
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-controls="compliance-rule-detail-panel"
                        aria-expanded={selected?.reference === rule.reference}
                        onClick={() => void open(rule.reference)}
                      >
                        Ouvrir {rule.reference}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selected ? (
        <OpsDetailRegion
          id="compliance-rule-detail-panel"
          focusKey={selected.reference}
          onClose={() => setSelected(null)}
        >
          <section
            className="et-network-panel ops-ground-detail"
            aria-labelledby="compliance-rule-detail-title"
            data-testid="compliance-rule-detail"
          >
            <div className="et-actions ops-ground-detail__header">
              <div>
                <p className="ops-operations-section-kicker">
                  Règle réglementaire · {selected.versions.length} version(s)
                </p>
                <h2 id="compliance-rule-detail-title">
                  {selected.title} · <span className="et-code">{selected.reference}</span>
                </h2>
              </div>
              {canManage && !hasDraft ? (
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => auth.admin.compliance.createVersion(selected.reference),
                      'Nouvelle version créée en brouillon (copie de la dernière).',
                    )
                  }
                >
                  Créer une nouvelle version
                </button>
              ) : null}
            </div>
            {selected.versions.map((version) => (
              <VersionCard
                key={`${selected.reference}-${version.version}-${version.updatedAt}`}
                rule={selected}
                version={version}
                canManage={canManage}
                busy={busy}
                run={run}
              />
            ))}
          </section>
        </OpsDetailRegion>
      ) : null}

      {canManage ? (
        <form
          className="et-form et-network-form ops-ground-panel"
          onSubmit={create}
          aria-label="Créer une règle"
        >
          <div>
            <p className="ops-operations-section-kicker">Saisie depuis une source officielle</p>
            <h2>Nouvelle règle (brouillon)</h2>
          </div>
          <div className="et-field">
            <label htmlFor={titleId}>Titre interne de la règle</label>
            <input
              id={titleId}
              className="et-input"
              value={title}
              minLength={3}
              maxLength={160}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <ContentFields content={content} onChange={setContent} idPrefix="new-rule" />
          <button type="submit" className="et-button" disabled={busy}>
            Créer le brouillon
          </button>
        </form>
      ) : null}
    </div>
  );
}
