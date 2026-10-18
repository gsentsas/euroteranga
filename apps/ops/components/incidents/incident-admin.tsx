'use client';

import type {
  IncidentActionType,
  IncidentDetail,
  IncidentOwner,
  IncidentSeverity,
  IncidentStatus,
  IncidentSummary,
  IncidentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus, TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsState } from '../ops-state';
import { useCan } from '../staff-access';

const TYPE_LABELS: Record<IncidentType, string> = {
  BREAKDOWN: 'Panne',
  ACCIDENT: 'Accident',
  DELAY: 'Retard',
  BORDER: 'Frontière',
  CUSTOMS: 'Douane',
  POLICE: 'Police',
  PASSENGER: 'Passager',
  HEALTH: 'Santé',
  BAGGAGE: 'Bagage',
  SECURITY: 'Sécurité',
  WEATHER: 'Météo',
  FERRY: 'Ferry',
  OTHER: 'Autre',
};

const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  LOW: 'Faible',
  MEDIUM: 'Moyenne',
  HIGH: 'Élevée',
  CRITICAL: 'Critique',
};

const STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Ouvert',
  ASSESSING: 'Évaluation',
  ACTION_REQUIRED: 'Action requise',
  MITIGATING: 'Traitement en cours',
  RESOLVED: 'Résolu',
  CLOSED: 'Clôturé',
};

const ACTION_LABELS: Record<IncidentActionType, string> = {
  NOTE: 'Note opérationnelle',
  ACTION_PLAN: 'Plan d’action',
  MITIGATION: 'Mesure de traitement',
  PASSENGERS_INFORMED: 'Passagers informés',
  POSTMORTEM: 'Retour d’expérience',
};

const TYPES = Object.keys(TYPE_LABELS) as IncidentType[];
const SEVERITIES = Object.keys(SEVERITY_LABELS) as IncidentSeverity[];
const STATUSES = Object.keys(STATUS_LABELS) as IncidentStatus[];
const ACTIONS = Object.keys(ACTION_LABELS) as IncidentActionType[];

const formatAt = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

function nextStatus(status: IncidentStatus): IncidentStatus | null {
  switch (status) {
    case 'OPEN':
      return 'ASSESSING';
    case 'ASSESSING':
      return 'ACTION_REQUIRED';
    case 'ACTION_REQUIRED':
      return 'MITIGATING';
    case 'MITIGATING':
      return 'RESOLVED';
    case 'RESOLVED':
      return 'CLOSED';
    case 'CLOSED':
      return null;
  }
}

function requiredCriticalMilestone(detail: IncidentDetail): IncidentActionType | null {
  if (detail.type !== 'BREAKDOWN' || detail.severity !== 'CRITICAL') return null;
  if (detail.status === 'ACTION_REQUIRED') return 'ACTION_PLAN';
  if (detail.status === 'MITIGATING') return 'PASSENGERS_INFORMED';
  if (detail.status === 'RESOLVED') return 'POSTMORTEM';
  return null;
}

function hasAction(detail: IncidentDetail, type: IncidentActionType): boolean {
  return detail.actions.some((action) => action.type === type);
}

