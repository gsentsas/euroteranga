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

const KIND_CLASS: Record<SeatMapCellKind, string> = {
  SEAT: 'ops-seatmap-cell--seat',
  AISLE: 'ops-seatmap-cell--aisle',
  DRIVER: 'ops-seatmap-cell--driver',
  DOOR: 'ops-seatmap-cell--door',
  TOILET: 'ops-seatmap-cell--toilet',
  STAIRS: 'ops-seatmap-cell--stairs',
  OTHER: 'ops-seatmap-cell--other',
};

/**
 * Visual reading aid for the physical layout. Commercial availability is
 * deliberately not represented here; the accessible table remains the
 * authoritative textual view of every cell.
 */
export function SeatMapPreview({ cells, label }: { cells: readonly PreviewCell[]; label: string }) {
  const decks = [...new Set(cells.map((cell) => cell.deck))].sort((a, b) => a - b);
  if (decks.length === 0) return <p className="ops-seatmap-empty">Aucune cellule.</p>;

  return (
    <div className="ops-seatmap-preview">
      <div className="ops-seatmap-preview__legend" aria-label="Légende du plan">
        {(['SEAT', 'AISLE', 'DRIVER', 'DOOR', 'TOILET', 'STAIRS', 'OTHER'] as SeatMapCellKind[]).map(
          (kind) => (
            <span key={kind}>
              <i className={`ops-seatmap-legend-swatch ${KIND_CLASS[kind]}`} aria-hidden="true" />
              {KIND_LABELS[kind]}
            </span>
          ),
        )}
      </div>

      <div className="ops-seatmap-preview__decks">
        {decks.map((deck) => {
          const deckCells = cells.filter((cell) => cell.deck === deck);
          const columns = Math.max(...deckCells.map((cell) => cell.column));
          const rows = Math.max(...deckCells.map((cell) => cell.row));

          return (
            <section key={deck} className="ops-seatmap-deck-card">
              <div className="ops-seatmap-deck-card__heading">
                <span>Pont {deck}</span>
                <small>
                  {rows} rang{rows > 1 ? 's' : ''} · {columns} colonne{columns > 1 ? 's' : ''}
                </small>
              </div>
              <div className="ops-seatmap-bus-shell">
                <div className="ops-seatmap-bus-shell__nose" aria-hidden="true" />
                <div
                  className="et-seatmap-deck ops-seatmap-grid"
                  role="group"
                  aria-label={`Aperçu ${label}, pont ${deck}`}
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(2.5rem, 1fr))` }}
                >
                  {deckCells.map((cell) => (
                    <div
                      key={`${cell.row}-${cell.column}`}
                      className={`et-seatmap-cell ops-seatmap-cell ${KIND_CLASS[cell.kind]}`}
                      style={{ gridRow: cell.row, gridColumn: cell.column }}
                      title={`${KIND_LABELS[cell.kind]}${cell.seatLabel ? ` ${cell.seatLabel}` : ''} — rang ${cell.row}, colonne ${cell.column}`}
                    >
                      {cell.kind === 'SEAT' ? cell.seatLabel : KIND_LABELS[cell.kind]}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
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
