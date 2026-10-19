import { describe, expect, it } from 'vitest';
import {
  dayOffset,
  durationLabel,
  journeyItinerary,
  placeKindLabel,
  type PublicItinerary,
  type SitePlace,
} from './itinerary.js';

type PublicWaypoint = PublicItinerary['waypoints'][number];

const stop = (
  routeWaypointId: string,
  locality: string,
  country: { iso2: string; name: string },
  overrides: Partial<PublicWaypoint> = {},
): PublicWaypoint => ({
  routeWaypointId,
  kind: 'STOP',
  name: `${locality} — gare routière`,
  locality,
  timezone: 'Etc/UTC',
  country,
  checkpointType: null,
  plannedArrivalAt: null,
  plannedDepartureAt: null,
  ...overrides,
});

const checkpoint = (
  routeWaypointId: string,
  locality: string,
  country: { iso2: string; name: string },
  checkpointType: string,
): PublicWaypoint => ({
  routeWaypointId,
  kind: 'CHECKPOINT',
  name: `${locality} — passage`,
  locality,
  timezone: 'Etc/UTC',
  country,
  checkpointType,
  plannedArrivalAt: null,
  plannedDepartureAt: null,
});

const countries = {
  france: { iso2: 'FR', name: 'France' },
  spain: { iso2: 'ES', name: 'Espagne' },
  morocco: { iso2: 'MA', name: 'Maroc' },
  mauritania: { iso2: 'MR', name: 'Mauritanie' },
  senegal: { iso2: 'SN', name: 'Sénégal' },
} as const;

const outboundWaypoints: PublicWaypoint[] = [
  stop('wp-paris', 'Paris', countries.france, {
    timezone: 'Europe/Paris',
    plannedDepartureAt: '2030-11-12T07:00:00.000Z',
  }),
  stop('wp-madrid', 'Madrid', countries.spain),
  checkpoint('wp-algeciras', 'Algésiras', countries.spain, 'PORT'),
  checkpoint('wp-tanger', 'Tanger', countries.morocco, 'PORT'),
  stop('wp-nouakchott', 'Nouakchott', countries.mauritania),
  stop('wp-dakar', 'Dakar', countries.senegal, {
    timezone: 'Africa/Dakar',
    plannedArrivalAt: '2030-11-14T00:30:00.000Z',
  }),
];

const itinerary = (
  waypoints: readonly PublicWaypoint[] = outboundWaypoints,
  vehicle: PublicItinerary['vehicle'] = null,
): PublicItinerary => ({ tripId: 'trip-01', vehicle, waypoints });

const place = (overrides: Partial<SitePlace> = {}): SitePlace => ({
  kind: 'STOP',
  name: 'Gare routière',
  locality: 'Paris',
  timezone: 'Europe/Paris',
  country: countries.france,
  checkpointType: null,
  arrivalAt: null,
  departureAt: null,
  ...overrides,
});

