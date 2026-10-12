# Runbook — authentication incident

Scope: suspected credential leak, secret exposure or MFA compromise. There is
no admin console yet (PR-03): the actions below are database operations run
by an authorised operator on the production database, with a backup taken
first and every action recorded in the incident log.

> Never paste tokens, passwords, codes or key values into tickets, chats or
> logs. Refer to identities by their internal id.

## 1. Suspected leak of one account's password

1. Revoke the identity's sessions and invalidate all of them at once:
   ```sql
   BEGIN;
   UPDATE auth_session SET revoked_at = now(), revocation_reason = 'LOGOUT_ALL'
     WHERE identity_id = :id AND revoked_at IS NULL;
   UPDATE auth_identity SET auth_version = auth_version + 1 WHERE id = :id;
   COMMIT;
   ```
2. Customer: ask the owner to use "mot de passe oublié" (reset revokes again).
   Staff/crew: suspend until the owner sets a new password through a
   supervised process:
   `UPDATE auth_identity SET status = 'SUSPENDED' WHERE id = :id;`
3. Review `AUTH_LOGIN_SUCCESS` / `AUTH_LOGIN_FAILURE` events for the
   identity id and the pseudonymous `subject_ref`/`ip_ref` values.

## 2. Suspected session theft

Same as step 1.1 (revoke + `auth_version` increment). Sessions cannot be
re-used after revocation; cookies are HttpOnly, so look for the source
(malware, shared device) rather than XSS first.

## 3. MFA compromise (staff)

1. Suspend the identity and revoke its sessions (section 1).
2. Remove the TOTP credential and recovery codes so the next login requires a
   new enrollment:
   ```sql
   BEGIN;
   DELETE FROM mfa_recovery_code WHERE identity_id = :id;
   DELETE FROM mfa_totp_credential WHERE identity_id = :id;
   UPDATE auth_challenge SET consumed_at = now() WHERE identity_id = :id AND consumed_at IS NULL;
   COMMIT;
   ```
3. Reactivate (`status = 'ACTIVE'`) only after verifying the person
   out-of-band; they enroll a new authenticator at next login.

## 4. Exposed secret — implications of rotation

| Secret                     | Rotate how                                  | Effect of rotation                                                                                           |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AUTH_CSRF_KEY`            | new value, restart API                      | outstanding CSRF tokens invalid (clients refetch); sessions unaffected                                       |
| `AUTH_HMAC_KEY`            | new value, restart API                      | rate-limit counters reset; log pseudonyms change (old/new not correlatable)                                  |
| `AUTH_TOTP_ENCRYPTION_KEY` | **no rotation tooling yet**                 | changing it makes every stored TOTP secret undecryptable → all staff must re-enroll (section 3 for everyone) |
| `SMTP_PASSWORD`            | rotate at the mail provider, update env     | none for users                                                                                               |
| Database credentials       | rotate role password, update `DATABASE_URL` | API restart                                                                                                  |

If `AUTH_TOTP_ENCRYPTION_KEY` **and** a database copy leaked, treat every
staff TOTP as compromised: remove all TOTP credentials and recovery codes,
revoke all staff sessions, and re-enroll everyone.

## 5. Mass revocation (all sessions of a realm)

```sql
BEGIN;
UPDATE auth_session s SET revoked_at = now(), revocation_reason = 'LOGOUT_ALL'
  FROM auth_identity i
  WHERE s.identity_id = i.id AND i.realm = 'STAFF' AND s.revoked_at IS NULL;
UPDATE auth_identity SET auth_version = auth_version + 1 WHERE realm = 'STAFF';
COMMIT;
```

## 6. After the incident

- Keep the incident log (who, what, when, identity ids — no secrets).
- Check `AUTH_RATE_LIMITED` and `AUTH_MFA_FAILURE` trends.
- File follow-ups (e.g. admin tooling in PR-03, key rotation tooling).
