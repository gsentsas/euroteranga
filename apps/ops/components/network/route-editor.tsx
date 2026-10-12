'use client';

import type {
  NetworkCheckpoint,
  NetworkRouteDetail,
  NetworkRouteVersion,
  NetworkStop,
  NetworkWaypointInput,
} from '@euroteranga/auth-client';
import { useEffect, useId, useState } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface EditorWaypoint {
  key: string;
  value: NetworkWaypointInput;
}

const VERSION_LABELS: Record<NetworkRouteVersion['status'], string> = {
  DRAFT: 'Brouillon',
  PUBLISHED: 'Publiée',
  RETIRED: 'Retirée',
};

function toInput(version: NetworkRouteVersion): EditorWaypoint[] {
  return [...version.waypoints]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap<EditorWaypoint>((waypoint) => {
      if (waypoint.stopId) {
        return [
          {
            key: waypoint.id,
            value: {
              kind: 'STOP' as const,
              stopId: waypoint.stopId,
              boardingAllowed: waypoint.boardingAllowed,
              alightingAllowed: waypoint.alightingAllowed,
            },
          },
        ];
      }
      if (waypoint.checkpointId) {
        return [
          {
            key: waypoint.id,
            value: { kind: 'CHECKPOINT' as const, checkpointId: waypoint.checkpointId },
          },
        ];
      }
      return [];
    });
}

function waypointLabel(
  waypoint: NetworkWaypointInput,
  stops: readonly NetworkStop[],
  checkpoints: readonly NetworkCheckpoint[],
): string {
  if (waypoint.kind === 'STOP') {
    const stop = stops.find((candidate) => candidate.id === waypoint.stopId);
    return stop ? `Arrêt ${stop.code} — ${stop.name}` : `Arrêt ${waypoint.stopId}`;
  }
  const checkpoint = checkpoints.find((candidate) => candidate.id === waypoint.checkpointId);
  return checkpoint
    ? `Checkpoint ${checkpoint.code} — ${checkpoint.name}`
    : `Checkpoint ${waypoint.checkpointId}`;
}

function VersionSummary({ version }: { version: NetworkRouteVersion }) {
  return (
    <li>
      <strong>Version {version.version}</strong>{' '}
      <span className="et-tag">{VERSION_LABELS[version.status]}</span>
      {' — '}
      {version.waypoints.length} waypoint{version.waypoints.length > 1 ? 's' : ''}
      {version.publishedAt ? (
        <span className="et-hint">
          {' '}
          · publiée le {new Date(version.publishedAt).toLocaleString('fr-FR')}
        </span>
      ) : null}
    </li>
  );
}

