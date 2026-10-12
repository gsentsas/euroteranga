import { describe, expect, it } from 'vitest';
import { parseBootstrapArgs } from '../../../src/cli/bootstrap-args.js';

describe('bootstrap CLI arguments', () => {
  it('accepts the documented form, with or without the pnpm `--` separator', () => {
    const expected = { email: 'admin@example.test', delivery: 'print' };
    expect(parseBootstrapArgs(['--email', 'admin@example.test', '--delivery', 'print'])).toEqual(
      expected,
    );
    expect(
      parseBootstrapArgs(['--', '--email', 'admin@example.test', '--delivery', 'print']),
    ).toEqual(expected);
  });

  it.each([
    [[]],
    [['--email', 'admin@example.test']],
    [['--email', 'admin@example.test', '--delivery', 'sms']],
    [['--email', 'admin@example.test', '--delivery', 'mail', 'extra']],
    [['--email', 'admin@example.test', '--delivery', 'mail', '--token', 'x']],
    [['--', '--', '--email', 'admin@example.test', '--delivery', 'mail']],
  ])('refuses %j', (argv) => {
    expect(parseBootstrapArgs(argv)).toBeNull();
  });
});
