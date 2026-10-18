import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { bookingSeed, FIXTURE_PASSWORD, FIXTURES, invitationToken } from '../fixtures.js';
import { directAdminApi, signInAndEnroll } from '../staff.js';

const ops = appByName('ops');

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigation principale' });
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Rendered once the OPS shell has loaded the caller's access. */
async function openAdminPage(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(appUrl(ops, path));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
}

test('ops: a STAFF session without ops.access is denied, in the UI and by the API', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const fixture = FIXTURES.staffWithoutAccess;
  // The home page loads after enrollment, with a refusal instead of content.
  await signInAndEnroll(page, fixture.email);
  await expect(page.getByRole('heading', { name: 'Accès refusé' })).toBeVisible();
  await expect(page.getByTestId('session-email')).toHaveCount(0);
  await expect(mainNav(page)).toHaveCount(0);

  await page.goto(appUrl(ops, '/admin/utilisateurs'));
  await expect(page.getByRole('heading', { name: 'Accès refusé' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);

  const api = directAdminApi(page.request);
  const identities = await api.get('/identities?realm=staff');
  expect(identities.status()).toBe(403);
  expect(((await identities.json()) as { code: string }).code).toBe('FORBIDDEN');
  const access = await api.get('/access/me');
  expect(await access.json()).toEqual({ roles: [], permissions: [] });
  expect(errors).toEqual([]);
});

test('ops: SUPER_ADMIN signs in with MFA, invites, manages roles and status, reads the audit', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = trackPageErrors(page);
  const admin = FIXTURES.superAdmin;
  const managed = FIXTURES.managed;
  const recoveryCodes = await signInAndEnroll(page, admin.email);

  // Second sign-in goes through the MFA verification step (recovery code).
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(new RegExp(`^${appUrl(ops, '/connexion')}`));
  await page.getByLabel('Adresse e-mail').fill(admin.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/mfa'));
  await page.getByRole('button', { name: 'Utiliser un code de récupération' }).click();
  await page.getByLabel('Code de récupération').fill(recoveryCodes[0] ?? '');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/'));
  await expect(page.getByTestId('session-roles')).toHaveText('SUPER_ADMIN');

  // UI-4C: the global search reuses the same authenticated session and existing read permissions.
  const bookingSearchSeed = bookingSeed();
  const globalSearch = page.getByRole('searchbox', { name: 'Recherche globale' });
  await expect(globalSearch).toBeVisible();
  await globalSearch.fill(bookingSearchSeed.staffBookingReference);
  const globalResults = page.getByRole('region', { name: 'Résultats globaux' });
  await expect(globalResults).toBeVisible();
  const bookingResult = globalResults
    .getByRole('link')
    .filter({ hasText: bookingSearchSeed.staffBookingReference })
    .first();
  await expect(bookingResult).toBeVisible();
  await bookingResult.click();
  await expect(page).toHaveURL(appUrl(ops, '/bookings'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Réservations');

  for (const label of ['Utilisateurs', 'Rôles', 'Journal d’audit']) {
    await expect(mainNav(page).getByRole('link', { name: label })).toBeVisible();
  }

  // Invite a new staff member (no real e-mail is sent in CI).
  await mainNav(page).getByRole('link', { name: 'Utilisateurs' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/admin/utilisateurs'));
  const newcomer = `newcomer.${process.env.E2E_RUN_ID}.e2e@fixtures.example.test`;
  const invite = page.getByRole('form', { name: 'Inviter un membre du personnel' });
  await invite.getByLabel('Adresse e-mail professionnelle').fill(newcomer);
  await invite.getByLabel('Rôle initial').selectOption('BOOKING_AGENT');
  await invite.getByRole('button', { name: 'Envoyer l’invitation' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Invitation envoyée à ${newcomer}.` }),
  ).toBeVisible();
  const newcomerRow = page.getByRole('row').filter({ hasText: newcomer });
  await expect(newcomerRow).toContainText('En attente');
  await expect(newcomerRow).toContainText('BOOKING_AGENT');

  // Grant, then revoke a role; suspend, then reactivate.
  const row = page.getByRole('row').filter({ hasText: managed.email });
  await row.getByLabel(`Rôle à attribuer à ${managed.email}`).selectOption('CUSTOMER_SUPPORT');
  await row.getByRole('button', { name: `Attribuer le rôle choisi à ${managed.email}` }).click();
  await expect(row.getByRole('list', { name: `Rôles de ${managed.email}` })).toContainText(
    'CUSTOMER_SUPPORT',
  );
  await row
    .getByRole('button', { name: `Retirer le rôle CUSTOMER_SUPPORT à ${managed.email}` })
    .click();
  await expect(row.getByRole('list', { name: `Rôles de ${managed.email}` })).not.toContainText(
    'CUSTOMER_SUPPORT',
  );
  await row.getByRole('button', { name: `Suspendre ${managed.email}` }).click();
  await expect(row).toContainText('Suspendu');
  await row.getByRole('button', { name: `Réactiver ${managed.email}` }).click();
  await expect(row).toContainText('Actif');

  // The admin's own row offers no action on itself.
  const selfRow = page.getByRole('row').filter({ hasText: admin.email });
  await expect(selfRow).toContainText('(vous)');
  await expect(selfRow.getByRole('button')).toHaveCount(0);

  await openAdminPage(page, '/admin/roles', 'Rôles');
  await expect(page.getByRole('row').filter({ hasText: 'SUPER_ADMIN' })).toContainText(
    'privileged.manage',
  );

  await openAdminPage(page, '/admin/audit', 'Journal d’audit');
  for (const action of [
    'STAFF_INVITED',
    'ROLE_GRANTED',
    'ROLE_REVOKED',
    'IDENTITY_STATUS_CHANGED',
  ]) {
    await expect(
      page.getByRole('row').filter({ hasText: action }).filter({ hasText: admin.email }).first(),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const menuButton = page.getByRole('button', { name: 'Menu' });
  await expect(menuButton).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(mainNav(page)).toBeVisible();
  await mainNav(page).getByRole('link', { name: 'Vue d’ensemble' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/'));
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  expect(errors).toEqual([]);
});

test('ops: AUDITOR reads identities, roles and audit but cannot change anything', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const auditor = FIXTURES.auditor;
  await signInAndEnroll(page, auditor.email);
  for (const label of ['Utilisateurs', 'Rôles', 'Journal d’audit']) {
    await expect(mainNav(page).getByRole('link', { name: label })).toBeVisible();
  }

  await openAdminPage(page, '/admin/utilisateurs', 'Utilisateurs');
  await expect(page.getByRole('row').filter({ hasText: FIXTURES.managed.email })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Inviter un membre du personnel' })).toHaveCount(0);
  for (const name of [/^Suspendre /, /^Attribuer /, /^Retirer /, /^Désactiver /, /^Fermer /]) {
    await expect(page.getByRole('table').getByRole('button', { name })).toHaveCount(0);
  }

  await openAdminPage(page, '/admin/roles', 'Rôles');
  await expect(page.getByRole('row').filter({ hasText: 'AUDITOR' }).first()).toBeVisible();
  await openAdminPage(page, '/admin/audit', 'Journal d’audit');
  await expect(page.getByRole('table')).toBeVisible();

  // Hidden buttons are not the protection: the API refuses the same calls.
  const api = directAdminApi(page.request);
  const target = (
    (await (await api.get('/identities?realm=staff')).json()) as {
      items: { id: string; email: string }[];
    }
  ).items.find((identity) => identity.email === FIXTURES.managed.email);
  expect(target).toBeDefined();
  const attempts = [
    await api.post('/staff/invitations', {
      email: `blocked.${process.env.E2E_RUN_ID}.e2e@fixtures.example.test`,
      roleKey: 'DISPATCHER',
    }),
    await api.post(`/identities/${target?.id}/roles`, { roleKey: 'AUDITOR' }),
    await api.post(`/identities/${target?.id}/status`, { status: 'SUSPENDED' }),
  ];
  for (const attempt of attempts) {
    expect(attempt.status()).toBe(403);
    expect(((await attempt.json()) as { code: string }).code).toBe('FORBIDDEN');
  }
  expect(errors).toEqual([]);
});

test('ops: invitation link sets the password, leaves no token behind, then MFA enrollment', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await page.goto(appUrl(ops, '/invitation'));
  await expect(page.getByRole('status')).toContainText('incomplet ou expiré');

  await page.goto(appUrl(ops, `/invitation#token=${invitationToken()}`));
  await expect(page.getByRole('form', { name: 'Activation du compte' })).toBeVisible();
  // The token is removed from the address bar and never stored.
  expect(page.url()).toBe(appUrl(ops, '/invitation'));
  const stored = await page.evaluate(() =>
    [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)].join(' '),
  );
  expect(stored).not.toContain(invitationToken());

  const newPassword = 'invited browser synthetic passphrase 0099';
  await page.getByLabel('Choisissez un mot de passe', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Activer mon compte' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/connexion?compte=active'));
  await expect(page.getByRole('status')).toContainText('Votre compte est activé');

  // The accepted invitation authorizes exactly one first MFA enrollment.
  await signInAndEnroll(page, FIXTURES.invited.email, newPassword);
  await expect(page.getByTestId('session-roles')).toHaveText('DISPATCHER');

  // The link is single-use.
  await page.goto(appUrl(ops, `/invitation#token=${invitationToken()}`));
  await page.getByLabel('Choisissez un mot de passe', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Activer mon compte' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Invitation invalide ou expirée.' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
