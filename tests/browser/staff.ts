import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { appByName, appUrl } from './apps.js';
import { FIXTURE_PASSWORD } from './fixtures.js';

const ops = appByName('ops');

/** Public API origin as the browser sees it (same site as the session cookie). */
export const BROWSER_API_URL = 'http://localhost:4000';
const OPS_ORIGIN = `http://localhost:${ops.port}`;

export function totpNow(secret: string): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
}

/**
 * Signs a STAFF fixture in for the first time: password, then TOTP
 * enrollment (allowed once by the fixture's enrollment grant). Returns the
 * recovery codes shown once, and leaves the page on the OPS home.
 */
export async function signInAndEnroll(
  page: Page,
  email: string,
  password = FIXTURE_PASSWORD,
): Promise<string[]> {
  await page.goto(appUrl(ops, '/connexion'));
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/mfa/configuration'));

  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  await page.getByLabel('Code de l’application d’authentification').fill(totpNow(secret));
  await page.getByRole('button', { name: 'Activer' }).click();
  const list = page.getByTestId('recovery-codes').getByRole('listitem');
  await expect(list).toHaveCount(10);
  const codes = (await list.allTextContents()).map((code) => code.trim());
  await page.getByRole('button', { name: 'J’ai conservé mes codes, continuer' }).click();
  await expect(page).toHaveURL(appUrl(ops, '/'));
  return codes;
}

/**
 * Calls the admin API directly with the page's session cookie, bypassing the
 * interface, to prove that hidden buttons are not the protection.
 */
export function directAdminApi(request: APIRequestContext) {
  const headers = { Origin: OPS_ORIGIN };
  return {
    get: (path: string) => request.get(`${BROWSER_API_URL}/v1/admin${path}`, { headers }),
    async post(path: string, data: unknown) {
      const csrf = await request.get(`${BROWSER_API_URL}/v1/auth/staff/csrf`, { headers });
      expect(csrf.status()).toBe(200);
      const { csrfToken } = (await csrf.json()) as { csrfToken: string };
      return request.post(`${BROWSER_API_URL}/v1/admin${path}`, {
        headers: { ...headers, 'X-CSRF-Token': csrfToken },
        data,
      });
    },
  };
}
