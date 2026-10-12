import { parseArgs } from 'node:util';

export interface BootstrapArgs {
  email: string;
  delivery: 'mail' | 'print';
}

/**
 * Parses `--email <address> --delivery mail|print`. pnpm forwards the `--`
 * separator of `pnpm <script> -- --email …` to the script; a single leading
 * `--` is therefore ignored. Anything else unexpected is refused.
 * Returns null when the arguments are invalid.
 */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs | null {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { email?: string | undefined; delivery?: string | undefined };
  try {
    ({ values } = parseArgs({
      args,
      options: { email: { type: 'string' }, delivery: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return null;
  }
  if (!values.email || (values.delivery !== 'mail' && values.delivery !== 'print')) return null;
  return { email: values.email, delivery: values.delivery };
}
