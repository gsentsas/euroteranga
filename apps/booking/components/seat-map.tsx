'use client';

import type { BookingAvailability } from '@euroteranga/auth-client';
import { KIND_LABELS } from './format';

/**
 * The trip's historical seat map (PR-07), deck by deck. Only free SEAT cells
 * are selectable; other cells are shown for orientation. Availability is the
 * server's, for every segment of the chosen journey.
 */
export function SeatMapPicker({
  availability,
  selected,
  onToggle,
  maxReached,
}: {
  availability: BookingAvailability;
  selected: ReadonlySet<string>;
  onToggle: (cellId: string) => void;
  maxReached: boolean;
}) {
  const decks = [...new Set(availability.cells.map((cell) => cell.deck))].sort((a, b) => a - b);
  return (
    <div className="et-booking-decks">
      {decks.map((deck) => {
        const cells = availability.cells.filter((cell) => cell.deck === deck);
        const columns = Math.max(...cells.map((cell) => cell.column));
        return (
          <div key={deck} role="group" aria-label={`Pont ${deck}`} className="et-booking-deck">
            <p className="et-hint">Pont {deck}</p>
            <div
              className="et-booking-grid"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(2.75rem, 1fr))` }}
            >
              {cells.map((cell) => {
                const position = { gridRow: cell.row, gridColumn: cell.column };
                if (cell.kind !== 'SEAT') {
                  return (
                    <span key={cell.id} className="et-booking-cell" style={position}>
                      {KIND_LABELS[cell.kind]}
                    </span>
                  );
                }
                const isSelected = selected.has(cell.id);
                const free = cell.available === true;
                return (
                  <button
                    key={cell.id}
                    type="button"
                    className="et-booking-seat"
                    style={position}
                    aria-pressed={isSelected}
                    aria-label={`Siège ${cell.seatLabel ?? '?'}, ${free ? 'disponible' : 'indisponible'}`}
                    disabled={!free || (!isSelected && maxReached)}
                    onClick={() => onToggle(cell.id)}
                  >
                    {cell.seatLabel}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
