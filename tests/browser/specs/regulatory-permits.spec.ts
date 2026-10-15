import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { permitSeed, preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const ops = appByName('ops');
const PERMIT_REFERENCE = /^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

let permitReference = '';

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

function notice(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

test.describe('PR-16 regulatory permits', () => {
  test.describe.configure({ mode: 'serial' });

  test('OPS_MANAGER creates, edits, activates, consults and revokes a synthetic permit', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = trackPageErrors(page);
    const seed = permitSeed();

    await staffSession(page.context(), preauthenticatedSession('permitManager'));
    await page.goto(appUrl(ops, '/'));
    await mainNav(page).getByRole('link', { name: 'Autorisations réglementaires' }).click();
    await expect(page).toHaveURL(appUrl(ops, '/regulatory-permits'));

    const workspace = page.getByTestId('regulatory-permit-workspace');
    await expect(workspace).toContainText(
      'La validité intrinsèque d’une autorisation ne signifie pas qu’un voyage est prêt ni autorisé à partir.',
    );
    const create = workspace.getByRole('form', {
      name: 'Créer une autorisation réglementaire',
    });
    await create.getByLabel('Type de permis').fill(seed.permitType.toLowerCase());
    await create.getByLabel('Intitulé').fill(seed.title);
    await create.getByLabel('Autorité émettrice').fill(seed.issuingAuthority);
    await create.getByLabel('Référence de l’autorité (facultative)').fill(seed.authorityReference);
    await create.getByLabel('Périmètre').selectOption('TRIP');
    await create.getByLabel('Référence du voyage').fill(seed.tripReference.toLowerCase());
    await create.getByLabel('Valide du').fill(seed.validFrom);
    await create.getByLabel('Valide jusqu’au').fill(seed.validUntil);
    await create.getByLabel('Source HTTPS (facultative)').fill(seed.sourceUrl);
    await create.getByLabel('Notes internes (facultatives)').fill(seed.notes);

    const createdResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${BROWSER_API_URL}/v1/admin/regulatory-permits`,
    );
    await create.getByRole('button', { name: 'Créer le brouillon' }).click();
    const createdResponse = await createdResponsePromise;
    expect(createdResponse.status()).toBe(201);
    permitReference = ((await createdResponse.json()) as { reference: string }).reference;
    expect(permitReference).toMatch(PERMIT_REFERENCE);
    await expect(notice(page, `Autorisation ${permitReference} créée.`)).toBeVisible();

    const detail = page.getByRole('region', { name: `Autorisation ${permitReference}` });
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('permit-detail')).toContainText(`Voyage ${seed.tripReference}`);
    await expect(detail.getByTestId('permit-validity')).toHaveText('Brouillon — non active');
    await expect(detail.getByText('Brouillon', { exact: true })).toBeVisible();

    const edit = detail.getByRole('form', {
      name: `Modifier l’autorisation ${permitReference}`,
    });
    await edit.getByLabel('Intitulé').fill(seed.updatedTitle);
    await edit.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    await expect(notice(page, `Autorisation ${permitReference} modifiée.`)).toBeVisible();
    await expect(detail.getByTestId('permit-detail')).toContainText(seed.updatedTitle);

    await detail.getByRole('button', { name: 'Activer l’autorisation' }).click();
    await expect(notice(page, `Autorisation ${permitReference} activée.`)).toBeVisible();
    await expect(detail.getByText('Active', { exact: true })).toBeVisible();
    await expect(detail.getByTestId('permit-validity')).toHaveText('Valide intrinsèquement');
    await expect(
      detail.getByRole('form', { name: `Modifier l’autorisation ${permitReference}` }),
    ).toHaveCount(0);

    await detail.getByLabel('Motif de révocation').fill(seed.revocationReason);
    await detail.getByRole('button', { name: 'Révoquer', exact: true }).click();
    await detail.getByRole('button', { name: 'Confirmer la révocation' }).click();
    await expect(notice(page, `Autorisation ${permitReference} révoquée.`)).toBeVisible();
    await expect(detail.getByText('Révoquée', { exact: true }).first()).toBeVisible();
    await expect(detail.getByTestId('permit-validity')).toHaveText('Révoquée');
    await expect(detail.getByTestId('permit-detail')).toContainText(seed.revocationReason);

    const history = detail.getByRole('list', {
      name: `Historique de l’autorisation ${permitReference}`,
    });
    await expect(history.getByRole('listitem')).toHaveCount(4);
    for (const action of [
      'REGULATORY_PERMIT_CREATED',
      'REGULATORY_PERMIT_UPDATED',
      'REGULATORY_PERMIT_ACTIVATED',
      'REGULATORY_PERMIT_REVOKED',
    ]) {
      await expect(history).toContainText(action);
    }
    await expect(page.getByRole('button', { name: /prêt|départ autorisé|dispatch/i })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
  });

  test('DISPATCHER consults the permit without mutation controls and every mutation is refused', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    const seed = permitSeed();
    expect(permitReference).toMatch(PERMIT_REFERENCE);

    await staffSession(page.context(), preauthenticatedSession('permitReader'));
    await page.goto(appUrl(ops, '/'));
    await mainNav(page).getByRole('link', { name: 'Autorisations réglementaires' }).click();
    const workspace = page.getByTestId('regulatory-permit-workspace');
    await expect(workspace).toBeVisible();
    await expect(
      workspace.getByRole('form', { name: 'Créer une autorisation réglementaire' }),
    ).toHaveCount(0);

    const filters = workspace.getByRole('form', { name: 'Filtrer les autorisations' });
    await filters.getByLabel('Référence').fill(permitReference.toLowerCase());
    await filters.getByRole('button', { name: 'Appliquer les filtres' }).click();
    const row = workspace.getByRole('row').filter({ hasText: permitReference });
    await expect(row).toContainText('Révoquée');
    await row.getByRole('button', { name: 'Consulter' }).click();

    const detail = page.getByRole('region', { name: `Autorisation ${permitReference}` });
    await expect(detail.getByTestId('permit-detail')).toContainText(seed.updatedTitle);
    await expect(detail.getByTestId('permit-detail')).toContainText(`Voyage ${seed.tripReference}`);
    await expect(detail.getByTestId('permit-validity')).toHaveText('Révoquée');
    await expect(detail.getByRole('form')).toHaveCount(0);
    await expect(
      detail.getByRole('button', { name: /créer|enregistrer|activer|révoquer|confirmer/i }),
    ).toHaveCount(0);

    const api = directAdminApi(page.request);
    const list = await api.get(`/regulatory-permits?reference=${permitReference}`);
    expect(list.status()).toBe(200);
    expect(
      ((await list.json()) as { items: Array<{ reference: string }> }).items.map(
        (permit) => permit.reference,
      ),
    ).toEqual([permitReference]);
    expect((await api.get(`/regulatory-permits/${permitReference}`)).status()).toBe(200);

    const forbidden = [
      ['create', await api.post('/regulatory-permits', {})],
      [
        'update',
        await api.post(`/regulatory-permits/${permitReference}`, {
          expectedRevision: 4,
          title: 'Mutation interdite',
        }),
      ],
      [
        'activate',
        await api.post(`/regulatory-permits/${permitReference}/activate`, {
          expectedRevision: 4,
        }),
      ],
      [
        'revoke',
        await api.post(`/regulatory-permits/${permitReference}/revoke`, {
          expectedRevision: 4,
          reason: 'Mutation interdite au profil de lecture.',
        }),
      ],
    ] as const;
    for (const [operation, response] of forbidden) {
      await expectForbidden(response, operation);
    }
    expect(errors).toEqual([]);
  });

  test('FINANCE sees no permit navigation or page and the API returns 403', async ({ page }) => {
    const errors = trackPageErrors(page);
    expect(permitReference).toMatch(PERMIT_REFERENCE);

    await staffSession(page.context(), preauthenticatedSession('permitDenied'));
    await page.goto(appUrl(ops, '/'));
    const nav = mainNav(page);
    await expect(nav.getByRole('link', { name: 'Paiements' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Autorisations réglementaires' })).toHaveCount(0);

    const api = directAdminApi(page.request);
    await expectForbidden(await api.get('/regulatory-permits'), 'list');
    await expectForbidden(await api.get(`/regulatory-permits/${permitReference}`), 'detail');
    await expectForbidden(await api.post('/regulatory-permits', {}), 'create');

    await page.goto(appUrl(ops, '/regulatory-permits'));
    await expect(
      page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
    ).toBeVisible();
    await expect(page.getByTestId('regulatory-permit-workspace')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