export function RouteEditor({
  route,
  stops,
  checkpoints,
  canManage,
  busy,
  run,
  onReload,
}: {
  route: NetworkRouteDetail;
  stops: readonly NetworkStop[];
  checkpoints: readonly NetworkCheckpoint[];
  canManage: boolean;
  busy: boolean;
  run: Run;
  onReload: () => Promise<void>;
}) {
  const stopSelectId = useId();
  const checkpointSelectId = useId();
  const draft = route.versions.find((version) => version.status === 'DRAFT');
  const [items, setItems] = useState<EditorWaypoint[]>([]);
  const [stopId, setStopId] = useState('');
  const [checkpointId, setCheckpointId] = useState('');

  useEffect(() => {
    setItems(draft ? toInput(draft) : []);
  }, [draft]);

  const move = (index: number, offset: -1 | 1) => {
    setItems((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      const moving = reordered[index];
      const replaced = reordered[target];
      if (!moving || !replaced) return current;
      reordered[index] = replaced;
      reordered[target] = moving;
      return reordered;
    });
  };

  const addStop = () => {
    if (!stopId) return;
    setItems((current) => [
      ...current,
      {
        key: `stop-${stopId}-${Date.now()}`,
        value: { kind: 'STOP', stopId, boardingAllowed: true, alightingAllowed: true },
      },
    ]);
    setStopId('');
  };

  const addCheckpoint = () => {
    if (!checkpointId) return;
    setItems((current) => [
      ...current,
      {
        key: `checkpoint-${checkpointId}-${Date.now()}`,
        value: { kind: 'CHECKPOINT', checkpointId },
      },
    ]);
    setCheckpointId('');
  };

  const save = async () => {
    if (!draft) return;
    const ok = await run(
      () =>
        auth.admin.network.replaceWaypoints(
          route.id,
          draft.id,
          items.map((item) => item.value),
        ),
      `Ordre de la version ${draft.version} enregistré.`,
    );
    if (ok) await onReload();
  };

  const publish = async () => {
    if (!draft) return;
    const ok = await run(
      () => auth.admin.network.publishVersion(route.id, draft.id),
      `Version ${draft.version} publiée.`,
    );
    if (ok) await onReload();
  };

  const createDraft = async () => {
    const ok = await run(
      () => auth.admin.network.createVersion(route.id),
      'Nouvelle version brouillon créée.',
    );
    if (ok) await onReload();
  };

  return (
    <section aria-labelledby="route-detail-title" className="et-network-panel">
      <h3 id="route-detail-title">
        {route.code} — {route.name}
      </h3>
      <h4>Versions</h4>
      {route.versions.length ? (
        <ol className="et-network-versions">
          {[...route.versions]
            .sort((left, right) => right.version - left.version)
            .map((version) => (
              <VersionSummary key={version.id} version={version} />
            ))}
        </ol>
      ) : (
        <p>Aucune version.</p>
      )}

      {canManage && !draft ? (
        <button
          type="button"
          className="et-button"
          disabled={busy}
          onClick={() => void createDraft()}
        >
          Créer un brouillon pour {route.code}
        </button>
      ) : null}

      {draft ? (
        <section aria-labelledby="draft-editor-title">
          <h4 id="draft-editor-title">Édition du brouillon version {draft.version}</h4>
          {canManage ? (
            <>
              <div className="et-network-adders">
                <div className="et-field">
                  <label htmlFor={stopSelectId}>Arrêt à ajouter</label>
                  <select
                    id={stopSelectId}
                    className="et-select"
                    value={stopId}
                    onChange={(event) => setStopId(event.target.value)}
                  >
                    <option value="">Choisir un arrêt</option>
                    {stops
                      .filter((stop) => stop.active)
                      .map((stop) => (
                        <option key={stop.id} value={stop.id}>
                          {stop.code} — {stop.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busy || !stopId}
                    onClick={addStop}
                  >
                    Ajouter l’arrêt sélectionné
                  </button>
                </div>
                <div className="et-field">
                  <label htmlFor={checkpointSelectId}>Checkpoint à ajouter</label>
                  <select
                    id={checkpointSelectId}
                    className="et-select"
                    value={checkpointId}
                    onChange={(event) => setCheckpointId(event.target.value)}
                  >
                    <option value="">Choisir un checkpoint</option>
                    {checkpoints
                      .filter((checkpoint) => checkpoint.active)
                      .map((checkpoint) => (
                        <option key={checkpoint.id} value={checkpoint.id}>
                          {checkpoint.code} — {checkpoint.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busy || !checkpointId}
                    onClick={addCheckpoint}
                  >
                    Ajouter le checkpoint sélectionné
                  </button>
                </div>
              </div>

              <ol
                className="et-network-waypoints"
                aria-label={`Waypoints du brouillon ${draft.version}`}
              >
                {items.map((item, index) => {
                  const label = waypointLabel(item.value, stops, checkpoints);
                  return (
                    <li key={item.key}>
                      <strong>{label}</strong>
                      {item.value.kind === 'STOP' ? (
                        <span className="et-actions">
                          <label>
                            <input
                              type="checkbox"
                              checked={item.value.boardingAllowed}
                              onChange={(event) =>
                                setItems((current) =>
                                  current.map((candidate) =>
                                    candidate.key === item.key && candidate.value.kind === 'STOP'
                                      ? {
                                          ...candidate,
                                          value: {
                                            ...candidate.value,
                                            boardingAllowed: event.target.checked,
                                          },
                                        }
                                      : candidate,
                                  ),
                                )
                              }
                            />{' '}
                            Embarquement
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={item.value.alightingAllowed}
                              onChange={(event) =>
                                setItems((current) =>
                                  current.map((candidate) =>
                                    candidate.key === item.key && candidate.value.kind === 'STOP'
                                      ? {
                                          ...candidate,
                                          value: {
                                            ...candidate.value,
                                            alightingAllowed: event.target.checked,
                                          },
                                        }
                                      : candidate,
                                  ),
                                )
                              }
                            />{' '}
                            Descente
                          </label>
                        </span>
                      ) : (
                        <span className="et-hint"> Passage uniquement</span>
                      )}
                      <div className="et-actions">
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy || index === 0}
                          aria-label={`Monter ${label}`}
                          onClick={() => move(index, -1)}
                        >
                          Monter
                        </button>
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy || index === items.length - 1}
                          aria-label={`Descendre ${label}`}
                          onClick={() => move(index, 1)}
                        >
                          Descendre
                        </button>
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy}
                          aria-label={`Retirer ${label}`}
                          onClick={() =>
                            setItems((current) =>
                              current.filter((candidate) => candidate.key !== item.key),
                            )
                          }
                        >
                          Retirer
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {items.length === 0 ? <p>Aucun waypoint dans ce brouillon.</p> : null}
              <div className="et-actions">
                <button
                  type="button"
                  className="et-button"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Enregistrer l’ordre des waypoints
                </button>
                <button
                  type="button"
                  className="et-button et-button--secondary"
                  disabled={busy}
                  onClick={() => void publish()}
                >
                  Publier la version {draft.version}
                </button>
              </div>
            </>
          ) : (
            <ol aria-label={`Waypoints du brouillon ${draft.version}`}>
              {toInput(draft).map((item) => (
                <li key={item.key}>{waypointLabel(item.value, stops, checkpoints)}</li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </section>
  );
}
