import type { z } from 'zod';

/**
 * Raised when environment configuration is missing or invalid.
 *
 * The message lists variable names and what is wrong with them, but never the
 * received values: a malformed DATABASE_URL may still contain a real password.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    super(`Invalid ${scope} configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const variable = issue.path.join('.') || '(root)';
    // Zod messages describe the expected shape; they do not echo the input.
    return `${variable}: ${issue.message}`;
  });
}
