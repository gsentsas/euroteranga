import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { appByName, appUrl } from '../apps.js';
import { FIXTURE_PASSWORD, FIXTURES } from '../fixtures.js';

const client = appByName('client');
const ops = appByName('ops');
const crew = appByName('crew');

/** No authentication secret may be stored in browser storage. */
async function expectNoStoredSecrets(page: Page): Promise<void> {
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
  const values = await page.evaluate(() =>
    [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)].join(' '),
  );
  expect(values).not.toMatch(/[A-Za-z0-9_-]{43}/); // no opaque session/challenge token
  expect(stored.local.filter((key) => /session|token|auth|csrf|totp/i.test(key))).toEqual([]);
  expect(stored.session.filter((key) => /session|token|auth|csrf|totp/i.test(key))).toEqual([]);
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('client: login and registration pages are accessible forms', async ({ page }) => {
  await page.goto(appUrl(client, '/connexion'));
  await expect(page).toHaveTitle('Connexion — EURO TERANGA Client');
  await expect(page.getByLabel('Adresse e-mail')).toHaveAttribute('autocomplete', 'email');
  await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  const toggle = page.getByRole('button', { name: 'Afficher le mot de passe' });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Masquer le mot de passe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goto(appUrl(client, '/inscription'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Créer un compte');
  await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveAttribute(
    'autocomplete',
    'new-password',
  );
});

test('client: wrong password shows a generic, focused error', async ({ page }) => {
  await page.goto(appUrl(client, '/connexion'));
  await page.getByLabel('Adresse e-mail').fill(FIXTURES.customer.email);
  await page
    .getByLabel('Mot de passe', { exact: true })
    .fill('definitely not the right passphrase');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Email ou mot de passe incorrect.' });
  await expect(alert).toHaveText('Email ou mot de passe incorrect.');
  await expect(alert).toBeFocused();
});

test('client: verified customer logs in, sees the account, logs out', async ({ page, context }) => {
  const errors = trackPageErrors(page);
  await page.goto(appUrl(client, '/connexion'));
  await page.getByLabel('Adresse e-mail').fill(FIXTURES.customer.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page).toHaveURL(appUrl(client, '/compte'));
  await expect(page.getByTestId('session-email')).toHaveText(FIXTURES.customer.email);

  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === 'et_customer_session',
  );
  expect(cookie).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    domain: 'localhost',
  });
  await expectNoStoredSecrets(page);

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(appUrl(client, '/connexion'));
  expect(
    (await context.cookies()).some((candidate) => candidate.name === 'et_customer_session'),
  ).toBe(false);

  // The account page now sends the visitor back to the login page.
  await page.goto(appUrl(client, '/compte'));
  await expect(page).toHaveURL(appUrl(client, '/connexion'));
  expect(errors).toEqual([]);
});

test('ops: home requires a staff session', async ({ page }) => {
  await page.goto(appUrl(ops, '/'));
  await expect(page).toHaveURL(new RegExp(`^${appUrl(ops, '/connexion')}`));
});

test('ops: staff logs in with password, enrolls TOTP, reaches the console, logs out', async ({
  page,
  context,
}) => {
  const errors = trackPageErrors(page);
  await page.goto(appUrl(ops, '/connexion'));
  await page.getByLabel('Adresse e-mail').fill(FIXTURES.staff.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Continuer' }).click();

  // A correct password alone gives no staff session.
  await expect(page).toHaveURL(appUrl(ops, '/mfa/configuration'));
  expect((await context.cookies()).some((candidate) => candidate.name === 'et_staff_session')).toBe(
    false,
  );

  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  const code = new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
  const codeField = page.getByLabel('Code de l’application d’authentification');
  await expect(codeField).toHaveAttribute('autocomplete', 'one-time-code');
  await codeField.fill(code);
  await page.getByRole('button', { name: 'Activer' }).click();

  await expect(page.getByText('Ces codes ne seront affichés qu’une seule fois.')).toBeVisible();
  await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
  const staffCookie = (await context.cookies()).find(
    (candidate) => candidate.name === 'et_staff_session',
  );
  expect(staffCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  await expectNoStoredSecrets(page);

  await page.getByRole('button', { name: 'J’ai conservé mes codes, continuer' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Operations Control Center');
  await expect(page.getByTestId('session-email')).toHaveText(FIXTURES.staff.email);
  await expect(
    page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Foundation' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(new RegExp(`^${appUrl(ops, '/connexion')}`));
  await page.goto(appUrl(ops, '/'));
  await expect(page).toHaveURL(new RegExp(`^${appUrl(ops, '/connexion')}`));
  expect(errors).toEqual([]);
});

test('crew: crew member logs in, sees the session page, logs out', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto(appUrl(crew, '/connexion'));
  await page.getByLabel('Adresse e-mail').fill(FIXTURES.crew.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page).toHaveURL(appUrl(crew, '/session'));
  await expect(page.getByTestId('session-email')).toHaveText(FIXTURES.crew.email);
  await expectNoStoredSecrets(page);

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(appUrl(crew, '/connexion'));
  expect(errors).toEqual([]);
});
