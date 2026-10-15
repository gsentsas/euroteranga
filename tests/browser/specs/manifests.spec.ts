import { expect, test, type BrowserContext } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { checkInSeed, preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const ops = appByName('ops');

async function staffSession(context: BrowserContext, token: string) {
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

test.describe('PR-15 passenger manifests', () => {
  test('DISPATCHER generates, browses and exports immutable history in OPS', async ({ page }) => {
    await staffSession(page.context(), preauthenticatedSession('boardingOperator'));
    const tripReference = checkInSeed().customerTripReference;
    const generated = await directAdminApi(page.request).post(
      `/manifests/trips/${encodeURIComponent(tripReference)}`,
      {},
    );
    expect(generated.status()).toBe(201);
    const manifest = (await generated.json()) as {
      reference: string;
      version: number;
      passengerCount: number;
      boardedCount: number;
    };

    await page.goto(appUrl(ops, '/'));
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Manifestes passagers' })
      .click();
    await expect(page).toHaveURL(appUrl(ops, '/manifests'));
    const workspace = page.getByTestId('manifest-workspace');
    await expect(workspace).toContainText('nouvelle version historique');
    await workspace.getByLabel('Référence du voyage').fill(tripReference);
    await workspace.getByRole('button', { name: 'Afficher l’historique' }).click();
    const row = workspace.getByRole('row').filter({ hasText: manifest.reference });
    await expect(row).toContainText(String(manifest.version));
    await expect(row).toContainText(String(manifest.passengerCount));
    await expect(row).toContainText(String(manifest.boardedCount));
    await row.getByRole('button', { name: 'Détail' }).click();
    await expect(workspace).toContainText(`Version ${manifest.version}`);
    await expect(workspace).toContainText(/Empreinte SHA-256/);

    const download = page.waitForEvent('download');
    await workspace.getByRole('button', { name: 'Exporter en CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(
      `passenger-manifest-${tripReference}-v${manifest.version}.csv`,
    );
    await expect(page.getByRole('button', { name: /prêt|approuver|finaliser/i })).toHaveCount(0);
  });

  test('a STAFF role without manifest permissions sees no page and the API refuses it', async ({
    page,
  }) => {
    await staffSession(page.context(), preauthenticatedSession('checkInDenied'));
    await page.goto(appUrl(ops, '/'));
    await expect(
      page
        .getByRole('navigation', { name: 'Navigation principale' })
        .getByRole('link', { name: 'Manifestes passagers' }),
    ).toHaveCount(0);
    const tripReference = checkInSeed().customerTripReference;
    expect(
      (
        await directAdminApi(page.request).get(`/manifests?tripReference=${tripReference}`)
      ).status(),
    ).toBe(403);
    expect(
      (
        await directAdminApi(page.request).post(
          `/manifests/trips/${encodeURIComponent(tripReference)}`,
          {},
        )
      ).status(),
    ).toBe(403);
  });
});
