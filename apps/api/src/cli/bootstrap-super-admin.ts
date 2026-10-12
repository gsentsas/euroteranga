/**
 * Initial SUPER_ADMIN bootstrap (operator CLI, no HTTP endpoint).
 *
 *   pnpm --filter @euroteranga/api auth:bootstrap-super-admin -- \
 *     --email admin@example.org --delivery mail|print
 *
 * --delivery mail   sends the invitation through the configured SMTP provider;
 * --delivery print  prints the invitation link ONCE on stdout (for a secured
 *                   operator terminal; see docs/runbooks/bootstrap-super-admin.md).
 *
 * Exit codes: 0 done, 2 refused (e.g. an active SUPER_ADMIN exists), 1 error.
 * The token is never written to the structured logs.
 */
import { parseArgs } from 'node:util';
import { ConfigValidationError, loadApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { createLogger, redactString } from '@euroteranga/logger';
import { buildAuthConfig } from '../auth/auth.config.js';
import { createAuthMailProvider } from '../auth/mail/auth-mail.providers.js';
import { staffInvitationMail } from '../auth/mail/auth-mailer.js';
import {
  BootstrapRefusedError,
  bootstrapSuperAdmin,
} from '../authorization/bootstrap/bootstrap-super-admin.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, delivery: { type: 'string' } },
    strict: true,
  });
  if (!values.email || (values.delivery !== 'mail' && values.delivery !== 'print')) {
    err('Usage: auth:bootstrap-super-admin --email <address> --delivery mail|print');
    return 1;
  }

  const env = loadApiEnv();
  const config = buildAuthConfig(env);
  if (values.delivery === 'mail' && env.AUTH_MAIL_PROVIDER !== 'smtp') {
    err('--delivery mail requires AUTH_MAIL_PROVIDER=smtp.');
    return 1;
  }

  const db = createDatabaseClient({ databaseUrl: env.DATABASE_URL });
  try {
    const outcome = await bootstrapSuperAdmin(db, {
      email: values.email,
      invitationTtlMs: config.staffInvitationTtlMs,
      enrollmentGrantTtlMs: config.staffEnrollmentGrantTtlMs,
    });

    if (outcome.kind === 'role-granted') {
      out(`SUPER_ADMIN granted to the existing STAFF identity ${outcome.identityId}.`);
      return 0;
    }
    if (outcome.kind === 'enrollment-grant') {
      out(
        `SUPER_ADMIN granted to ${outcome.identityId}; MFA enrollment authorized until ${outcome.expiresAt.toISOString()}.`,
      );
      out('The person signs in to OPS with their password and configures TOTP.');
      return 0;
    }

    const message = staffInvitationMail(
      config.opsPublicUrl,
      outcome.email,
      outcome.token,
      config.staffInvitationTtlMs,
    );
    out(
      `${outcome.regenerated ? 'Invitation regenerated' : 'Bootstrap invitation created'} for ${outcome.identityId}, valid until ${outcome.expiresAt.toISOString()}.`,
    );
    if (values.delivery === 'mail') {
      const provider = createAuthMailProvider(
        env,
        createLogger({ service: 'bootstrap-cli', level: 'warn' }),
      );
      try {
        await provider.send(message);
        out(`Invitation sent to ${outcome.email}.`);
      } catch (error) {
        err(
          `Mail delivery failed (${error instanceof Error ? error.name : 'error'}). Rerun the command to issue a new invitation.`,
        );
        return 1;
      }
    } else {
      err('WARNING: the link below grants the SUPER_ADMIN invitation. It is shown once.');
      err('Do not paste it into tickets or chats; clear the terminal scrollback after use.');
      const link = /https?:\/\/\S+#token=\S+/.exec(message.text)?.[0];
      out(link ?? '(link unavailable)');
    }
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof BootstrapRefusedError) {
      err(`Refused (${error.reason}): ${error.message}`);
      process.exit(2);
    }
    if (error instanceof ConfigValidationError) {
      err(error.message);
      process.exit(1);
    }
    err(
      `Bootstrap failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
