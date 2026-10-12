/**
 * Email normalisation policy (documented in docs/security/authentication.md):
 * trim surrounding whitespace, apply Unicode NFC, lowercase the whole address.
 * No provider-specific rewriting (no Gmail dot or "+tag" removal): two
 * addresses that differ that way are two different addresses.
 *
 * Format validation happens at the HTTP boundary (zod) before this runs.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

/** Display form: trimmed and NFC-normalised, case preserved. */
export function displayEmail(email: string): string {
  return email.trim().normalize('NFC');
}
