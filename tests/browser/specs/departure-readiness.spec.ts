import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession, tripSeed } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const ops = appByName('ops');

async function staffSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([
    {
      name: 'et_staff_session',
      value: token,
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

async function expectForbidden(response: APIResponse, operation: string): Promise<void> {
  expect(response.status(), operation).toBe(403);
  expect(((await response.json()) as { code: string }).code, operation).toBe('FORBIDDEN');
}

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigation principale' });
}

test.describe('PR-17 departure readiness and dispatch', () => {
  test.describe.configure({ mode: 'serial' });

  test('OPS_MANAGER explicitly clears permit policy then authorizes, departs and completes', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const tripReference = tripSeed().departureTripReference;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await staffSession(page.context(), preauthenticatedSession('permitManager'));
    const api = directAdminApi(page.request);

    const manifest = await api.post(`/manifests/trips/${tripReference}`, {});
    expect(manifest.status()).toBe(201);

    await page.goto(appUrl(ops, '/'));
    await mainNav(page).getByRole('link', { name: 'Départ / Dispatch' }).click();
    await expect(page).toHaveURL(appUrl(ops, '/departure'));

    const workspace = page.getByTestId('departure-workspace');
    await workspace.getByLabel('Référence du voyage').fill(tripReference.toLowerCase());
    await workspace.getByRole('button', { name: 'Vérifier la readiness' }).click();

    await expect(
      workspace.getByTestId('departure-blockers').getByText('Aucune politique explicite de permis'),
    ).toBeVisible();
    await expect(workspace.getByText('BLOQUÉ', { exact: true })).toBeVisible();

    await workspace.getByRole('button', { name: 'Publier une nouvelle version' }).click();
    await expect(
      workspace.getByRole('status').filter({ hasText: 'Politique v1 publiée avec 0 exigence(s).' }),
    ).toBeVisible();
    await expect(workspace.getByText('PRÊT', { exact: true })).toBeVisible();

    await workspace.getByRole('button', { name: 'Autoriser le départ' }).click();
    await expect(
      workspace.getByRole('status').filter({ hasText: 'Autorisation de départ enregistrée.' }),
    ).toBeVisible();
    await expect(workspace.getByText('Correspond aux faits actuels').locator('..')).toContainText(
      'Oui',
    );

    await workspace.getByRole('button', { name: 'Enregistrer le départ' }).click();
    await expect(
      workspace.getByRole('status').filter({ hasText: 'Départ réel enregistré.' }),
    ).toBeVisible();
    await expect(workspace.getByText('État opérationnel').locator('..')).toContainText('En cours');

    await workspace.getByRole('button', { name: 'Clôturer le voyage' }).click();
    await expect(
      workspace.getByRole('status').filter({ hasText: 'Voyage clôturé à l’arrivée.' }),
    ).toBeVisible();
    await expect(workspace.getByText('État opérationnel').locator('..')).toContainText('Terminé');

    expect(errors).toEqual([]);
  });

  test('FINANCE sees neither dispatch navigation nor departure API', async ({ page }) => {
    const tripReference = tripSeed().departureTripReference;
    await staffSession(page.context(), preauthenticatedSession('permitDenied'));
    await page.goto(appUrl(ops, '/'));

    await expect(mainNav(page).getByRole('link', { name: 'Départ / Dispatch' })).toHaveCount(0);
    const api = directAdminApi(page.request);
    await expectForbidden(await api.get(`/departure/trips/${tripReference}/readiness`), 'read');
    await expectForbidden(
      await api.post(`/departure/trips/${tripReference}/permit-policy`, { requirements: [] }),
      'policy',
    );
    await expectForbidden(
      await api.post(`/departure/trips/${tripReference}/authorize`, {}),
      'authorize',
    );

    await page.goto(appUrl(ops, '/departure'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('departure-workspace')).toHaveCount(0);
  });
});
