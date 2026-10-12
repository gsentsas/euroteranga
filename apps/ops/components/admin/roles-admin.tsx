'use client';

import type { AdminRole } from '@euroteranga/auth-client';
import { useEffect, useState } from 'react';
import { auth } from '../../lib/auth';

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

  if (error) {
    return (
      <div className="et-alert" role="alert">
        {error}
      </div>
    );
  }
  if (!roles) return <p role="status">Chargement…</p>;
  return (
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
              <th scope="row">
                {role.name} <span className="et-tag">{role.key}</span>
                <br />
                <span className="et-hint">{role.description}</span>
              </th>
              <td>{role.realm}</td>
              <td>{role.privileged ? 'Oui' : 'Non'}</td>
              <td>{role.permissions.length ? role.permissions.join(', ') : 'aucune'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
