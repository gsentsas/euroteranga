export const REDACTED = '[REDACTED]';

/**
 * Field names whose values are never written to logs, whatever their content.
 * Matching is case-insensitive and ignores "-" / "_" so that "Set-Cookie",
 * "set_cookie" and "setCookie" are all caught.
 */
const SENSITIVE_KEYS = [
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'xapikey',
  'databaseurl',
  'dsn',
  'connectionstring',
  'privatekey',
  'totpsecret',
];

const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

/**
 * Removes credentials embedded in free text, e.g. a connection string quoted
 * in a driver error message: "postgresql://user:pass@host/db" becomes
 * "postgresql://[REDACTED]@host/db". Bearer tokens are masked as well.
 */
export function redactString(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`);
}

export interface RedactOptions {
  /** Include error stack traces (server logs only, never client responses). */
  includeStack?: boolean;
}

/** Returns a deep, redacted copy of a value that is safe to serialise. */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactValue(value, options, 0, new WeakSet());
}

function redactValue(
  value: unknown,
  options: RedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (options.includeStack && value.stack) serialized.stack = redactString(value.stack);
    return serialized;
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, options, depth + 1, seen);
  }
  return result;
}
