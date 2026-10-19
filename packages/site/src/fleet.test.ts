import { describe, expect, it } from 'vitest';
import {
  AMENITIES,
  fleetVehicles,
  knownAmenities,
  vehicleAnchor,
  vehicleModelLine,
  vehicleTitle,
  type FleetPresentation,
  type SiteVehicle,
} from './fleet.js';

const vehicle = (
  code: string,
  overrides: Partial<Omit<SiteVehicle, 'code'>> = {},
): SiteVehicle => ({
  code,
  name: null,
  manufacturer: 'Setra',
  model: 'S 517 HDH',
  modelYear: null,
  amenities: [],
  seatCount: null,
  ...overrides,
});

const presentation = (
  vehicleCode: string,
  overrides: Partial<Omit<FleetPresentation, 'vehicleCode'>> = {},
): FleetPresentation => ({ vehicleCode, gallery: [], ...overrides });

describe('public fleet helpers (UI-PUBLIC-2)', () => {
  it('keeps only known amenities without exposing a future or invalid API value', () => {
    expect(
      knownAmenities(['WIFI', 'JACUZZI', 'AIR_CONDITIONING', '', 'WHEELCHAIR_ACCESS']),
    ).toEqual(['WIFI', 'AIR_CONDITIONING', 'WHEELCHAIR_ACCESS']);
    expect(knownAmenities([])).toEqual([]);
    expect(AMENITIES.USB_CHARGING).toEqual({ label: 'Prises USB', icon: 'plug' });
  });

  it('uses the CMS order for a listed selection and omits unknown vehicles', () => {
    const teranga01 = vehicle('BUS_01', { name: 'Teranga 01' });
    const teranga02 = vehicle('BUS_02', { name: 'Teranga 02' });
    const second = presentation('BUS_02', { description: 'Le deuxième autocar.' });
    const first = presentation('BUS_01', { mediaId: 'media-01' });

    expect(
      fleetVehicles(
        'listed',
        [second, presentation('RETIRED_OR_UNKNOWN'), first],
        [teranga01, teranga02],
      ),
    ).toEqual([
      { vehicle: teranga02, presentation: second },
      { vehicle: teranga01, presentation: first },
    ]);
  });

  it('puts presented vehicles first for all, then preserves the active fleet order', () => {
    const first = vehicle('BUS_A');
    const second = vehicle('BUS_B');
    const third = vehicle('BUS_C');
    const featured = presentation('BUS_B', { gallery: ['inside'] });

    expect(
      fleetVehicles('all', [featured, presentation('UNKNOWN')], [first, second, third]),
    ).toEqual([
      { vehicle: second, presentation: featured },
      { vehicle: first, presentation: undefined },
      { vehicle: third, presentation: undefined },
    ]);
    expect(fleetVehicles('all', [], null)).toEqual([]);
    expect(fleetVehicles('listed', [featured], [])).toEqual([]);
  });

  it('formats public titles, model lines and stable lowercase anchors', () => {
    const named = vehicle('TERANGA_01', {
      name: 'Teranga 01',
      manufacturer: 'Mercedes-Benz',
      model: 'Tourismo',
      modelYear: 2026,
    });
    const unnamed = vehicle('COACH-02', { manufacturer: 'Setra', model: 'S 531 DT' });

    expect(vehicleTitle(named)).toBe('Teranga 01');
    expect(vehicleTitle(unnamed)).toBe('Setra S 531 DT');
    expect(vehicleModelLine(named)).toBe('Mercedes-Benz Tourismo · 2026');
    expect(vehicleModelLine(unnamed)).toBe('Setra S 531 DT');
    expect(vehicleAnchor(named.code)).toBe('autocar-teranga_01');
    expect(vehicleAnchor(unnamed.code)).toBe('autocar-coach-02');
  });
});
