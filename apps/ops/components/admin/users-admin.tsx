'use client';

import type { AdminIdentity, AdminRole } from '@euroteranga/auth-client';
import { SubmitButton, TextField, useFormSubmit } from '@euroteranga/ui';
import { useGetIdentity } from '@refinedev/core';
import { useCallback, useEffect, useId, useState } from 'react';
import { auth } from '../../lib/auth';
import { OpsEmptyState, OpsLoadingState } from '../ops-data-state';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { useAdminFeedback } from './admin-feedback';

const STATUS_LABELS: Record<AdminIdentity['status'], string> = {
  PENDING_VERIFICATION: 'En attente',
  ACTIVE: 'Actif',
  SUSPENDED: 'Suspendu',
  DISABLED: 'Désactivé',
};

/** An active account is not a business success: never green. */
const STATUS_TONES: Record<AdminIdentity['status'], 'info' | 'warning' | 'danger' | 'neutral'> = {
  PENDING_VERIFICATION: 'warning',
  ACTIVE: 'info',
  SUSPENDED: 'danger',
  DISABLED: 'neutral',
};

type Run = ReturnType<typeof useAdminFeedback>['run'];

function InviteStaffForm({
  roles,
  run,
  onDone,
}: {
  roles: AdminRole[];
  run: Run;
  onDone: () => void;
}) {
  const selectId = useId();
  const staffRoles = roles.filter((role) => role.realm === 'STAFF');
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const { pending, submit } = useFormSubmit(async () => {
    const ok = await run(
      () => auth.admin.inviteStaff(email, roleKey),
      `Invitation envoyée à ${email}.`,
    );
    if (ok) {
      setEmail('');
      onDone();
    }
  });

  return (
    <form
      className="et-form et-network-form ops-ground-panel"
      onSubmit={submit}
      aria-label="Inviter un membre du personnel"
    >
      <div>
        <p className="ops-operations-section-kicker">Provisionnement STAFF</p>
        <h2>Inviter un membre du personnel</h2>
      </div>
      <p className="ops-ground-form__hint">
        Seuls les rôles du personnel sont proposés. Le compte s’active par le lien d’invitation,
        puis configure son second facteur.
      </p>
      <TextField
        label="Adresse e-mail professionnelle"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="off"
        value={email}
        onChange={setEmail}
      />
      <div className="et-field">
        <label htmlFor={selectId}>Rôle initial</label>
        <select
          id={selectId}
          className="et-select"
          required
          value={roleKey}
          onChange={(event) => setRoleKey(event.target.value)}
        >
          <option value="">Choisir un rôle</option>
          {staffRoles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name} ({role.key})
            </option>
          ))}
        </select>
      </div>
      <SubmitButton pending={pending}>Envoyer l’invitation</SubmitButton>
    </form>
  );
}

/** Asks for a second click before an action that cannot be undone. */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        className="et-button et-button--secondary"
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="et-button ops-sensitive-action"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="et-button et-button--secondary"
        onClick={() => setArmed(false)}
      >
        Annuler
      </button>
    </>
  );
}

