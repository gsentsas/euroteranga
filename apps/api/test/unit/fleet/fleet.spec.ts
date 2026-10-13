import { describe, expect, it } from 'vitest';
import {
  vehicleCreateSchema,
  vehicleStatusSchema,
  vehicleUpdateSchema,
} from '../../../src/fleet/fleet.dto.js';
import { isAllowedVehicleTransition } from '../../../src/fleet/vehicle-lifecycle.js';

const STATUSES = ['PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
const ALLOWED = new Set([
  'PLANNED>ACTIVE',
  'PLANNED>RETIRED',
  'ACTIVE>OUT_OF_SERVICE',
  'ACTIVE>RETIRED',
  'OUT_OF_SERVICE>ACTIVE',
  'OUT_OF_SERVICE>RETIRED',
]);

describe('vehicle lifecycle matrix', () => {
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(isAllowedVehicleTransition(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
  });
});

describe('vehicle input validation', () => {
  const base = { code: ' bus_a01 ', manufacturer: ' Constructeur ', model: 'Modèle' };

  it('normalizes code, VIN and plate without inventing a plate format', () => {
    const parsed = vehicleCreateSchema.parse({
      ...base,
      vin: ' zzz1234567890abcd ',
      registrationPlate: '  test   plaque z ',
      registrationCountryId: '01900000-0000-7000-8000-000000000001',
      modelYear: 2020,
    });
    expect(parsed).toMatchObject({
      code: 'BUS_A01',
      vin: 'ZZZ1234567890ABCD',
      registrationPlate: 'TEST PLAQUE Z',
      manufacturer: 'Constructeur',
    });
    // A non-Latin plate is accepted: formats differ per country.
    expect(vehicleCreateSchema.safeParse({ ...base, registrationPlate: 'ب TEST' }).success).toBe(
      true,
    );
  });

  it.each([
    ['VIN with I/O/Q', { vin: 'ZZZ12345678901IOQ' }],
    ['VIN of 16 characters', { vin: 'ZZZ1234567890ABC' }],
    ['plate over 16 characters', { registrationPlate: 'A'.repeat(17) }],
    ['plate with a control character', { registrationPlate: 'TEST\u0007Z' }],
    ['model year before 1950', { modelYear: 1949 }],
    ['model year two years ahead', { modelYear: new Date().getUTCFullYear() + 2 }],
    ['code with a space', { code: 'BUS A01' }],
    ['status on creation', { status: 'ACTIVE' }],
  ])('rejects %s', (_label, override) => {
    expect(vehicleCreateSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  it('never accepts status or retiredAt in the general update', () => {
    expect(vehicleUpdateSchema.safeParse({ status: 'RETIRED' }).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ retiredAt: new Date().toISOString() }).success).toBe(
      false,
    );
    expect(vehicleUpdateSchema.safeParse({}).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ model: 'Autre' }).success).toBe(true);
  });

  it('requires a reason and never targets PLANNED', () => {
    expect(
      vehicleStatusSchema.safeParse({ status: 'ACTIVE', reason: 'Mise en service' }).success,
    ).toBe(true);
    expect(vehicleStatusSchema.safeParse({ status: 'ACTIVE' }).success).toBe(false);
    expect(vehicleStatusSchema.safeParse({ status: 'ACTIVE', reason: '  ' }).success).toBe(false);
    expect(vehicleStatusSchema.safeParse({ status: 'PLANNED', reason: 'Retour' }).success).toBe(
      false,
    );
  });
});
