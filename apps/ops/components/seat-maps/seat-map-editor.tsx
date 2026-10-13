'use client';

import type { AdminSeatMap, AdminSeatMapVersion, SeatMapCellKind } from '@euroteranga/auth-client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { KIND_LABELS, seatsLabel } from './seat-map-format';
import { SeatMapCellsTable, SeatMapPreview } from './seat-map-preview';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface EditorCell {
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel: string | null;
}

const sortCells = (cells: EditorCell[]) =>
  [...cells].sort((a, b) => a.deck - b.deck || a.row - b.row || a.column - b.column);

const toEditor = (version: AdminSeatMapVersion): EditorCell[] =>
  sortCells(
    version.cells.map(({ deck, row, column, kind, seatLabel }) => ({
      deck,
      row,
      column,
      kind,
      seatLabel,
    })),
  );

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="et-input"
        type="number"
        required
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * Deterministic editing of a DRAFT layout: each cell is added with its deck,
 * row, column, kind and (for seats) label. The complete layout is saved in
 * one atomic replacement; publication uses the saved layout only.
 */
export function SeatMapDraftEditor({
  seatMap,
  draft,
  run,
  busy,
  onSaved,
}: {
  seatMap: AdminSeatMap;
  draft: AdminSeatMapVersion;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const kindId = useId();
  const labelId = useId();
  const [cells, setCells] = useState<EditorCell[]>([]);
  const [deck, setDeck] = useState('1');
  const [row, setRow] = useState('1');
  const [column, setColumn] = useState('1');
  const [kind, setKind] = useState<SeatMapCellKind>('SEAT');
  const [seatLabel, setSeatLabel] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setCells(toEditor(draft));
  }, [draft]);

  const saved = JSON.stringify(toEditor(draft));
  const dirty = JSON.stringify(cells) !== saved;
  const seatCount = cells.filter((cell) => cell.kind === 'SEAT').length;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const next: EditorCell = {
      deck: Number(deck),
      row: Number(row),
      column: Number(column),
      kind,
      seatLabel: kind === 'SEAT' ? seatLabel.trim().toUpperCase() : null,
    };
    if (
      cells.some(
        (cell) => cell.deck === next.deck && cell.row === next.row && cell.column === next.column,
      )
    ) {
      setLocalError('Cette position est déjà occupée.');
      return;
    }
    if (next.seatLabel && cells.some((cell) => cell.seatLabel === next.seatLabel)) {
      setLocalError(`Le numéro ${next.seatLabel} est déjà utilisé.`);
      return;
    }
    setLocalError(null);
    setCells((current) => sortCells([...current, next]));
    setSeatLabel('');
    setColumn(String(Math.min(20, Number(column) + 1)));
  };

  const save = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.replaceCells(seatMap.id, draft.id, { cells }),
      `Cellules de la version ${draft.version} enregistrées.`,
    );
    if (ok) await onSaved();
  };

  const publish = async () => {
    const ok = await run(
      () => auth.admin.seatMaps.publishVersion(seatMap.id, draft.id),
      `Version ${draft.version} publiée.`,
    );
    if (ok) await onSaved();
  };

  return (
    <section aria-labelledby="seat-map-draft-title" className="et-network-panel">
      <h3 id="seat-map-draft-title">Édition du brouillon version {draft.version}</h3>
      <form
        className="et-form et-network-form"
        aria-label={`Ajouter une cellule à la version ${draft.version}`}
        onSubmit={add}
      >
        <div className="et-network-adders">
          <NumberInput label="Pont" value={deck} min={1} max={4} onChange={setDeck} />
          <NumberInput label="Rang" value={row} min={1} max={100} onChange={setRow} />
          <NumberInput label="Colonne" value={column} min={1} max={20} onChange={setColumn} />
          <div className="et-field">
            <label htmlFor={kindId}>Type de cellule</label>
            <select
              id={kindId}
              className="et-select"
              value={kind}
              onChange={(event) => setKind(event.target.value as SeatMapCellKind)}
            >
              {(Object.keys(KIND_LABELS) as SeatMapCellKind[]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          {kind === 'SEAT' ? (
            <div className="et-field">
              <label htmlFor={labelId}>Numéro du siège</label>
              <input
                id={labelId}
                className="et-input"
                required
                maxLength={8}
                pattern="[A-Za-z0-9][A-Za-z0-9-]{0,7}"
                value={seatLabel}
                onChange={(event) => setSeatLabel(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        {localError ? (
          <p className="et-error" role="status">
            {localError}
          </p>
        ) : null}
        <button type="submit" className="et-button et-button--secondary" disabled={busy}>
          Ajouter la cellule
        </button>
      </form>

      <p data-testid="draft-seat-count">Capacité : {seatsLabel(seatCount)}</p>
      <SeatMapPreview cells={cells} label={`du brouillon version ${draft.version}`} />
      <SeatMapCellsTable
        cells={cells}
        caption={`Cellules du brouillon version ${draft.version}`}
        busy={busy}
        onRemove={(index) =>
          setCells((current) => current.filter((_, position) => position !== index))
        }
      />
      <div className="et-actions">
        <button
          type="button"
          className="et-button"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Enregistrer les cellules
        </button>
        <button
          type="button"
          className="et-button et-button--secondary"
          disabled={busy || dirty || seatCount === 0 || !seatMap.active}
          onClick={() => void publish()}
        >
          Publier la version {draft.version}
        </button>
      </div>
      {dirty ? (
        <p className="et-hint">
          Modifications non enregistrées : enregistrez les cellules avant de publier.
        </p>
      ) : null}
      {!dirty && seatCount === 0 ? (
        <p className="et-hint">Une version publiée doit compter au moins un siège.</p>
      ) : null}
    </section>
  );
}
