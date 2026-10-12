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
  // PR-02 authentication material.
  'totp',
  'otp',
  'recoverycode',
  'csrf',
  'challenge',
  'sessiontoken',
];

const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function isWhitespace(code: number): boolean {
  return code <= 32;
}

function isAuthorityTerminator(code: number): boolean {
  return (
    isWhitespace(code) ||
    code === 47 || // /
    code === 63 || // ?
    code === 35 || // #
    code === 34 || // "
    code === 39 || // '
    code === 60 || // <
    code === 62 || // >
    code === 41 || // )
    code === 93 || // ]
    code === 125 // }
  );
}

function redactUriCredentials(value: string): string {
  let output = '';
  let cursor = 0;
  let scan = 0;

  while (scan < value.length) {
    const marker = value.indexOf('://', scan);
    if (marker === -1) break;

    const authorityStart = marker + 3;
    let authorityEnd = authorityStart;
    while (
      authorityEnd < value.length &&
      !isAuthorityTerminator(value.charCodeAt(authorityEnd))
    ) {
      authorityEnd += 1;
    }

    const at = value.lastIndexOf('@', authorityEnd - 1);
    if (at >= authorityStart) {
      output += value.slice(cursor, authorityStart);
      output += REDACTED;
      output += value.slice(at, authorityEnd);
      cursor = authorityEnd;
      scan = authorityEnd;
      continue;
    }

    output += value.slice(cursor, authorityStart);
    cursor = authorityStart;
    scan = authorityStart;
  }

  return output + value.slice(cursor);
}

function isWordChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}

function isAuthTokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 46 || // .
    code === 95 || // _
    code === 126 || // ~
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 45 // -
  );
}

function redactAuthorizationCredentials(value: string): string {
  const lower = value.toLowerCase();
  let output = '';
  let cursor = 0;
  let scan = 0;

  while (scan < value.length) {
    const bearer = lower.indexOf('bearer ', scan);
    const basic = lower.indexOf('basic ', scan);

    let index = bearer;
    let prefixLength = 7;
    if (index === -1 || (basic !== -1 && basic < index)) {
      index = basic;
      prefixLength = 6;
    }
    if (index === -1) break;

    if (index > 0 && isWordChar(value.charCodeAt(index - 1))) {
      scan = index + 1;
      continue;
    }

    const tokenStart = index + prefixLength;
    let tokenEnd = tokenStart;
    while (tokenEnd < value.length && isAuthTokenChar(value.charCodeAt(tokenEnd))) {
      tokenEnd += 1;
    }

    if (tokenEnd === tokenStart) {
      scan = tokenStart;
      continue;
    }

    output += value.slice(cursor, tokenStart);
    output += REDACTED;
    cursor = tokenEnd;
    scan = tokenEnd;
  }

  return output + value.slice(cursor);
}

function isQueryValueTerminator(code: number): boolean {
  return (
    isWhitespace(code) ||
    code === 38 || // &
    code === 35 || // #
    code === 34 || // "
    code === 39 // '
  );
}

function redactTotpSecretQuery(value: string): string {
  const lower = value.toLowerCase();
  let output = '';
  let cursor = 0;
  let scan = 0;

  while (scan < value.length) {
    const question = lower.indexOf('?secret=', scan);
    const ampersand = lower.indexOf('&secret=', scan);

    let index = question;
    if (index === -1 || (ampersand !== -1 && ampersand < index)) index = ampersand;
    if (index === -1) break;

    const secretStart = index + 8;
    let secretEnd = secretStart;
    while (
      secretEnd < value.length &&
      !isQueryValueTerminator(value.charCodeAt(secretEnd))
    ) {
      secretEnd += 1;
    }

    if (secretEnd === secretStart) {
      scan = secretStart;
      continue;
    }

    output += value.slice(cursor, secretStart);
    output += REDACTED;
    cursor = secretEnd;
    scan = secretEnd;
  }

  return output + value.slice(cursor);
}

/**
 * Removes credentials embedded in free text without attacker-controlled
 * regular expressions. Each scanner advances monotonically, making runtime
 * linear in the input length.
 */
export function redactString(value: string): string {
  return redactTotpSecretQuery(
    redactAuthorizationCredentials(redactUriCredentials(value)),
  );
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
