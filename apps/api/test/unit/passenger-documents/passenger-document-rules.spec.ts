import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_REFERENCE_PATTERN,
  downloadFilename,
  generateDocumentObjectKey,
  generateDocumentReference,
  generatePassengerReference,
  normalizeDocumentReference,
  normalizePassengerReference,
  PASSENGER_REFERENCE_PATTERN,
  withFreshPassengerReference,
} from '../../../src/passenger-documents/passenger-document-rules.js';

describe('passenger-document identifiers', () => {
  it('generates non-sequential public references using the unambiguous alphabet', () => {
    const passenger = generatePassengerReference(() => 0);
    const document = generateDocumentReference(() => 31);
    expect(passenger).toBe('ETV-000000000000');
    expect(document).toBe('ETD-ZZZZZZZZZZZZ');
    expect(passenger).toMatch(PASSENGER_REFERENCE_PATTERN);
    expect(document).toMatch(DOCUMENT_REFERENCE_PATTERN);
  });

  it('normalizes only valid references', () => {
    expect(normalizePassengerReference(' etv-0123456789ab ')).toBe('ETV-0123456789AB');
    expect(normalizeDocumentReference(' etd-0123456789ab ')).toBe('ETD-0123456789AB');
    expect(normalizePassengerReference('ETV-00000000000I')).toBeNull();
    expect(normalizeDocumentReference('../ETD-000000000000')).toBeNull();
  });

  it('uses exactly 256 random bits for an opaque sharded object key', () => {
    const key = generateDocumentObjectKey(() => Buffer.alloc(32, 0xab));
    expect(key).toBe(`passenger-documents/ab/${'ab'.repeat(32)}`);
    expect(key).not.toContain('passport');
    expect(() => generateDocumentObjectKey(() => Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it('retries reference collisions only, at most three times', async () => {
    let attempts = 0;
    const value = await withFreshPassengerReference(
      async (reference) => {
        attempts += 1;
        if (attempts < 3) throw new Error('collision');
        return reference;
      },
      (error) => (error as Error).message === 'collision',
      () => 'ETV-000000000000',
    );
    expect(value).toBe('ETV-000000000000');
    expect(attempts).toBe(3);
  });

  it('emits only server-generated safe download names', () => {
    expect(downloadFilename('ETD-000000000000', 'application/pdf')).toBe('ETD-000000000000.pdf');
    expect(downloadFilename('ETD-000000000000', 'image/jpeg')).toBe('ETD-000000000000.jpg');
    expect(downloadFilename('ETD-000000000000', 'image/png')).toBe('ETD-000000000000.png');
  });
});
