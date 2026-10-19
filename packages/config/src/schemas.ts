import { z } from 'zod';

export const appEnvSchema = z.enum(['local', 'ci', 'staging', 'production'], {
  error: 'must be one of: local, ci, staging, production',
});

export const httpUrlSchema = z
  .string({ error: 'is required' })
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
    message: 'must be an http(s) URL',
  });

/** Accepts "true"/"false" (and 1/0) from the environment. */
export const booleanFlag = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .transform((value) => value === 'true' || value === '1');

/**
 * Comma-separated list of exact origins. A wildcard is rejected on purpose:
 * future authenticated endpoints must never be reachable from any origin.
 */
export const originListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z.array(
      z.string().refine(
        (origin) => {
          if (origin === '*' || !URL.canParse(origin)) return false;
          const url = new URL(origin);
          return /^https?:$/.test(url.protocol) && url.origin === origin;
        },
        { message: 'each entry must be an exact http(s) origin without path; "*" is not allowed' },
      ),
    ),
  );

/**
 * Problems of a local storage root: it must be absolute, normalized,
 * dedicated, and never a public or upload directory of the web server.
 */
export function localRootProblems(root: string): string[] {
  const problems: string[] = [];
  if (!root.startsWith('/')) problems.push('must be an absolute path');
  // "/tmp/.." or "//" would otherwise resolve to the filesystem root (or
  // hide a public segment) after these textual checks.
  if (root.split('/').some((segment) => segment === '.' || segment === '..') || /\/\//.test(root)) {
    problems.push('must be a normalized path without "." or ".." segments');
  }
  if (root === '/') problems.push('must be a dedicated directory');
  if (/(^|\/)(public|public_html|htdocs|httpdocs|static|uploads)(\/|$)/i.test(root)) {
    problems.push('must not be a public or upload directory');
  }
  return problems;
}

/** True when one directory is the other or contains it (textual, normalized paths). */
export function pathsOverlap(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, '');
  const right = b.replace(/\/+$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
