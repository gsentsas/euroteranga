'use client';

import type {
  RegulatoryPermitDetail,
  RegulatoryPermitInput,
  RegulatoryPermitLifecycleStatus,
  RegulatoryPermitScope,
  RegulatoryPermitScopeInput,
  RegulatoryPermitSummary,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';

const STATUS_LABELS: Record<RegulatoryPermitLifecycleStatus, string> = {
  DRAFT: 'Brouillon',
  ACTIVE: 'Active',
  REVOKED: 'Révoquée',
};

const VALIDITY_LABELS = {
  DRAFT: 'Brouillon — non active',
  NOT_YET_VALID: 'Pas encore valide',
  VALID: 'Valide intrinsèquement',
  EXPIRED: 'Expirée',
  REVOKED: 'Révoquée',
} as const;

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Never 'success': an active, intrinsically valid permit is not a departure decision. */
const STATUS_TONES: Record<RegulatoryPermitLifecycleStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'info',
  REVOKED: 'danger',
};

const VALIDITY_TONES: Record<keyof typeof VALIDITY_LABELS, Tone> = {
  DRAFT: 'neutral',
  NOT_YET_VALID: 'warning',
  VALID: 'info',
  EXPIRED: 'danger',
  REVOKED: 'danger',
};

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

function scopeLabel(scope: RegulatoryPermitScope): string {
  switch (scope.type) {
    case 'OPERATOR':
      return scope.label;
    case 'COUNTRY':
      return `Pays ${scope.country.iso2} — ${scope.country.name}`;
    case 'VEHICLE':
      return `Véhicule ${scope.vehicle.code}`;
    case 'ROUTE_VERSION':
      return `Route ${scope.route.code}, version ${scope.routeVersion}`;
    case 'TRIP':
      return `Voyage ${scope.trip.reference}`;
  }
}

interface PermitFormValues {
  permitType: string;
  title: string;
  issuingAuthority: string;
  authorityReference: string;
  jurisdictionCountryIso2: string;
  scopeType: RegulatoryPermitScopeInput['type'];
  scopeCountryIso2: string;
  vehicleCode: string;
  routeCode: string;
  routeVersion: string;
  tripReference: string;
  validFrom: string;
  validUntil: string;
  sourceUrl: string;
  sourceCheckedOn: string;
  notes: string;
}

const EMPTY_FORM: PermitFormValues = {
  permitType: '',
  title: '',
  issuingAuthority: '',
  authorityReference: '',
  jurisdictionCountryIso2: '',
  scopeType: 'OPERATOR',
  scopeCountryIso2: '',
  vehicleCode: '',
  routeCode: '',
  routeVersion: '1',
  tripReference: '',
  validFrom: '',
  validUntil: '',
  sourceUrl: '',
  sourceCheckedOn: '',
  notes: '',
};

function scopeInput(values: PermitFormValues): RegulatoryPermitScopeInput {
  switch (values.scopeType) {
    case 'OPERATOR':
      return { type: 'OPERATOR' };
    case 'COUNTRY':
      return { type: 'COUNTRY', countryIso2: values.scopeCountryIso2 };
    case 'VEHICLE':
      return { type: 'VEHICLE', vehicleCode: values.vehicleCode };
    case 'ROUTE_VERSION':
      return {
        type: 'ROUTE_VERSION',
        routeCode: values.routeCode,
        routeVersion: Number(values.routeVersion),
      };
    case 'TRIP':
      return { type: 'TRIP', tripReference: values.tripReference };
  }
}

function permitInput(values: PermitFormValues): RegulatoryPermitInput {
  return {
    permitType: values.permitType,
    title: values.title,
    issuingAuthority: values.issuingAuthority,
    authorityReference: values.authorityReference || null,
    jurisdictionCountryIso2: values.jurisdictionCountryIso2 || null,
    scope: scopeInput(values),
    validFrom: values.validFrom,
    validUntil: values.validUntil,
    sourceUrl: values.sourceUrl || null,
    sourceCheckedOn: values.sourceCheckedOn || null,
    notes: values.notes || null,
  };
}

