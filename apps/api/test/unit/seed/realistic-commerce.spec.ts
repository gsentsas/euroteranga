import { describe, expect, it } from 'vitest';
import {
  chooseSeats,
  seededRandom,
  travellerOf,
} from '../../../src/seed/realistic/realistic-commerce.js';
import {
  REALISTIC_BOOKING_PLAN,
  realisticCustomerEmail,
} from '../../../src/seed/realistic/realistic-dataset.js';

/** A 13-row coach: A B | aisle | C D, every seat free unless listed. */
function coach(taken: readonly string[] = []) {
  const cells = [];
  for (let row = 1; row <= 13; row += 1) {
    for (const [letter, column] of [
      ['A', 1],
      ['B', 2],
      ['C', 4],
      ['D', 5],
    ] as const) {
      const seatLabel = `${row}${letter}`;
      cells.push({ id: seatLabel, row, column, seatLabel, available: !taken.includes(seatLabel) });
    }
  }
  return cells;
}

describe('realistic seed: seats and travellers', () => {
  it('is deterministic for a given seed', () => {
    const first = seededRandom('ET-PILOT-PARDKR-20301102#out0-01');
    const second = seededRandom('ET-PILOT-PARDKR-20301102#out0-01');
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(seededRandom('other')()).not.toBe(seededRandom('ET-PILOT')());
  });

  it('seats a party side by side, never on a taken seat, and a lone traveller by a window', () => {
    const taken = ['1A', '1B', '2C', '2D', '5A'];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const random = seededRandom(`party-${attempt}`);
      const couple = chooseSeats(coach(taken), 2, random)!;
      expect(couple).toHaveLength(2);
      expect(couple.some((seat) => taken.includes(seat.seatLabel))).toBe(false);
      expect(couple[0]!.row).toBe(couple[1]!.row);
      expect(Math.abs(couple[0]!.column - couple[1]!.column)).toBe(1);
      const alone = chooseSeats(coach(taken), 1, random)!;
      expect([1, 5]).toContain(alone[0]!.column);
      const family = chooseSeats(coach(taken), 4, random)!;
      expect(new Set(family.map((seat) => seat.id)).size).toBe(4);
      expect(family.some((seat) => taken.includes(seat.seatLabel))).toBe(false);
    }
  });

  it('refuses a party larger than the free seats', () => {
    const almostFull = coach(
      coach()
        .map((cell) => cell.seatLabel)
        .slice(1),
    );
    expect(chooseSeats(almostFull, 2, seededRandom('full'))).toBeNull();
    expect(chooseSeats(almostFull, 1, seededRandom('full'))).toHaveLength(1);
  });

  it('invents fictitious travellers only: an initial, a plausible age, one family nationality', () => {
    const party = [0, 1, 2, 3].map((index) => travellerOf('out0-03', index, 4));
    expect(new Set(party.map((traveller) => traveller.familyName)).size).toBe(1);
    expect(party[0]!.familyName).toMatch(/^[A-Z]\.$/);
    expect(new Set(party.map((traveller) => traveller.nationalityIso2)).size).toBe(1);
    expect(new Set(party.map((traveller) => traveller.givenName)).size).toBe(4);
    // The last travellers of a family of three or more are children.
    expect(Number(party[3]!.dateOfBirth.slice(0, 4))).toBeGreaterThanOrEqual(2010);
    expect(travellerOf('out0-03', 0, 4)).toEqual(party[0]);
  });

  it('plans about 85, 60, 30 and 6 percent on a 53-seat coach, at most 8 seats per hold', () => {
    const seats = (direction: 'outbound' | 'inbound', position: number) =>
      REALISTIC_BOOKING_PLAN[direction][position]!.filter(
        (group) => group.state === 'confirmed',
      ).reduce((sum, group) => sum + group.seats, 0);
    expect([seats('outbound', 0), seats('inbound', 0), seats('outbound', 1)]).toEqual([45, 32, 16]);
    expect(seats('inbound', 1)).toBe(3);
    const groups = Object.values(REALISTIC_BOOKING_PLAN).flat(2);
    expect(groups).toHaveLength(40);
    expect(groups.every((group) => group.seats >= 1 && group.seats <= 8)).toBe(true);
    expect(realisticCustomerEmail('out0-01')).toBe('etr-v1-out0-01@example.test');
  });
});
