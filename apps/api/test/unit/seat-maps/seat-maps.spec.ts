import { describe, expect, it } from 'vitest';
import { vehicleSeatMapSchema, vehicleUpdateSchema } from '../../../src/fleet/fleet.dto.js';
import { checkCells, seatCountOf, type CellInput } from '../../../src/seat-maps/seat-map-cells.js';
import {
  seatMapCellsSchema,
  seatMapCreateSchema,
  seatMapUpdateSchema,
} from '../../../src/seat-maps/seat-map.dto.js';
import { tripSeatMapSchema } from '../../../src/trips/trip.dto.js';

const layout = (): CellInput[] => [
  { deck: 1, row: 1, column: 1, kind: 'DRIVER' },
  { deck: 1, row: 2, column: 1, kind: 'SEAT', seatLabel: '1A' },
  { deck: 1, row: 2, column: 2, kind: 'AISLE', seatLabel: null },
  { deck: 1, row: 2, column: 3, kind: 'SEAT', seatLabel: '1B' },
];

describe('seat-map layout rules', () => {
  it('accepts a valid layout, sorts it and computes the capacity', () => {
    const result = checkCells([...layout()].reverse());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cells.map((cell) => [cell.row, cell.column])).toEqual([
        [1, 1],
        [2, 1],
        [2, 2],
        [2, 3],
      ]);
      expect(result.cells[2]?.seatLabel).toBeNull();
      expect(seatCountOf(result.cells)).toBe(2);
    }
  });

  it('accepts an empty layout (a draft in progress)', () => {
    expect(checkCells([])).toEqual({ ok: true, cells: [] });
  });

  it.each<[string, CellInput[], RegExp]>([
    [
      'a duplicated position',
      [...layout(), { deck: 1, row: 2, column: 1, kind: 'DOOR' }],
      /utilisée deux fois/,
    ],
    [
      'a duplicated label',
      [...layout(), { deck: 1, row: 3, column: 1, kind: 'SEAT', seatLabel: '1A' }],
      /1A est utilisé deux fois/,
    ],
    [
      'a seat without label',
      [...layout(), { deck: 1, row: 3, column: 1, kind: 'SEAT' }],
      /n’a pas de numéro/,
    ],
    [
      'a labelled aisle',
      [...layout(), { deck: 1, row: 3, column: 1, kind: 'AISLE', seatLabel: 'X' }],
      /Seuls les sièges/,
    ],
  ])('refuses %s', (_label, cells, message) => {
    const result = checkCells(cells);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it('distinguishes the same position on two decks', () => {
    expect(
      checkCells([
        { deck: 1, row: 1, column: 1, kind: 'SEAT', seatLabel: '1A' },
        { deck: 2, row: 1, column: 1, kind: 'SEAT', seatLabel: '21A' },
      ]).ok,
    ).toBe(true);
  });
});

describe('seat-map input validation', () => {
  it('normalizes codes and labels', () => {
    expect(
      seatMapCreateSchema.parse({ code: ' coach_test_a ', name: ' Autocar ', active: true }),
    ).toEqual({
      code: 'COACH_TEST_A',
      name: 'Autocar',
      active: true,
    });
    const cells = seatMapCellsSchema.parse({
      cells: [{ deck: 1, row: 1, column: 1, kind: 'SEAT', seatLabel: ' 12c ' }],
    });
    expect(cells.cells[0]?.seatLabel).toBe('12C');
    expect(seatMapUpdateSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ['deck 0', { deck: 0 }],
    ['deck 5', { deck: 5 }],
    ['row 101', { row: 101 }],
    ['column 21', { column: 21 }],
    ['a fractional row', { row: 1.5 }],
    ['an unknown kind', { kind: 'EMPTY' }],
    ['a pricing class', { seatClass: 'VIP' }],
    ['a label over 8 characters', { seatLabel: 'ABCDEFGHI' }],
  ])('refuses a cell with %s', (_label, override) => {
    expect(
      seatMapCellsSchema.safeParse({
        cells: [{ deck: 1, row: 1, column: 1, kind: 'SEAT', seatLabel: '1A', ...override }],
      }).success,
    ).toBe(false);
  });

  it('keeps seat maps out of the general vehicle update, in dedicated operations', () => {
    expect(
      vehicleUpdateSchema.safeParse({ seatMapVersionId: '01900000-0000-7000-8000-000000000001' })
        .success,
    ).toBe(false);
    for (const schema of [vehicleSeatMapSchema, tripSeatMapSchema]) {
      expect(schema.safeParse({ seatMapVersionId: null }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(
        schema.parse({ seatMapVersionId: null, expectedSeatMapVersionId: null })
          .expectedSeatMapVersionId,
      ).toBeNull();
      expect(schema.safeParse({ seatMapVersionId: 'nope' }).success).toBe(false);
    }
  });
});
