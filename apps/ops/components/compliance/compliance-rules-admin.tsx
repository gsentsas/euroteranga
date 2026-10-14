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
import { useCan } from '../staff-access';

const STATUS_LABELS: Record<ComplianceRuleVersionStatus, string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
};

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
    <div className="et-form et-network-form">
      <label htmlFor={`${idPrefix}-definition`}>Définition (langage de règle v1, JSON)</label>
      <textarea {...field('definition')} rows={8} spellCheck={false} required />
      <label htmlFor={`${idPrefix}-customerGuidance`}>Consigne affichée au client</label>
      <input {...field('customerGuidance')} maxLength={500} required />
      <label htmlFor={`${idPrefix}-effectiveFrom`}>En vigueur à partir du (date de voyage)</label>
      <input {...field('effectiveFrom')} type="date" required />
      <label htmlFor={`${idPrefix}-effectiveTo`}>En vigueur jusqu’au (inclus, facultatif)</label>
      <input {...field('effectiveTo')} type="date" />
      <label htmlFor={`${idPrefix}-authority`}>Autorité source</label>
      <input {...field('authority')} maxLength={200} />
      <label htmlFor={`${idPrefix}-title`}>Titre du texte source</label>
      <input {...field('title')} maxLength={300} />
      <label htmlFor={`${idPrefix}-url`}>URL officielle (https)</label>
      <input {...field('url')} type="url" maxLength={2048} />
      <label htmlFor={`${idPrefix}-reference`}>Référence officielle</label>
      <input {...field('reference')} maxLength={200} />
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
      className="et-network-panel"
      data-testid={`compliance-rule-version-${version.version}`}
    >
      <div className="et-actions">
        <h3>Version {version.version}</h3>
        <span className="et-tag">{STATUS_LABELS[version.status]}</span>
        <span className="et-tag">
          {version.verification.status === 'VERIFIED' ? 'Source vérifiée' : 'Source non vérifiée'}
        </span>
      </div>
      <dl className="et-booking-admin-summary">
        <dt>En vigueur</dt>
        <dd>
          du {version.effectiveFrom}{' '}
          {version.effectiveTo ? `au ${version.effectiveTo} inclus` : 'sans date de fin'}
        </dd>
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
        <dt>Vérification</dt>
        <dd>
          {version.verification.status === 'VERIFIED'
            ? `par ${version.verification.verifiedBy ?? '—'}, source consultée le ${version.source.checkedOn ?? '—'}`
            : 'non vérifiée'}
        </dd>
        <dt>Consigne client</dt>
        <dd>{version.customerGuidance}</dd>
        <dt>Empreinte</dt>
        <dd className="et-code">{version.definitionSha256}</dd>
        {version.publishedAt ? (
          <>
            <dt>Publication</dt>
            <dd>par {version.publishedBy ?? '—'}</dd>
          </>
        ) : null}
        {version.retiredAt ? (
          <>
            <dt>Retrait</dt>
            <dd>
              par {version.retiredBy ?? '—'} : {version.retirementReason}
            </dd>
          </>
        ) : null}
      </dl>
      <pre className="et-json et-code" aria-label={`Définition de la version ${version.version}`}>
        {JSON.stringify(version.definition, null, 2)}
      </pre>
      <FormAlert message={localError} />

      {version.status === 'DRAFT' && canManage ? (
        <>
          <form onSubmit={save} aria-label={`Modifier le brouillon v${version.version}`}>
            <h4>Brouillon : modification</h4>
            <ContentFields content={content} onChange={setContent} idPrefix={`${prefix}-edit`} />
            <button type="submit" className="et-button et-button--secondary" disabled={busy}>
              Enregistrer le brouillon
            </button>
          </form>
          <form
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
            <label htmlFor={`${prefix}-checked`}>Source consultée le</label>
            <input
              id={`${prefix}-checked`}
              type="date"
              max={today()}
              value={checkedOn}
              onChange={(event) => setCheckedOn(event.target.value)}
              required
            />
            <label htmlFor={`${prefix}-note`}>Note de vérification (facultative)</label>
            <input
              id={`${prefix}-note`}
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
            />
            <button type="submit" className="et-button et-button--secondary" disabled={busy}>
              Marquer la source comme vérifiée
            </button>
          </form>
          <div>
            <h4>Publication</h4>
            <p>Seul un brouillon vérifié et inchangé depuis sa vérification peut être publié.</p>
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
        </>
      ) : null}

      {version.status === 'PUBLISHED' ? (
        <>
          <p>Version publiée : lecture seule. Toute correction passe par une nouvelle version.</p>
          {canManage ? (
            <form
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
              <label htmlFor={`${prefix}-reason`}>Motif du retrait</label>
              <input
                id={`${prefix}-reason`}
                value={reason}
                minLength={10}
                maxLength={500}
                required
                onChange={(event) => setReason(event.target.value)}
              />
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
  const [selected, setSelected] = useState<ComplianceRule | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(emptyContent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    const result = await auth.admin.compliance.rules({ limit: 100 });
    if (result.ok) setRules(result.data.items);
    else setError(result.error.message);
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

  return (
    <div className="et-network" data-testid="compliance-rules-workspace">
      <p>
        Le code n’est pas une autorité juridique : chaque règle provient d’une source officielle,
        est vérifiée puis publiée par une personne habilitée. Sans règle publiée et vérifiée, un
        dossier reste « à vérifier ». Aucune règle réelle n’est fournie par le logiciel.
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      <section aria-labelledby="compliance-rules-list-title">
        <h2 id="compliance-rules-list-title">Règles</h2>
        {!rules ? <p role="status">Chargement des règles…</p> : null}
        {rules?.length === 0 ? <p>Aucune règle enregistrée.</p> : null}
        {rules && rules.length > 0 ? (
          <div className="et-table-wrap">
            <table>
              <caption>Règles réglementaires et versions</caption>
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Titre</th>
                  <th>Versions</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.reference}>
                    <td className="et-code">{rule.reference}</td>
                    <td>{rule.title}</td>
                    <td>
                      {rule.versions
                        .map((version) => `v${version.version} ${STATUS_LABELS[version.status]}`)
                        .join(', ')}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
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
        <section
          aria-labelledby="compliance-rule-detail-title"
          data-testid="compliance-rule-detail"
        >
          <div className="et-actions">
            <h2 id="compliance-rule-detail-title">
              {selected.title} · <span className="et-code">{selected.reference}</span>
            </h2>
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
      ) : null}

      {canManage ? (
        <form onSubmit={create} aria-label="Créer une règle">
          <h2>Nouvelle règle (brouillon)</h2>
          <label htmlFor={titleId}>Titre interne de la règle</label>
          <input
            id={titleId}
            value={title}
            minLength={3}
            maxLength={160}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          <ContentFields content={content} onChange={setContent} idPrefix="new-rule" />
          <button type="submit" className="et-button" disabled={busy}>
            Créer le brouillon
          </button>
        </form>
      ) : null}
    </div>
  );
}
