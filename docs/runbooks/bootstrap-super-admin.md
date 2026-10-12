# Runbook — initial SUPER_ADMIN bootstrap

Creates the first privileged administrator of an environment (ADR-020). It
also recovers an environment where no usable SUPER_ADMIN (ACTIVE + TOTP)
remains. **Nothing has been deployed yet: this procedure has only been run
against disposable test databases.**

> Never paste the invitation link or token into tickets, chats, shell history
> files or logs. It grants the SUPER_ADMIN role to whoever uses it first.

## Prerequisites

- Shell access to the API host, with the API environment (`DATABASE_URL`,
  auth keys, `OPS_PUBLIC_URL`) and the built API (`pnpm build`).
- Migrations applied (`pnpm db:migrate:status` reports no pending migration).
- For `--delivery mail`: `AUTH_MAIL_PROVIDER=smtp` and working SMTP settings.
- A database backup taken just before, per the environment's procedure.
- The future administrator reachable over a trusted channel.

## Procedure

1. Prefer mail delivery:
   ```bash
   pnpm auth:bootstrap-super-admin -- --email admin@example.org --delivery mail
   ```
   Without SMTP, from a secured terminal only (no recording, no shared
   screen):
   ```bash
   pnpm auth:bootstrap-super-admin -- --email admin@example.org --delivery print
   ```
   The link is printed once on stdout. Hand it over through the trusted
   channel, then clear the terminal scrollback.
2. The administrator opens the link, chooses a password, signs in on OPS and
   enrolls TOTP (the invitation authorizes one first enrollment). They keep
   the recovery codes offline.
3. Check in OPS → **Journal d’audit**: `SUPER_ADMIN_BOOTSTRAPPED` (author
   "Système") followed by `STAFF_INVITATION_ACCEPTED`.
4. Rerunning the command is now refused (`SUPER_ADMIN_ALREADY_ACTIVE`). From here on, administrators are invited
   from OPS → **Utilisateurs**.

## Outcomes and exit codes

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Invitation issued (or regenerated), enrollment grant issued, or role added |
| 2    | Refused: the reason is printed on stderr as `Refused (<REASON>): …`        |
| 1    | Error (usage, configuration, database, SMTP)                               |

The script itself returns these codes (`node dist/cli/bootstrap-super-admin.js`
from `apps/api`). Through the root `pnpm` script, pnpm reports any failure as
exit code 1: rely on the `Refused (…)` line on stderr to tell a refusal from
an error.

Refusal reasons:

- `SUPER_ADMIN_ALREADY_ACTIVE`: use OPS administration instead.
- `PENDING_BOOTSTRAP_FOR_ANOTHER_EMAIL`: an unfinished bootstrap exists for
  another address. Rerun with that address to regenerate its invitation. If
  that address must be abandoned, revoke its `SUPER_ADMIN` assignment in a
  reviewed, backed-up database operation (the audit trail keeps the history),
  then rerun.
- `IDENTITY_NOT_USABLE`: the address belongs to a suspended, disabled or
  inconsistent STAFF identity; use another address.

## Lost or expired invitation

Rerun the same command with the same address while the account is still
pending: a new invitation replaces the old one, which stops working.
