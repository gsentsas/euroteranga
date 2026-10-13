'use client';

import type { SeatMapCellKind } from '@euroteranga/auth-client';
import { KIND_LABELS } from './seat-map-format';

interface PreviewCell {
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel: string | null;
}

/**
 * Visual layout, one grid per deck. It is a reading aid only: every cell is
 * also listed in an accessible table next to it. Empty positions are blank.
 */
export function SeatMapPreview({ cells, label }: { cells: readonly PreviewCell[]; label: string }) {
  const decks = [...new Set(cells.map((cell) => cell.deck))].sort((a, b) => a - b);
  if (decks.length === 0) return <p>Aucune cellule.</p>;
  return (
    <div className="et-network-adders">
      {decks.map((deck) => {
        const deckCells = cells.filter((cell) => cell.deck === deck);
        const columns = Math.max(...deckCells.map((cell) => cell.column));
        return (
          <div key={deck}>
            <p className="et-hint">Pont {deck}</p>
            <div
              className="et-seatmap-deck"
              role="group"
              aria-label={`Aperçu ${label}, pont ${deck}`}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(3.25rem, auto))` }}
            >
              {deckCells.map((cell) => (
                <div
                  key={`${cell.row}-${cell.column}`}
                  className={`et-seatmap-cell${cell.kind === 'SEAT' ? ' et-seatmap-cell--seat' : ''}${cell.kind === 'AISLE' ? ' et-seatmap-cell--aisle' : ''}`}
                  style={{ gridRow: cell.row, gridColumn: cell.column }}
                  title={`${KIND_LABELS[cell.kind]}${cell.seatLabel ? ` ${cell.seatLabel}` : ''} — rang ${cell.row}, colonne ${cell.column}`}
                >
                  {cell.kind === 'SEAT' ? cell.seatLabel : KIND_LABELS[cell.kind]}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Accessible list of the cells (the authoritative representation). */
export function SeatMapCellsTable({
  cells,
  caption,
  onRemove,
  busy,
}: {
  cells: readonly PreviewCell[];
  caption: string;
  onRemove?: (index: number) => void;
  busy?: boolean;
}) {
  return (
    <div className="et-table-wrap">
      <table className="et-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Pont</th>
            <th scope="col">Rang</th>
            <th scope="col">Colonne</th>
            <th scope="col">Type</th>
            <th scope="col">Numéro</th>
            {onRemove ? <th scope="col">Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {cells.map((cell, index) => (
            <tr key={`${cell.deck}-${cell.row}-${cell.column}`}>
              <td>{cell.deck}</td>
              <td>{cell.row}</td>
              <td>{cell.column}</td>
              <td>{KIND_LABELS[cell.kind]}</td>
              <td>{cell.seatLabel ?? '—'}</td>
              {onRemove ? (
                <td>
                  <button
                    type="button"
                    className="et-button et-button--secondary"
                    disabled={busy}
                    aria-label={`Retirer la cellule pont ${cell.deck}, rang ${cell.row}, colonne ${cell.column}`}
                    onClick={() => onRemove(index)}
                  >
                    Retirer
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