describe('public itinerary projection (UI-PUBLIC-2)', () => {
  it('selects the requested journey, preserves waypoint order and deduplicates countries', () => {
    const result = journeyItinerary(itinerary(), 'wp-madrid', 'wp-dakar');

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      tripId: 'trip-01',
      origin: { locality: 'Madrid' },
      destination: { locality: 'Dakar' },
      vehicle: null,
    });
    expect(result?.via.map((waypoint) => waypoint.locality)).toEqual([
      'Algésiras',
      'Tanger',
      'Nouakchott',
    ]);
    expect(result?.countries).toEqual([
      countries.spain,
      countries.morocco,
      countries.mauritania,
      countries.senegal,
    ]);
  });

  it('supports a reverse route when its real waypoint order is Dakar to Paris', () => {
    const reverse = [...outboundWaypoints].reverse();
    const result = journeyItinerary(itinerary(reverse), 'wp-dakar', 'wp-paris');

    expect(result?.origin.locality).toBe('Dakar');
    expect(result?.destination.locality).toBe('Paris');
    expect(result?.via.map((waypoint) => waypoint.locality)).toEqual([
      'Nouakchott',
      'Tanger',
      'Algésiras',
      'Madrid',
    ]);
    expect(result?.countries.map((country) => country.iso2)).toEqual([
      'SN',
      'MR',
      'MA',
      'ES',
      'FR',
    ]);
  });

  it('refuses missing, identical or reversed waypoint ids', () => {
    const source = itinerary();

    expect(journeyItinerary(source, 'missing', 'wp-dakar')).toBeNull();
    expect(journeyItinerary(source, 'wp-paris', 'missing')).toBeNull();
    expect(journeyItinerary(source, 'wp-madrid', 'wp-madrid')).toBeNull();
    expect(journeyItinerary(source, 'wp-dakar', 'wp-paris')).toBeNull();
  });

  it('keeps the assigned vehicle public title and only its known amenities', () => {
    const result = journeyItinerary(
      itinerary(outboundWaypoints, {
        name: 'Teranga 02',
        manufacturer: 'Setra',
        model: 'S 517 HDH',
        amenities: ['AIR_CONDITIONING', 'JACUZZI', 'USB_CHARGING'],
      }),
      'wp-paris',
      'wp-dakar',
    );

    expect(result?.vehicle).toEqual({
      title: 'Teranga 02',
      amenities: ['AIR_CONDITIONING', 'USB_CHARGING'],
    });

    const fallback = journeyItinerary(
      itinerary(outboundWaypoints, {
        name: null,
        manufacturer: 'Mercedes-Benz',
        model: 'Tourismo',
        amenities: [],
      }),
      'wp-paris',
      'wp-dakar',
    );
    expect(fallback?.vehicle).toEqual({ title: 'Mercedes-Benz Tourismo', amenities: [] });
  });
});

describe('itinerary time and label helpers (UI-PUBLIC-2)', () => {
  it('formats positive durations and rejects invalid or non-positive ranges', () => {
    expect(durationLabel('2030-01-01T08:00:00Z', '2030-01-03T00:00:00Z')).toBe('40 h');
    expect(durationLabel('2030-01-01T08:00:00Z', '2030-01-02T22:30:00Z')).toBe('38 h 30');
    expect(durationLabel('2030-01-01T08:00:00Z', '2030-01-01T08:45:00Z')).toBe('45 min');
    expect(durationLabel('invalid', '2030-01-01T08:45:00Z')).toBeNull();
    expect(durationLabel('2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z')).toBeNull();
    expect(durationLabel('2030-01-02T08:00:00Z', '2030-01-01T08:00:00Z')).toBeNull();
  });

  it('counts local calendar days in each place timezone', () => {
    // Both instants fall on 2 January locally despite having different UTC dates.
    expect(
      dayOffset(
        { at: '2030-01-01T23:30:00Z', timeZone: 'Europe/Paris' },
        { at: '2030-01-02T00:30:00Z', timeZone: 'Africa/Dakar' },
      ),
    ).toBe(0);
    expect(
      dayOffset(
        { at: '2030-01-01T23:30:00Z', timeZone: 'Europe/Paris' },
        { at: '2030-01-04T10:00:00Z', timeZone: 'Africa/Dakar' },
      ),
    ).toBe(2);
    // An invalid IANA zone deliberately falls back to UTC, like public date rendering.
    expect(
      dayOffset(
        { at: '2030-01-01T23:30:00Z', timeZone: 'Not/AZone' },
        { at: '2030-01-02T23:30:00Z', timeZone: 'Not/AZone' },
      ),
    ).toBe(1);
  });

  it('labels stops, borders and other public crossings', () => {
    expect(placeKindLabel(place())).toBe('Arrêt');
    expect(placeKindLabel(place({ kind: 'CHECKPOINT', checkpointType: 'BORDER' }))).toBe(
      'Passage de frontière',
    );
    expect(placeKindLabel(place({ kind: 'CHECKPOINT', checkpointType: 'PORT' }))).toBe('Traversée');
  });
});
