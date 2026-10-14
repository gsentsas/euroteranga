import { describe, expect, it } from 'vitest';
import { ageOn, journeyCountries, localDate } from '../../../src/compliance/compliance-facts.js';

const birth = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe('compliance facts derived from server data', () => {
  it('computes completed years on the travel date, counting the birthday itself', () => {
    expect(ageOn(birth('2012-06-16'), '2030-06-15')).toBe(17);
    expect(ageOn(birth('2012-06-16'), '2030-06-16')).toBe(18);
    expect(ageOn(birth('2012-06-16'), '2030-06-17')).toBe(18);
    expect(ageOn(birth('2012-07-01'), '2030-06-30')).toBe(17);
    expect(ageOn(birth('2012-02-29'), '2030-02-28')).toBe(17);
    expect(ageOn(birth('2012-02-29'), '2030-03-01')).toBe(18);
  });

  it('derives origin, destination and ordered transit countries from the booked segment', () => {
    expect(journeyCountries(['QA', 'QA', 'QT', 'QB', 'QB'])).toEqual({
      origin: 'QA',
      destination: 'QB',
      transit: ['QT'],
    });
    // A loop through another country and back counts that country as transit.
    expect(journeyCountries(['QA', 'QT', 'QA'])).toEqual({
      origin: 'QA',
      destination: 'QA',
      transit: ['QT'],
    });
    expect(journeyCountries(['QA', 'QA'])).toEqual({
      origin: 'QA',
      destination: 'QA',
      transit: [],
    });
    // Interior countries keep route order and appear once.
    expect(journeyCountries(['QA', 'QT', 'QU', 'QT', 'QB']).transit).toEqual(['QT', 'QU']);
    expect(journeyCountries(['QA', 'QB']).transit).toEqual([]);
  });

  it('uses the local calendar date of the stop time zone', () => {
    const instant = new Date('2030-06-15T23:30:00.000Z');
    expect(localDate(instant, 'Etc/UTC')).toBe('2030-06-15');
    expect(localDate(instant, 'Africa/Dakar')).toBe('2030-06-15');
    expect(localDate(instant, 'Europe/Paris')).toBe('2030-06-16');
    expect(localDate(instant, 'America/New_York')).toBe('2030-06-15');
  });
});