function IncidentDetailPanel({
  detail,
  owners,
  canManage,
  onChanged,
}: {
  detail: IncidentDetail;
  owners: readonly IncidentOwner[];
  canManage: boolean;
  onChanged: (reference: string, message: string) => Promise<void>;
}) {
  const ownerId = useId();
  const actionId = useId();
  const [ownerIdentityId, setOwnerIdentityId] = useState(detail.ownerIdentityId ?? '');
  const [ownerReason, setOwnerReason] = useState('Prise en charge opérationnelle');
  const [actionType, setActionType] = useState<IncidentActionType>('NOTE');
  const [content, setContent] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentInputKey, setAttachmentInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOwnerIdentityId(detail.ownerIdentityId ?? '');
  }, [detail.ownerIdentityId]);

  const run = async (work: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (!result.ok) {
        setError(result.error?.message ?? 'Action impossible.');
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const assign = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run(() =>
      auth.admin.incidents.assignOwner(detail.reference, {
        ownerIdentityId: ownerIdentityId || null,
        reason: ownerReason.trim(),
      }),
    );
    if (ok) await onChanged(detail.reference, 'Responsable opérationnel mis à jour.');
  };

  const addAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!content.trim()) return;
    const result = await auth.admin.incidents.addAction(detail.reference, {
      clientActionId: 'act-' + crypto.randomUUID(),
      type: actionType,
      content: content.trim(),
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setContent('');
    await onChanged(
      detail.reference,
      result.data.created ? 'Action ajoutée au journal.' : 'Action déjà enregistrée.',
    );
  };

  const uploadAttachment = async (event: FormEvent) => {
    event.preventDefault();
    if (!attachment || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.incidents.uploadAttachment(detail.reference, attachment);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setAttachment(null);
      setAttachmentInputKey((value) => value + 1);
      await onChanged(detail.reference, 'Pièce jointe privée contrôlée et enregistrée.');
    } finally {
      setBusy(false);
    }
  };

  const downloadAttachment = async (attachmentId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.admin.incidents.downloadAttachment(detail.reference, attachmentId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const url = URL.createObjectURL(result.data.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.data.filename;
      anchor.rel = 'noopener';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setBusy(false);
    }
  };

  const next = nextStatus(detail.status);
  const milestone = requiredCriticalMilestone(detail);
  const milestoneMissing = milestone ? !hasAction(detail, milestone) : false;

  const transition = async () => {
    if (!next || milestoneMissing) return;
    const ok = await run(() =>
      auth.admin.incidents.transition(detail.reference, {
        status: next,
        expectedStatus: detail.status,
      }),
    );
    if (ok) {
      await onChanged(detail.reference, 'Incident passé à « ' + STATUS_LABELS[next] + ' ».');
    }
  };

  return (
    <section
      className="et-network-panel"
      aria-labelledby={'incident-' + detail.reference}
      data-testid="incident-detail"
    >
      <div className="et-actions">
        <h2 id={'incident-' + detail.reference}>Incident {detail.reference}</h2>
        <span className="et-tag">{TYPE_LABELS[detail.type]}</span>
        <span className="et-tag">{SEVERITY_LABELS[detail.severity]}</span>
        <span className="et-tag">{STATUS_LABELS[detail.status]}</span>
      </div>

      <FormAlert message={error} />

      <dl className="et-booking-admin-summary">
        <dt>Voyage</dt>
        <dd>
          <span className="et-code">{detail.trip.reference}</span> · {detail.trip.status}
        </dd>
        <dt>Véhicule</dt>
        <dd>{detail.vehicle?.code ?? '—'}</dd>
        <dt>Lieu</dt>
        <dd>
          {detail.locationLabel ??
            (detail.waypoint
              ? String(detail.waypoint.sequence) +
                '. ' +
                (detail.waypoint.code ?? '') +
                ' — ' +
                (detail.waypoint.name ?? 'Point de route')
              : 'Non précisé')}
        </dd>
        <dt>Bagage</dt>
        <dd>
          {detail.baggage
            ? detail.baggage.reference + ' · ' + (detail.baggage.exceptionStatus ?? '—')
            : '—'}
        </dd>
        <dt>Origine</dt>
        <dd>{detail.source}</dd>
        <dt>Survenu le</dt>
        <dd>{formatAt(detail.openedAt)}</dd>
        <dt>Enregistré le</dt>
        <dd>{formatAt(detail.recordedAt)}</dd>
        <dt>Responsable</dt>
        <dd>
          {owners.find((owner) => owner.id === detail.ownerIdentityId)?.email ?? 'Non assigné'}
        </dd>
      </dl>

      <p>{detail.description}</p>

      {canManage && detail.status !== 'CLOSED' ? (
        <div className="et-network-adders">
          <form className="et-form" aria-label="Assigner l’incident" onSubmit={assign}>
            <div className="et-field">
              <label htmlFor={ownerId}>Responsable opérationnel</label>
              <select
                id={ownerId}
                className="et-select"
                value={ownerIdentityId}
                onChange={(event) => setOwnerIdentityId(event.target.value)}
              >
                <option value="">Non assigné</option>
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.email}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label="Motif d’assignation"
              name="ownerReason"
              value={ownerReason}
              onChange={setOwnerReason}
              autoComplete="off"
              maxLength={255}
            />
            <button className="et-button et-button--secondary" type="submit" disabled={busy}>
              Enregistrer l’assignation
            </button>
          </form>

          <form
            className="et-form"
            aria-label="Ajouter une pièce jointe privée"
            onSubmit={uploadAttachment}
          >
            <label className="et-field">
              <span>Pièce jointe privée</span>
              <input
                key={attachmentInputKey}
                className="et-input"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
              />
            </label>
            <p className="et-hint">
              PDF, JPEG ou PNG. Le fichier est stocké en privé et contrôlé par le scanner de
              sécurité avant d’apparaître dans l’incident.
            </p>
            <button
              className="et-button et-button--secondary"
              type="submit"
              disabled={busy || !attachment}
            >
              Ajouter la pièce jointe
            </button>
          </form>

          <form className="et-form" aria-label="Ajouter une action" onSubmit={addAction}>
            <div className="et-field">
              <label htmlFor={actionId}>Type d’action</label>
              <select
                id={actionId}
                className="et-select"
                value={actionType}
                onChange={(event) => setActionType(event.target.value as IncidentActionType)}
              >
                {ACTIONS.map((value) => (
                  <option key={value} value={value}>
                    {ACTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <label className="et-field">
              <span>Contenu opérationnel</span>
              <textarea
                className="et-input"
                rows={4}
                maxLength={2000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <button className="et-button et-button--secondary" type="submit" disabled={busy}>
              Ajouter au journal
            </button>
          </form>
        </div>
      ) : null}

      {canManage && next ? (
        <section className="et-network-panel" aria-labelledby="incident-next-action">
          <h3 id="incident-next-action">Prochaine étape</h3>
          {milestone ? (
            <p className="et-hint">
              Panne critique : « {ACTION_LABELS[milestone]} » doit être documenté avant cette
              transition.
            </p>
          ) : null}
          <button
            type="button"
            className="et-button"
            disabled={busy || milestoneMissing}
            onClick={() => void transition()}
            data-testid="incident-next-transition"
          >
            Passer à « {STATUS_LABELS[next]} »
          </button>
        </section>
      ) : null}

      <div className="et-table-wrap">
        <table data-testid="incident-actions">
          <caption>Journal d’actions immuable</caption>
          <thead>
            <tr>
              <th>N°</th>
              <th>Action</th>
              <th>Contenu</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {detail.actions.length === 0 ? (
              <tr>
                <td colSpan={4}>Aucune action documentée.</td>
              </tr>
            ) : (
              detail.actions.map((action) => (
                <tr key={action.id}>
                  <td>{action.sequence}</td>
                  <td>{ACTION_LABELS[action.type]}</td>
                  <td>{action.content}</td>
                  <td>{formatAt(action.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="et-table-wrap">
        <table data-testid="incident-attachments">
          <caption>Pièces jointes privées</caption>
          <thead>
            <tr>
              <th>Type</th>
              <th>Taille</th>
              <th>SHA-256</th>
              <th>Ajoutée le</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {detail.attachments.length === 0 ? (
              <tr>
                <td colSpan={5}>Aucune pièce jointe.</td>
              </tr>
            ) : (
              detail.attachments.map((item) => (
                <tr key={item.id}>
                  <td>{item.mimeType}</td>
                  <td>{new Intl.NumberFormat('fr-FR').format(item.sizeBytes)} octets</td>
                  <td className="et-code">{item.sha256.slice(0, 16)}…</td>
                  <td>{formatAt(item.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      disabled={busy}
                      onClick={() => void downloadAttachment(item.id)}
                    >
                      Télécharger
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="et-hint">
        Les fichiers restent privés : aucun lien objet, chemin de stockage ou URL publique n’est
        exposé.
      </p>
    </section>
  );
}

export function IncidentAdmin() {
  const statusId = useId();
  const severityId = useId();
  const typeId = useId();
  const openTypeId = useId();
  const openSeverityId = useId();
  const canManage = useCan('incident.manage');

  const [status, setStatus] = useState<IncidentStatus | ''>('');
  const [severity, setSeverity] = useState<IncidentSeverity | ''>('');
  const [type, setType] = useState<IncidentType | ''>('');
  const [tripFilter, setTripFilter] = useState('');
  const [appliedTrip, setAppliedTrip] = useState('');

  const [items, setItems] = useState<IncidentSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [owners, setOwners] = useState<IncidentOwner[]>([]);

  const [tripReference, setTripReference] = useState('');
  const [openType, setOpenType] = useState<IncidentType>('DELAY');
  const [openSeverity, setOpenSeverity] = useState<IncidentSeverity>('MEDIUM');
  const [description, setDescription] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [baggageReference, setBaggageReference] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.incidents.list({
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
        ...(severity ? { severity } : {}),
        ...(type ? { type } : {}),
        ...(appliedTrip ? { tripReference: appliedTrip } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((current) =>
        cursor ? [...(current ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [appliedTrip, severity, status, type],
  );

  const select = useCallback(async (reference: string) => {
    const result = await auth.admin.incidents.detail(reference);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDetail(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    void auth.admin.incidents.owners().then((result) => {
      if (result.ok) setOwners(result.data.items);
    });
  }, [canManage]);

  const changed = async (reference: string, message: string) => {
    setNotice(message);
    await Promise.all([select(reference), load()]);
  };

  const filter = (event: FormEvent) => {
    event.preventDefault();
    setAppliedTrip(tripFilter.trim().toUpperCase());
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.incidents.open({
        tripReference: tripReference.trim().toUpperCase(),
        clientEventId: 'evt-' + crypto.randomUUID(),
        type: openType,
        severity: openSeverity,
        description: description.trim(),
        openedAt: new Date().toISOString(),
        ...(locationLabel.trim() ? { locationLabel: locationLabel.trim() } : {}),
        ...(openType === 'BAGGAGE' && baggageReference.trim()
          ? { baggageReference: baggageReference.trim().toUpperCase() }
          : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTripReference('');
      setDescription('');
      setLocationLabel('');
      setBaggageReference('');
      setNotice(result.data.created ? 'Incident ouvert.' : 'Incident déjà enregistré.');
      await Promise.all([load(), select(result.data.incident.reference)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="et-network" data-testid="incident-workspace">
      <p>
        Suivi factuel des incidents opérationnels du trajet. Les catégories frontière, douane ou
        police ne constituent jamais une décision juridique, douanière ou d’immigration.
      </p>
      <FormAlert message={error} />
      {notice ? <FormStatus>{notice}</FormStatus> : null}

      <form
        className="et-form et-network-form"
        aria-label="Filtrer les incidents"
        onSubmit={filter}
      >
        <div className="et-field">
          <label htmlFor={statusId}>Statut</label>
          <select
            id={statusId}
            className="et-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as IncidentStatus | '')}
          >
            <option value="">Tous</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={severityId}>Sévérité</label>
          <select
            id={severityId}
            className="et-select"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as IncidentSeverity | '')}
          >
            <option value="">Toutes</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={typeId}>Type</label>
          <select
            id={typeId}
            className="et-select"
            value={type}
            onChange={(event) => setType(event.target.value as IncidentType | '')}
          >
            <option value="">Tous</option>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Voyage"
          name="tripFilter"
          value={tripFilter}
          onChange={setTripFilter}
          autoComplete="off"
          hint="Référence du voyage, par exemple ET-..."
          maxLength={32}
        />
        <button className="et-button et-button--secondary" type="submit">
          Appliquer
        </button>
      </form>

      {canManage ? (
        <section className="et-network-panel" aria-labelledby="incident-open-title">
          <h2 id="incident-open-title">Ouvrir un incident</h2>
          <form className="et-form et-network-form" onSubmit={open}>
            <TextField
              label="Voyage"
              name="tripReference"
              value={tripReference}
              onChange={setTripReference}
              autoComplete="off"
              hint="Référence du voyage"
              maxLength={32}
            />
            <div className="et-field">
              <label htmlFor={openTypeId}>Type</label>
              <select
                id={openTypeId}
                className="et-select"
                value={openType}
                onChange={(event) => setOpenType(event.target.value as IncidentType)}
              >
                {TYPES.map((value) => (
                  <option key={value} value={value}>
                    {TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="et-field">
              <label htmlFor={openSeverityId}>Sévérité</label>
              <select
                id={openSeverityId}
                className="et-select"
                value={openSeverity}
                onChange={(event) => setOpenSeverity(event.target.value as IncidentSeverity)}
              >
                {SEVERITIES.map((value) => (
                  <option key={value} value={value}>
                    {SEVERITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <label className="et-field">
              <span>Description opérationnelle</span>
              <textarea
                className="et-input"
                rows={4}
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <TextField
              label="Lieu libre (optionnel)"
              name="locationLabel"
              value={locationLabel}
              onChange={setLocationLabel}
              autoComplete="off"
              required={false}
              maxLength={160}
            />
            {openType === 'BAGGAGE' ? (
              <TextField
                label="Référence bagage"
                name="baggageReference"
                value={baggageReference}
                onChange={setBaggageReference}
                autoComplete="off"
                hint="Référence ETG-..."
                maxLength={16}
              />
            ) : null}
            <button className="et-button" type="submit" disabled={busy}>
              Ouvrir l’incident
            </button>
          </form>
        </section>
      ) : null}

      <div className="et-table-wrap">
        <table data-testid="incident-list">
          <caption>Incidents opérationnels</caption>
          <thead>
            <tr>
              <th>Référence</th>
              <th>Voyage</th>
              <th>Type</th>
              <th>Sévérité</th>
              <th>Statut</th>
              <th>Responsable</th>
              <th>Ouvert le</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr>
                <td colSpan={8}>
                  <OpsState
                    kind="loading"
                    title="Chargement des incidents"
                    detail="Récupération du journal opérationnel."
                  />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <OpsState
                    kind="empty"
                    title="Aucun incident"
                    detail="Aucun incident ne correspond aux filtres actuels."
                  />
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id}>
                  <td className="et-code">{item.reference}</td>
                  <td className="et-code">{item.trip.reference}</td>
                  <td>{TYPE_LABELS[item.type]}</td>
                  <td>{SEVERITY_LABELS[item.severity]}</td>
                  <td>{STATUS_LABELS[item.status]}</td>
                  <td>{owners.find((owner) => owner.id === item.ownerIdentityId)?.email ?? '—'}</td>
                  <td>{formatAt(item.openedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      onClick={() => void select(item.reference)}
                    >
                      Ouvrir
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {nextCursor ? (
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load(nextCursor)}
        >
          Charger la suite
        </button>
      ) : null}

      {detail ? (
        <IncidentDetailPanel
          detail={detail}
          owners={owners}
          canManage={canManage}
          onChanged={changed}
        />
      ) : null}
    </div>
  );
}
