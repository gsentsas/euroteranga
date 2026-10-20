import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The pilot deploy guard (infrastructure/plesk/pilot-env-guard.sh, sourced by
 * deploy-release.sh): the pilot is staging, takes no payment, and keeps
 * Stripe DISABLED without any credential (PAY-EU-1).
 */
const GUARD = fileURLToPath(
  new URL('../../../infrastructure/plesk/pilot-env-guard.sh', import.meta.url),
);

function guard(env: Record<string, string>) {
  const result = spawnSync('bash', ['-c', `. "${GUARD}" && pilot_env_guard`], {
    // Only the variables of the case: nothing inherited from the test runner.
    env: { PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

const PILOT = { APP_ENV: 'staging', PAYMENT_PROVIDER: 'DISABLED' };

describe('pilot deploy guard', () => {
  it('accepts the pilot as it is: staging, payments disabled, Stripe unset or DISABLED', () => {
    expect(guard(PILOT).status).toBe(0);
    expect(guard({ ...PILOT, PAYMENT_STRIPE_MODE: 'DISABLED' }).status).toBe(0);
    expect(
      guard({ ...PILOT, PAYMENT_STRIPE_MODE: 'DISABLED', PAYMENT_STRIPE_SECRET_KEY: '' }),
    ).toMatchObject({ status: 0 });
  });

  it.each(['TEST', 'LIVE', 'test', ''])('refuses PAYMENT_STRIPE_MODE=%s', (mode) => {
    const result = guard({ ...PILOT, PAYMENT_STRIPE_MODE: mode });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENT_STRIPE_MODE=DISABLED');
  });

  it('refuses any Stripe credential, and never prints it', () => {
    for (const name of ['PAYMENT_STRIPE_SECRET_KEY', 'PAYMENT_STRIPE_WEBHOOK_SECRET']) {
      const value = `x${randomBytes(16).toString('hex')}`;
      const result = guard({ ...PILOT, [name]: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('refuses Stripe credentials');
      expect(result.stderr).not.toContain(value);
    }
  });

  it('runs in deploy-release.sh before anything is fetched, built or restarted', () => {
    const script = readFileSync(
      new URL('../../../infrastructure/plesk/deploy-release.sh', import.meta.url),
      'utf8',
    );
    const lines = script.split('\n');
    const sourced = lines.indexOf('. "$(dirname "${BASH_SOURCE[0]}")/pilot-env-guard.sh"');
    const called = lines.indexOf('pilot_env_guard || exit 1');
    const firstAction = lines.findIndex((line) => /^(install|runuser|git|systemctl)\b/.test(line));
    const envLoaded = lines.indexOf('set +a');
    expect(envLoaded).toBeGreaterThan(0);
    expect(sourced).toBeGreaterThan(envLoaded);
    expect(called).toBeGreaterThan(sourced);
    expect(firstAction).toBeGreaterThan(called);
  });

  it('keeps the earlier pilot rules: staging only, PAYMENT_PROVIDER=DISABLED', () => {
    expect(guard({ ...PILOT, APP_ENV: 'production' }).status).toBe(1);
    expect(guard({ PAYMENT_PROVIDER: 'DISABLED' }).status).toBe(1);
    expect(guard({ ...PILOT, PAYMENT_PROVIDER: 'SANDBOX' }).status).toBe(1);
    expect(guard({ APP_ENV: 'staging' }).status).toBe(1);
  });
});
