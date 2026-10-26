'use client';

import type { AdminRole } from '@euroteranga/auth-client';
import { useEffect, useState } from 'react';
import { auth } from '../../lib/auth';
import { OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';

const REALM_LABELS: Record<string, string> = {
  STAFF: 'Personnel',
  CREW: 'Équipages',
  CUSTOMER: 'Clients',
};

/** Read-only view of the role catalogue (the database is its single source). */
export function RolesAdmin() {
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void auth.admin.roles().then((result) => {
      if (result.ok) setRoles(result.data);
      else setError(result.error.message);
    });
  }, []);

  if (error) return <OpsErrorState title="Impossible de charger les rôles" message={error} />;
  if (!roles) return <OpsLoadingState title="Chargement des rôles…" />;
  const realms = [...new Set(roles.map((role) => role.realm))];
  const privilegedCount = roles.filter((role) => role.privileged).length;
  const permissionCount = new Set(roles.flatMap((role) => role.permissions)).size;

  return (
    <div className="et-network ops-operations-workspace ops-ground-workspace ops-admin-workspace">
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Administration des accès</p>
          <h2>Rôles et permissions</h2>
          <p>
            Chaque rôle appartient à une population et regroupe des permissions précises. Un rôle
            s’attribue ou se retire depuis la page Utilisateurs.
          </p>
        </div>
      </div>
      <p className="ops-ground-guardrail ops-ground-guardrail--strong">
        Catalogue en lecture seule : la base de données en est l’unique source. Aucun rôle ni aucune
        permission ne se crée, ne se modifie ou ne se supprime ici.
      </p>
      <section className="ops-operations-kpis" aria-label="Indicateurs du catalogue des rôles">
        <OpsKpiCard
          label="Rôles du catalogue"
          value={roles.length}
          helper="Catalogue complet"
          icon="roles"
          tone="info"
        />
        <OpsKpiCard
          label="Populations"
          value={realms.length}
          helper={realms.map((realm) => REALM_LABELS[realm] ?? realm).join(' · ')}
          icon="users"
          tone="neutral"
        />
        <OpsKpiCard
          label="Rôles privilégiés"
          value={privilegedCount}
          helper="Accès sensibles, attribution contrôlée"
          icon="shield"
          tone={privilegedCount > 0 ? 'warning' : 'neutral'}
        />
        <OpsKpiCard
          label="Permissions distinctes"
          value={permissionCount}
          helper="Utilisées par au moins un rôle"
          icon="audit"
          tone="neutral"
        />
      </section>
      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="roles-list-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Lecture seule</p>
            <h2 id="roles-list-title">Catalogue</h2>
          </div>
        </div>
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>Catalogue des rôles (lecture seule)</caption>
            <thead>
              <tr>
                <th scope="col">Rôle</th>
                <th scope="col">Population</th>
                <th scope="col">Privilégié</th>
                <th scope="col">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.key}>
                  <th scope="row" className="ops-admin-role">
                    <span className="ops-admin-role__name">{role.name}</span>{' '}
                    <span className="ops-code-chip">{role.key}</span>
                    <br />
                    <span className="et-hint">{role.description}</span>
                  </th>
                  <td>{REALM_LABELS[role.realm] ?? role.realm}</td>
                  <td>
                    {role.privileged ? (
                      <OpsStatusBadge tone="warning">Privilégié</OpsStatusBadge>
                    ) : (
                      'Non'
                    )}
                  </td>
                  <td>
                    {role.permissions.length ? (
                      <ul
                        className="ops-chip-list"
                        aria-label={`${role.permissions.length} permissions de ${role.name}`}
                      >
                        {role.permissions.map((permission) => (
                          <li key={permission}>
                            <span className="ops-code-chip">{permission}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'aucune'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