function scopeFormValues(scope: RegulatoryPermitScope): Partial<PermitFormValues> {
  switch (scope.type) {
    case 'OPERATOR':
      return { scopeType: 'OPERATOR' };
    case 'COUNTRY':
      return { scopeType: 'COUNTRY', scopeCountryIso2: scope.country.iso2 };
    case 'VEHICLE':
      return { scopeType: 'VEHICLE', vehicleCode: scope.vehicle.code };
    case 'ROUTE_VERSION':
      return {
        scopeType: 'ROUTE_VERSION',
        routeCode: scope.route.code,
        routeVersion: String(scope.routeVersion),
      };
    case 'TRIP':
      return { scopeType: 'TRIP', tripReference: scope.trip.reference };
  }
}

function ScopeFields({
  values,
  setValues,
}: {
  values: PermitFormValues;
  setValues: (next: PermitFormValues) => void;
}) {
  const set = (field: keyof PermitFormValues, value: string) =>
    setValues({ ...values, [field]: value });
  return (
    <>
      <div className="et-field">
        <label htmlFor="permit-scope-type">Périmètre</label>
        <select
          id="permit-scope-type"
          className="et-select"
          value={values.scopeType}
          onChange={(event) => set('scopeType', event.target.value)}
        >
          <option value="OPERATOR">Opérateur EURO TERANGA</option>
          <option value="COUNTRY">Pays</option>
          <option value="VEHICLE">Véhicule</option>
          <option value="ROUTE_VERSION">Version de route</option>
          <option value="TRIP">Voyage</option>
        </select>
      </div>
      {values.scopeType === 'COUNTRY' ? (
        <label className="et-field">
          Code ISO2 du pays de périmètre
          <input
            className="et-input"
            required
            maxLength={2}
            value={values.scopeCountryIso2}
            onChange={(event) => set('scopeCountryIso2', event.target.value)}
          />
        </label>
      ) : null}
      {values.scopeType === 'VEHICLE' ? (
        <label className="et-field">
          Code du véhicule
          <input
            className="et-input"
            required
            maxLength={32}
            value={values.vehicleCode}
            onChange={(event) => set('vehicleCode', event.target.value)}
          />
        </label>
      ) : null}
      {values.scopeType === 'ROUTE_VERSION' ? (
        <>
          <label className="et-field">
            Code de la route
            <input
              className="et-input"
              required
              maxLength={32}
              value={values.routeCode}
              onChange={(event) => set('routeCode', event.target.value)}
            />
          </label>
          <label className="et-field">
            Version de la route
            <input
              className="et-input"
              required
              type="number"
              min={1}
              value={values.routeVersion}
              onChange={(event) => set('routeVersion', event.target.value)}
            />
          </label>
        </>
      ) : null}
      {values.scopeType === 'TRIP' ? (
        <label className="et-field">
          Référence du voyage
          <input
            className="et-input"
            required
            maxLength={32}
            value={values.tripReference}
            onChange={(event) => set('tripReference', event.target.value)}
          />
        </label>
      ) : null}
    </>
  );
}

