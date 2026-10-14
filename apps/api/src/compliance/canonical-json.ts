import { createHash } from 'node:crypto';

/** JSON values the compliance engine fingerprints (no undefined, no functions). */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Deterministic JSON: object keys sorted by code unit, no whitespace, arrays
 * kept in order. The same value always yields the same bytes, whatever the
 * insertion order of its keys.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonicalJson).join(',')}]`;
  }
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`;
}

/** Lowercase hex SHA-256 of the canonical JSON. */
export function fingerprint(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
