import { describe, expect, it } from 'vitest';
import {
  permitCreateSchema,
  permitUpdateSchema,
} from '../../../src/regulatory-permits/regulatory-permit.dto.js';
import {
  derivePermitValidity,
  generatePermitReference,
  isAllowedPermitTransition,
  normalizePermitReference,
  withFreshPermitReference,
} from '../../../src/regulatory-permits/regulatory-permit-rules.js';

describe('regulatory permit rules', () => {
  it('generates and normalizes an ETRP Crockford reference', () => {
    expect(generatePermitReference(() => 0)).toBe('ETRP-000000000000');
    expect(generatePermitReference(() => 31)).toBe('ETRP-ZZZZZZZZZZZZ');
    expect(normalizePermitReference(' etrp-0123456789ab ')).toBe('ETRP-0123456789AB');
    expect(normalizePermitReference('ETP-0123456789AB')).toBeNull();
    expect(normalizePermitReference('ETRP-OOOOOOOOOOOO')).toBeNull();
  });

  it('retries only declared reference collisions', async () => {
    let calls = 0;
    await expect(
      withFreshPermitReference(
        async (reference) => {
          calls += 1;
          if (calls < 3) throw new Error('collision');
          return reference;
        },
        (error) => String(error).includes('collision'),
        () => `ETRP-${String(calls).padStart(12, '0')}`,
      ),
    ).resolves.toBe('ETRP-000000000002');
    expect(calls).toBe(3);
  });

  it('derives inclusive validity from an explicit day', () => {
    const active = { status: 'ACTIVE' as const, validFrom: '2030-01-10', validUntil: '2030-01-20' };
    expect(derivePermitValidity({ ...active, status: 'DRAFT' }, '2030-01-15')).toBe('DRAFT');
    expect(derivePermitValidity(active, '2030-01-09')).toBe('NOT_YET_VALID');
    expect(derivePermitValidity(active, '2030-01-10')).toBe('VALID');
    expect(derivePermitValidity(active, '2030-01-20')).toBe('VALID');
    expect(derivePermitValidity(active, '2030-01-21')).toBe('EXPIRED');
    expect(derivePermitValidity({ ...active, status: 'REVOKED' }, '2030-01-09')).toBe('REVOKED');
  });

  it('allows only DRAFT to ACTIVE and ACTIVE to REVOKED', () => {
    const statuses = ['DRAFT', 'ACTIVE', 'REVOKED'] as const;
    const allowed = statuses.flatMap((from) =>
      statuses.filter((to) => isAllowedPermitTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed).toEqual(['DRAFT->ACTIVE', 'ACTIVE->REVOKED']);
  });

  it('validates closed dates, strict scopes and non-empty optimistic updates', () => {
    const base = {
      permitType: 'SYNTHETIC',
      title: 'Autorisation synthétique',
      issuingAuthority: 'Autorité synthétique',
      scope: { type: 'TRIP' as const, tripReference: 'ET-TRIP-1' },
      validFrom: '2030-01-01',
      validUntil: '2030-12-31',
    };
    expect(permitCreateSchema.safeParse(base).success).toBe(true);
    expect(permitCreateSchema.safeParse({ ...base, validUntil: '2029-12-31' }).success).toBe(false);
    expect(permitCreateSchema.safeParse({ ...base, validUntil: undefined }).success).toBe(false);
    expect(
      permitCreateSchema.safeParse({ ...base, scope: { type: 'OPERATOR', tripReference: 'x' } })
        .success,
    ).toBe(false);
    expect(permitUpdateSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(permitUpdateSchema.safeParse({ expectedRevision: 1, title: 'Révision' }).success).toBe(
      true,
    );
  });
});