function PermitFields({
  values,
  setValues,
  includeScope = true,
}: {
  values: PermitFormValues;
  setValues: (next: PermitFormValues) => void;
  includeScope?: boolean;
}) {
  const set = (field: keyof PermitFormValues, value: string) =>
    setValues({ ...values, [field]: value });
  return (
    <div className="et-network-adders">
      <label className="et-field">
        Type de permis
        <input
          className="et-input"
          required
          maxLength={64}
          value={values.permitType}
          onChange={(event) => set('permitType', event.target.value)}
        />
      </label>
      <label className="et-field">
        Intitulé
        <input
          className="et-input"
          required
          minLength={3}
          maxLength={160}
          value={values.title}
          onChange={(event) => set('title', event.target.value)}
        />
      </label>
      <label className="et-field">
        Autorité émettrice
        <input
          className="et-input"
          required
          maxLength={200}
          value={values.issuingAuthority}
          onChange={(event) => set('issuingAuthority', event.target.value)}
        />
      </label>
      <label className="et-field">
        Référence de l’autorité (facultative)
        <input
          className="et-input"
          maxLength={200}
          value={values.authorityReference}
          onChange={(event) => set('authorityReference', event.target.value)}
        />
      </label>
      <label className="et-field">
        Pays de juridiction ISO2 (facultatif)
        <input
          className="et-input"
          maxLength={2}
          value={values.jurisdictionCountryIso2}
          onChange={(event) => set('jurisdictionCountryIso2', event.target.value)}
        />
      </label>
      {includeScope ? <ScopeFields values={values} setValues={setValues} /> : null}
      <label className="et-field">
        Valide du
        <input
          className="et-input"
          required
          type="date"
          value={values.validFrom}
          onChange={(event) => set('validFrom', event.target.value)}
        />
      </label>
      <label className="et-field">
        Valide jusqu’au
        <input
          className="et-input"
          required
          type="date"
          value={values.validUntil}
          onChange={(event) => set('validUntil', event.target.value)}
        />
      </label>
      <label className="et-field">
        Source HTTPS (facultative)
        <input
          className="et-input"
          type="url"
          maxLength={500}
          value={values.sourceUrl}
          onChange={(event) => set('sourceUrl', event.target.value)}
        />
      </label>
      <label className="et-field">
        Source vérifiée le (facultatif)
        <input
          className="et-input"
          type="date"
          value={values.sourceCheckedOn}
          onChange={(event) => set('sourceCheckedOn', event.target.value)}
        />
      </label>
      <label className="et-field">
        Notes internes (facultatives)
        <textarea
          className="et-input"
          rows={3}
          maxLength={1000}
          value={values.notes}
          onChange={(event) => set('notes', event.target.value)}
        />
      </label>
    </div>
  );
}

function CreatePermit({
  busy,
  onCreated,
  setError,
}: {
  busy: boolean;
  onCreated: (permit: RegulatoryPermitDetail) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [values, setValues] = useState(EMPTY_FORM);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || pending) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const result = await auth.admin.regulatoryPermits.create(permitInput(values));
      if (!result.ok) return setError(result.error.message);
      setValues(EMPTY_FORM);
      setNotice(`Autorisation ${result.data.reference} créée en brouillon.`);
      await onCreated(result.data);
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="et-form et-network-form ops-ground-panel"
      aria-label="Créer une autorisation réglementaire"
      onSubmit={submit}
    >
      <div>
        <p className="ops-operations-section-kicker">Saisie en brouillon</p>
        <h2>Créer une autorisation</h2>
      </div>
      <PermitFields values={values} setValues={setValues} />
      <button type="submit" className="et-button" disabled={busy || pending}>
        Créer le brouillon
      </button>
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}
    </form>
  );
}