function IdentityRow({
  identity,
  roles,
  isSelf,
  run,
  busy,
  onChanged,
}: {
  identity: AdminIdentity;
  roles: AdminRole[];
  isSelf: boolean;
  run: Run;
  busy: boolean;
  onChanged: () => void;
}) {
  const canAssign = useCan('role.assign');
  const canStatus = useCan('identity.status.manage');
  const canRevokeSessions = useCan('session.revoke.any');
  const canAuthorizeMfa = useCan('mfa.enrollment.authorize');
  const selectId = useId();
  const [roleToGrant, setRoleToGrant] = useState('');
  const grantable = roles.filter(
    (role) => role.realm === identity.realm && !identity.roles.includes(role.key),
  );
  const who = identity.email;
  const act = async (action: Parameters<Run>[0], success: string) => {
    if (await run(action, success)) onChanged();
  };

  return (
    <tr>
      <th scope="row" className="ops-admin-identity">
        {who}
        {isSelf ? ' (vous)' : null}
      </th>
      <td>
        <OpsStatusBadge tone={STATUS_TONES[identity.status]}>
          {STATUS_LABELS[identity.status]}
        </OpsStatusBadge>
      </td>
      <td>
        <ul className="ops-chip-list" aria-label={`Rôles de ${who}`}>
          {identity.roles.length === 0 ? <li className="ops-ground-form__hint">aucun</li> : null}
          {identity.roles.map((roleKey) => (
            <li key={roleKey}>
              <span className="ops-code-chip">{roleKey}</span>
              {canAssign && !isSelf ? (
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  disabled={busy}
                  aria-label={`Retirer le rôle ${roleKey} à ${who}`}
                  onClick={() =>
                    void act(
                      () => auth.admin.revokeRole(identity.id, roleKey),
                      `Rôle ${roleKey} retiré à ${who}.`,
                    )
                  }
                >
                  Retirer
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </td>
      <td>
        {identity.realm === 'STAFF' ? (
          <OpsStatusBadge tone={identity.mfaEnabled ? 'info' : 'warning'}>
            {identity.mfaEnabled ? 'Activée' : 'Non configurée'}
          </OpsStatusBadge>
        ) : (
          '—'
        )}
      </td>
      <td>
        {isSelf ? (
          <span className="ops-ground-form__hint">Vos propres accès ne se modifient pas ici.</span>
        ) : (
          <div className="et-actions ops-admin-actions">
            {canAssign && grantable.length > 0 ? (
              <>
                <label htmlFor={selectId} className="et-visually-hidden">
                  Rôle à attribuer à {who}
                </label>
                <select
                  id={selectId}
                  className="et-select"
                  value={roleToGrant}
                  onChange={(event) => setRoleToGrant(event.target.value)}
                >
                  <option value="">Rôle…</option>
                  {grantable.map((role) => (
                    <option key={role.key} value={role.key}>
                      {role.key}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  disabled={busy || !roleToGrant}
                  aria-label={`Attribuer le rôle choisi à ${who}`}
                  onClick={() =>
                    void act(
                      () => auth.admin.grantRole(identity.id, roleToGrant),
                      `Rôle ${roleToGrant} attribué à ${who}.`,
                    ).then(() => setRoleToGrant(''))
                  }
                >
                  Attribuer
                </button>
              </>
            ) : null}
            {canStatus && identity.status === 'ACTIVE' ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy}
                aria-label={`Suspendre ${who}`}
                onClick={() =>
                  void act(
                    () => auth.admin.setStatus(identity.id, 'SUSPENDED'),
                    `${who} est suspendu ; ses sessions sont fermées.`,
                  )
                }
              >
                Suspendre
              </button>
            ) : null}
            {canStatus && identity.status === 'SUSPENDED' ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy}
                aria-label={`Réactiver ${who}`}
                onClick={() =>
                  void act(
                    () => auth.admin.setStatus(identity.id, 'ACTIVE'),
                    `${who} est réactivé.`,
                  )
                }
              >
                Réactiver
              </button>
            ) : null}
            {canStatus && (identity.status === 'ACTIVE' || identity.status === 'SUSPENDED') ? (
              <ConfirmButton
                label={`Désactiver ${who}`}
                confirmLabel={`Confirmer la désactivation définitive de ${who}`}
                disabled={busy}
                onConfirm={() =>
                  void act(
                    () => auth.admin.setStatus(identity.id, 'DISABLED'),
                    `${who} est désactivé.`,
                  )
                }
              />
            ) : null}
            {canRevokeSessions ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy}
                aria-label={`Fermer toutes les sessions de ${who}`}
                onClick={() =>
                  void act(
                    () => auth.admin.revokeSessions(identity.id),
                    `Toutes les sessions de ${who} sont fermées.`,
                  )
                }
              >
                Fermer les sessions
              </button>
            ) : null}
            {canAuthorizeMfa &&
            identity.realm === 'STAFF' &&
            identity.status === 'ACTIVE' &&
            !identity.mfaEnabled ? (
              <button
                type="button"
                className="et-button et-button--secondary"
                disabled={busy}
                aria-label={`Autoriser la configuration MFA de ${who}`}
                onClick={() =>
                  void act(
                    () => auth.admin.authorizeMfaEnrollment(identity.id),
                    `${who} peut configurer son second facteur à sa prochaine connexion.`,
                  )
                }
              >
                Autoriser la configuration MFA
              </button>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

/** STAFF and CREW identities: list (identity.read) and actions (per permission). */
export function UsersAdmin() {
  const { data: me } = useGetIdentity<{ id: string }>();
  const canReadRoles = useCan('role.read');
  const canInvite = useCan('identity.staff.provision', 'role.assign');
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [realm, setRealm] = useState<'staff' | 'crew'>('staff');
  const [items, setItems] = useState<AdminIdentity[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [roles, setRoles] = useState<AdminRole[]>([]);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.identities({ realm, ...(cursor ? { cursor } : {}) });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [realm, setError],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!canReadRoles) return;
    void auth.admin.roles().then((result) => {
      if (result.ok) setRoles(result.data);
    });
  }, [canReadRoles]);

  const reload = () => void load();

  const visible = items ?? [];
  const activeCount = visible.filter((identity) => identity.status === 'ACTIVE').length;
  const pendingCount = visible.filter(
    (identity) => identity.status === 'PENDING_VERIFICATION',
  ).length;
  const blockedCount = visible.filter(
    (identity) => identity.status === 'SUSPENDED' || identity.status === 'DISABLED',
  ).length;
  const population = realm === 'staff' ? 'Personnel' : 'Équipages';

  return (
    <section
      className="et-network ops-operations-workspace ops-ground-workspace ops-admin-workspace"
      aria-labelledby="users-title"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Administration des identités</p>
          <h2 id="users-title">Comptes du personnel et des équipages</h2>
          <p>
            Chaque action dépend de sa propre permission : attribution de rôle, statut du compte,
            fermeture des sessions et autorisation MFA restent distinctes. Les populations STAFF et
            CREW ne partagent pas leurs rôles.
          </p>
        </div>
      </div>
      {feedback}
      {items ? (
        <section className="ops-operations-kpis" aria-label={`Indicateurs : ${population}`}>
          <OpsKpiCard
            label={`Comptes affichés · ${population}`}
            value={visible.length}
            helper={
              nextCursor ? 'Éléments chargés · liste partielle' : 'Tous les comptes sont chargés'
            }
            icon="users"
            tone="info"
          />
          <OpsKpiCard
            label="Actifs"
            value={activeCount}
            helper="Parmi les comptes affichés"
            icon="check"
            tone="info"
          />
          <OpsKpiCard
            label="En attente"
            value={pendingCount}
            helper="Invitation non encore activée"
            icon="audit"
            tone={pendingCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Suspendus ou désactivés"
            value={blockedCount}
            helper="Sans accès au back-office"
            icon="shield"
            tone={blockedCount > 0 ? 'danger' : 'neutral'}
          />
        </section>
      ) : null}
      {items && nextCursor ? (
        <p className="ops-ground-partial" role="note">
          Données partielles — d’autres comptes sont disponibles. Les indicateurs ne portent que sur
          les {visible.length} comptes chargés.
        </p>
      ) : null}
      {canInvite ? <InviteStaffForm roles={roles} run={run} onDone={reload} /> : null}
      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="users-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Registre des identités</p>
            <h2 id="users-list-title">{population}</h2>
          </div>
          <div className="et-actions ops-segmented" role="group" aria-label="Population affichée">
            {(['staff', 'crew'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={value === realm ? 'et-button' : 'et-button et-button--secondary'}
                aria-pressed={value === realm}
                onClick={() => setRealm(value)}
              >
                {value === 'staff' ? 'Personnel' : 'Équipages'}
              </button>
            ))}
          </div>
        </div>
        {items === null ? (
          <OpsLoadingState title="Chargement des comptes…" />
        ) : items.length === 0 ? (
          <OpsEmptyState title="Aucun compte." description="Aucun compte pour cette population." />
        ) : (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>{population}</caption>
              <thead>
                <tr>
                  <th scope="col">E-mail</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Rôles</th>
                  <th scope="col">MFA</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((identity) => (
                  <IdentityRow
                    key={identity.id}
                    identity={identity}
                    roles={roles}
                    isSelf={identity.id === me?.id}
                    run={run}
                    busy={busy}
                    onChanged={reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Afficher plus
          </button>
        ) : null}
      </section>
    </section>
  );
}
