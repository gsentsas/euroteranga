/**
 * Layout rules for a complete set of cells, shared by cell replacement and
 * publication. PostgreSQL enforces the same rules (CHECK constraints and
 * unique indexes); this copy gives callers precise public errors.
 */
export type SeatMapCellKind = 'SEAT' | 'AISLE' | 'DRIVER' | 'DOOR' | 'TOILET' | 'STAIRS' | 'OTHER';

export interface CellInput {
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel?: string | null | undefined;
}

export interface NormalizedCell {
  deck: number;
  row: number;
  column: number;
  kind: SeatMapCellKind;
  seatLabel: string | null;
}

export type CellsCheck = { ok: true; cells: NormalizedCell[] } | { ok: false; message: string };

const position = (cell: CellInput) => `pont ${cell.deck}, rang ${cell.row}, colonne ${cell.column}`;

export function checkCells(cells: readonly CellInput[]): CellsCheck {
  const positions = new Set<string>();
  const labels = new Set<string>();
  const normalized: NormalizedCell[] = [];
  for (const cell of cells) {
    const key = `${cell.deck}:${cell.row}:${cell.column}`;
    if (positions.has(key)) {
      return { ok: false, message: `La position ${position(cell)} est utilisée deux fois.` };
    }
    positions.add(key);
    const label = cell.seatLabel ?? null;
    if (cell.kind === 'SEAT') {
      if (!label) return { ok: false, message: `Le siège en ${position(cell)} n’a pas de numéro.` };
      if (labels.has(label)) {
        return { ok: false, message: `Le numéro de siège ${label} est utilisé deux fois.` };
      }
      labels.add(label);
    } else if (label) {
      return {
        ok: false,
        message: `Seuls les sièges portent un numéro (${position(cell)}).`,
      };
    }
    normalized.push({
      deck: cell.deck,
      row: cell.row,
      column: cell.column,
      kind: cell.kind,
      seatLabel: label,
    });
  }
  normalized.sort((a, b) => a.deck - b.deck || a.row - b.row || a.column - b.column);
  return { ok: true, cells: normalized };
}

/** Capacity is always computed: the number of SEAT cells. */
export function seatCountOf(cells: readonly { kind: string }[]): number {
  return cells.filter((cell) => cell.kind === 'SEAT').length;
}