function Detail({
  permit,
  canManage,
  busy,
  onChanged,
  setError,
}: {
  permit: RegulatoryPermitDetail;
  canManage: boolean;
  busy: boolean;
  onChanged: (permit: RegulatoryPermitDetail, notice: string) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [edit, setEdit] = useState<PermitFormValues>({
    ...EMPTY_FORM,
    ...scopeFormValues(permit.scope),
    permitType: permit.permitType,
    title: permit.title,
    issuingAuthority: permit.issuingAuthority,
    authorityReference: permit.authorityReference ?? '',
    jurisdictionCountryIso2: permit.jurisdictionCountry?.iso2 ?? '',
    validFrom: permit.validFrom,
    validUntil: permit.validUntil,
    sourceUrl: permit.sourceUrl ?? '',
    sourceCheckedOn: permit.sourceCheckedOn ?? '',
    notes: permit.notes ?? '',
  });
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const syncedRevision = useRef<string | null>(null);
  useEffect(() => {
    const revisionKey = `${permit.reference}:${permit.revision}`;
    if (syncedRevision.current === revisionKey) return;
    syncedRevision.current = revisionKey;
    setEdit((current) => ({
      ...current,
      ...scopeFormValues(permit.scope),
      permitType: permit.permitType,
      title: permit.title,
      issuingAuthority: permit.issuingAuthority,
      authorityReference: permit.authorityReference ?? '',
      jurisdictionCountryIso2: permit.jurisdictionCountry?.iso2 ?? '',
      validFrom: permit.validFrom,
      validUntil: permit.validUntil,
      sourceUrl: permit.sourceUrl ?? '',
      sourceCheckedOn: permit.sourceCheckedOn ?? '',
      notes: permit.notes ?? '',
    }));
    setReason('');
    setConfirmRevoke(false);
  }, [permit]);

  const update = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || pending) return;
    setError(null);
    const input = permitInput(edit);
    setPending(true);
    try {
      const result = await auth.admin.regulatoryPermits.update(permit.reference, {
        expectedRevision: permit.revision,
        permitType: input.permitType,
        title: input.title,
        issuingAuthority: input.issuingAuthority,
        authorityReference: input.authorityReference ?? null,
        jurisdictionCountryIso2: input.jurisdictionCountryIso2 ?? null,
        scope: input.scope,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        sourceUrl: input.sourceUrl ?? null,
        sourceCheckedOn: input.sourceCheckedOn ?? null,
        notes: input.notes ?? null,
      });
      if (!result.ok) return setError(result.error.message);
      await onChanged(result.data, `Autorisation ${permit.reference} modifiée.`);
    } finally {
      setPending(false);
    }
  };
  const activate = async () => {
    if (busy || pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await auth.admin.regulatoryPermits.activate(permit.reference, permit.revision);
      if (!result.ok) return setError(result.error.message);
      await onChanged(result.data, `Autorisation ${permit.reference} activée.`);
    } finally {
      setPending(false);
    }
  };
  const revoke = async () => {
    if (!confirmRevoke) return setConfirmRevoke(true);
    if (busy || pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await auth.admin.regulatoryPermits.revoke(permit.reference, {
        expectedRevision: permit.revision,
        reason,
      });
      if (!result.ok) return setError(result.error.message);
      await onChanged(result.data, `Autorisation ${permit.reference} révoquée.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="et-network-panel ops-ground-detail" aria-labelledby="permit-detail-title">
      <div className="et-actions ops-ground-detail__header">
        <div>
          <p className="ops-operations-section-kicker">
            Fiche autorisation · révision {permit.revision}
          </p>
          <h2 id="permit-detail-title">Autorisation {permit.reference}</h2>
        </div>
        <div className="ops-ground-badges">
          <OpsStatusBadge tone={STATUS_TONES[permit.status]}>
            {STATUS_LABELS[permit.status]}
          </OpsStatusBadge>
          <span data-testid="permit-validity">
            <OpsStatusBadge tone={VALIDITY_TONES[permit.validityState]}>
              {VALIDITY_LABELS[permit.validityState]}
            </OpsStatusBadge>
          </span>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Validité intrinsèque seulement : elle ne rend aucun voyage prêt et ne vaut pas autorisation
        de départ.
      </p>
      <dl className="ops-ground-facts" data-testid="permit-detail">
        <div>
          <dt>Type et intitulé</dt>
          <dd>
            {permit.permitType} — {permit.title}
          </dd>
        </div>
        <div>
          <dt>Autorité</dt>
          <dd>{permit.issuingAuthority}</dd>
        </div>
        <div>
          <dt>Référence de l’autorité</dt>
          <dd>{permit.authorityReference ?? '—'}</dd>
        </div>
        <div>
          <dt>Juridiction</dt>
          <dd>
            {permit.jurisdictionCountry
              ? `${permit.jurisdictionCountry.iso2} — ${permit.jurisdictionCountry.name}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Périmètre</dt>
          <dd>{scopeLabel(permit.scope)}</dd>
        </div>
        <div>
          <dt>Période inclusive</dt>
          <dd>
            {permit.validFrom} → {permit.validUntil}
          </dd>
        </div>
        <div>
          <dt>État évalué par le serveur le</dt>
          <dd>{permit.evaluatedOn}</dd>
        </div>
        <div>
          <dt>Révision</dt>
          <dd>{permit.revision}</dd>
        </div>
        <div className="ops-ground-facts__wide">
          <dt>Source</dt>
          <dd>{permit.sourceUrl ?? '—'}</dd>
        </div>
        <div className="ops-ground-facts__wide">
          <dt>Notes</dt>
          <dd>{permit.notes ?? '—'}</dd>
        </div>
        {permit.revocationReason ? (
          <div className="ops-ground-facts__wide">
            <dt>Motif de révocation</dt>
            <dd>{permit.revocationReason}</dd>
          </div>
        ) : null}
      </dl>
      <h3>Historique</h3>
      <ol
        className="ops-ground-history"
        aria-label={`Historique de l’autorisation ${permit.reference}`}
      >
        {permit.history.map((entry) => (
          <li key={`${entry.occurredAt}-${entry.revision ?? ''}`}>
            {dateTime.format(new Date(entry.occurredAt))} —{' '}
            <span className="et-code">{entry.action}</span>
            {entry.reason ? ` — ${entry.reason}` : ''}
          </li>
        ))}
      </ol>
      {canManage && permit.status === 'DRAFT' ? (
        <div className="ops-ground-forms">
          <form
            className="et-form ops-ground-form ops-ground-form--wide"
            aria-label={`Modifier l’autorisation ${permit.reference}`}
            onSubmit={update}
          >
            <h3>Modifier le brouillon</h3>
            <PermitFields values={edit} setValues={setEdit} />
            <button type="submit" className="et-button" disabled={busy || pending}>
              Enregistrer les modifications
            </button>
          </form>
          <div className="ops-ground-form ops-ground-form--wide">
            <p className="ops-operations-section-kicker">Activation</p>
            <p className="ops-ground-form__hint">
              L’activation fige le brouillon ; la validité reste évaluée par le serveur sur la
              période inclusive.
            </p>
            <button
              type="button"
              className="et-button"
              disabled={busy || pending}
              onClick={() => void activate()}
            >
              Activer l’autorisation
            </button>
          </div>
        </div>
      ) : null}
      {canManage && permit.status === 'ACTIVE' ? (
        <div
          className="et-form ops-ground-form"
          role="group"
          aria-label={`Révoquer l’autorisation ${permit.reference}`}
        >
          <h3>Révoquer</h3>
          <label className="et-field">
            Motif de révocation
            <textarea
              className="et-input"
              required
              minLength={10}
              maxLength={500}
              rows={3}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmRevoke(false);
              }}
            />
          </label>
          <button
            type="button"
            className="et-button"
            disabled={busy || pending || reason.trim().length < 10}
            onClick={() => void revoke()}
          >
            {confirmRevoke ? 'Confirmer la révocation' : 'Révoquer'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function RegulatoryPermitsAdmin() {
  const canManage = useCan('permit.manage');
  const [items, setItems] = useState<RegulatoryPermitSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<RegulatoryPermitDetail | null>(null);
  const busy = false;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [status, setStatus] = useState('');
  const [appliedReference, setAppliedReference] = useState('');
  const [appliedStatus, setAppliedStatus] = useState('');
  const formId = useId();

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.regulatoryPermits.list({
        limit: 25,
        ...(cursor ? { cursor } : {}),
        ...(appliedReference ? { reference: appliedReference } : {}),
        ...(appliedStatus ? { status: appliedStatus as RegulatoryPermitLifecycleStatus } : {}),
      });
      if (!result.ok) return setError(result.error.message);
      setItems((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [appliedReference, appliedStatus],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (permitReference: string) => {
    setError(null);
    const result = await auth.admin.regulatoryPermits.detail(permitReference);
    if (result.ok) setDetail(result.data);
    else setError(result.error.message);
  };
  const changed = async (permit: RegulatoryPermitDetail, message: string) => {
    setDetail(permit);
    setNotice(message);
    await load();
    await select(permit.reference);
  };

  const visible = items ?? [];
  const draftCount = visible.filter((permit) => permit.status === 'DRAFT').length;
  const validCount = visible.filter((permit) => permit.validityState === 'VALID').length;
  const closedCount = visible.filter(
    (permit) => permit.validityState === 'EXPIRED' || permit.validityState === 'REVOKED',
  ).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-ground-workspace ops-permits-workspace"
      data-testid="regulatory-permit-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Conformité réglementaire</p>
          <h2>Registre des autorisations réglementaires</h2>
          <p>
            Autorisations saisies, activées puis révoquées avec un historique complet. La décision
            de readiness et de dispatch appartient à PR-17.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        <strong>
          La validité intrinsèque d’une autorisation ne signifie pas qu’un voyage est prêt ni
          autorisé à partir.
        </strong>
      </p>
      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      {items ? (
        <section
          className="ops-operations-kpis"
          aria-label="Indicateurs des autorisations affichées"
        >
          <OpsKpiCard
            label="Autorisations affichées"
            value={visible.length}
            helper={
              nextCursor
                ? 'Éléments chargés · liste partielle'
                : 'Toutes les autorisations filtrées sont chargées'
            }
            icon="permit"
            tone="info"
          />
          <OpsKpiCard
            label="Brouillons"
            value={draftCount}
            helper="Non actifs, modifiables"
            icon="document"
            tone="neutral"
          />
          <OpsKpiCard
            label="Valides intrinsèquement"
            value={validCount}
            helper="Ne vaut pas autorisation de départ"
            icon="shield"
            tone="info"
          />
          <OpsKpiCard
            label="Expirées ou révoquées"
            value={closedCount}
            helper="Plus utilisables par la readiness"
            icon="alert"
            tone={closedCount > 0 ? 'warning' : 'neutral'}
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres éléments sont disponibles. Les indicateurs ne portent que
          sur les {items.length} autorisations chargées.
        </p>
      ) : null}

      {canManage ? (
        <CreatePermit
          busy={busy}
          onCreated={(permit) => changed(permit, `Autorisation ${permit.reference} créée.`)}
          setError={setError}
        />
      ) : null}
      <form
        className="et-form et-network-form ops-ground-panel"
        aria-label="Filtrer les autorisations"
        onSubmit={(event) => {
          event.preventDefault();
          setDetail(null);
          setAppliedReference(reference.trim().toUpperCase());
          setAppliedStatus(status);
        }}
      >
        <p className="ops-operations-section-kicker">Filtres</p>
        <div className="et-network-adders">
          <label className="et-field" htmlFor={`${formId}-reference`}>
            Référence
            <input
              id={`${formId}-reference`}
              className="et-input"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label className="et-field" htmlFor={`${formId}-status`}>
            Lifecycle
            <select
              id={`${formId}-status`}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">Tous</option>
              <option value="DRAFT">Brouillon</option>
              <option value="ACTIVE">Active</option>
              <option value="REVOKED">Révoquée</option>
            </select>
          </label>
        </div>
        <button type="submit" className="et-button">
          Appliquer les filtres
        </button>
      </form>
      <section
        aria-labelledby="permit-list-title"
        className="ops-operations-section ops-operations-section--primary"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Registre</p>
            <h2 id="permit-list-title">Autorisations</h2>
          </div>
        </div>
        {!items && !error ? <OpsLoadingState title="Chargement des autorisations…" /> : null}
        {items && items.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Autorisations et validité intrinsèque évaluée par le serveur</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Type / intitulé</th>
                  <th scope="col">Autorité</th>
                  <th scope="col">Périmètre</th>
                  <th scope="col">Période</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Validité intrinsèque</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {items.map((permit) => (
                  <tr
                    key={permit.reference}
                    className={
                      detail?.reference === permit.reference ? 'ops-table-row--selected' : undefined
                    }
                  >
                    <th scope="row" className="et-code">
                      {permit.reference}
                    </th>
                    <td>
                      {permit.permitType}
                      <br />
                      {permit.title}
                    </td>
                    <td>{permit.issuingAuthority}</td>
                    <td>{scopeLabel(permit.scope)}</td>
                    <td>
                      {permit.validFrom} → {permit.validUntil}
                    </td>
                    <td>
                      <OpsStatusBadge tone={STATUS_TONES[permit.status]}>
                        {STATUS_LABELS[permit.status]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      <OpsStatusBadge tone={VALIDITY_TONES[permit.validityState]}>
                        {VALIDITY_LABELS[permit.validityState]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter l’autorisation ${permit.reference}`}
                        aria-controls="permit-detail-panel"
                        aria-expanded={detail?.reference === permit.reference}
                        onClick={() => void select(permit.reference)}
                      >
                        Consulter
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {items?.length === 0 ? (
          <OpsEmptyState
            title="Aucune autorisation."
            description="Aucune autorisation ne correspond aux filtres actuellement appliqués."
          />
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Charger la suite
          </button>
        ) : null}
      </section>
      {detail ? (
        <OpsDetailRegion
          id="permit-detail-panel"
          focusKey={detail.reference}
          onClose={() => setDetail(null)}
        >
          <Detail
            permit={detail}
            canManage={canManage}
            busy={busy}
            onChanged={changed}
            setError={setError}
          />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
