import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { pagesSeed } from '../content-seed.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const ops = appByName('ops');
const web = appByName('web');

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigation principale' });
}

/** Pre-created session: these scenarios do not consume the shared login-IP budget. */
async function signedIn(context: BrowserContext, name: 'contentEditor' | 'contentDenied') {
  await context.addCookies([
    {
      name: 'et_staff_session',
      value: preauthenticatedSession(name),
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

function notice(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

/**
 * CMS-2: the OPS editor of the public website. A CONTENT_EDITOR creates a
 * page, fills its sections through structured fields, sees the exact
 * website rendering in a sandboxed preview, publishes, restores and
 * archives — on a run-scoped path, so the shared home page, settings and
 * navigation stay untouched for the other scenarios.
 */
test.describe('ops website content editor', () => {
  test('a content editor creates, previews, publishes, restores and archives a page', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const run = process.env.E2E_RUN_ID ?? '';
    const path = `/e2e-editeur-${run}`;

    await signedIn(page.context(), 'contentEditor');
    await page.goto(appUrl(ops, '/'));
    await mainNav(page).getByRole('link', { name: 'Contenus du site' }).click();
    await expect(page).toHaveURL(appUrl(ops, '/contenus'));
    await expect(page.getByTestId('content-workspace')).toBeVisible();

    const create = page.getByRole('form', { name: 'Créer une page' });
    await create.getByLabel('Chemin public').fill(`/E2E ${run}`);
    await expect(create.getByText('chemin public invalide')).toBeVisible();
    await expect(create.getByRole('button', { name: 'Créer la page' })).toBeDisabled();
    await create.getByLabel('Chemin public').fill(path);
    await create.getByLabel('Titre').fill(`Éditeur ${run}`);
    await create
      .getByLabel('Description pour les moteurs de recherche')
      .fill('Page créée par le scénario navigateur CMS-2.');
    await create.getByRole('button', { name: 'Créer la page' }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);

    const editor = page.getByTestId('content-editor');
    await expect(editor.getByRole('heading', { level: 2, name: path })).toBeVisible();
    await expect(editor.getByText('Jamais publiée')).toBeVisible();
    // No seo.manage: search metadata is read-only, the API would refuse it.
    await expect(editor.getByLabel('Description dans les résultats de recherche')).toBeDisabled();
    await expect(editor.getByText('Ces champs demandent la permission seo.manage')).toBeVisible();

    const form = page.getByRole('form', { name: `Modifier : ${path}` });
    const save = form.getByRole('button', { name: 'Enregistrer le brouillon' });
    await expect(save).toBeDisabled();

    // Client-side navigation must not silently discard unsaved edits.
    const titleField = form.getByLabel('Titre de la page');
    await titleField.fill(`Éditeur ${run} modifié`);
    const dialogPromise = page.waitForEvent('dialog');
    const leaveAttempt = page.getByRole('link', { name: '← Tous les contenus' }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('modifications non enregistrées');
    await dialog.dismiss();
    await leaveAttempt;
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);
    await titleField.fill(`Éditeur ${run}`);
    await expect(save).toBeDisabled();

    // A new section is empty, hence refused until it is filled in.
    await form.getByLabel('Nouvelle section').selectOption('cards');
    await form.getByRole('button', { name: 'Ajouter la section' }).click();
    const issues = form.getByRole('region', { name: /points? à corriger/ });
    await expect(issues).toBeVisible();
    await expect(save).toBeDisabled();
    const cards = form.locator('.ops-content-block').nth(0);
    await cards.getByLabel('Titre (H2)').fill('Pourquoi voyager avec nous');
    await cards.getByLabel('Titre', { exact: true }).fill(`Carte ${run}`);
    await cards.getByLabel('Texte', { exact: true }).fill('Un texte de carte synthétique.');

    await form.getByLabel('Nouvelle section').selectOption('richText');
    await form.getByRole('button', { name: 'Ajouter la section' }).click();
    const rich = form.locator('.ops-content-block').nth(1);
    const body = rich.getByRole('textbox', { name: 'Texte', exact: true });
    await body.fill('Un texte **non fermé');
    await expect(rich.getByText('Ligne 1 : « ** » non fermé (gras)')).toBeVisible();
    await expect(save).toBeDisabled();

    // Removing an invalid rich-text section must also remove its local parsing error.
    await rich.getByRole('button', { name: /Retirer : Section 2/ }).click();
    await rich.getByRole('button', { name: 'Retirer la section' }).click();
    await expect(issues).toHaveCount(0);

    // Recreate the section used by the publication scenario.
    await form.getByLabel('Nouvelle section').selectOption('richText');
    await form.getByRole('button', { name: 'Ajouter la section' }).click();
    const validRich = form.locator('.ops-content-block').nth(1);
    const validBody = validRich.getByRole('textbox', { name: 'Texte', exact: true });
    await validBody.fill(
      '## Bagages\n\nUn **bagage** en soute. <b>Le balisage reste du texte.</b>',
    );
    await expect(issues).toHaveCount(0);

    // The preview is the website rendering, in a frame without scripts nor origin.
    const frame = page.getByTestId('content-preview-frame');
    await expect(frame).toHaveAttribute('sandbox', '');
    const preview = page.frameLocator('[data-testid="content-preview-frame"]');
    await expect(
      preview.getByRole('heading', { name: 'Pourquoi voyager avec nous' }),
    ).toBeVisible();
    await expect(preview.getByText('<b>Le balisage reste du texte.</b>')).toBeVisible();
    await expect(preview.getByText('Aperçu — version non publiée')).toBeVisible();
    await page.getByRole('button', { name: /Bureau/ }).click();
    await expect(page.getByRole('button', { name: /Bureau/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await form.getByLabel('Note de version (facultatif)').fill('Première version');
    await save.click();
    await expect(notice(page, 'Brouillon enregistré (révision 1)')).toBeVisible();
    await expect(editor.getByText('Modifications non enregistrées')).toHaveCount(0);

    const publish = page.getByRole('form', { name: 'Publier le brouillon' });
    await publish.getByRole('button', { name: 'Publier le brouillon' }).click();
    await publish.getByRole('button', { name: 'Publier maintenant' }).click();
    await expect(notice(page, 'Révision 1 publiée')).toBeVisible();
    await expect(editor.locator('.ops-content-badge--live')).toHaveText('En ligne');

    // The website serves the published version, editor markup as text.
    const site = await page.context().newPage();
    const response = await site.goto(appUrl(web, path));
    expect(response?.status()).toBe(200);
    await expect(site.getByRole('heading', { name: 'Pourquoi voyager avec nous' })).toBeVisible();
    await expect(site.getByText('<b>Le balisage reste du texte.</b>')).toBeVisible();
    await expect(site.locator('main b')).toHaveCount(0);
    await site.close();

    // A second version, then the first one restored as a new draft.
    await cards.getByLabel('Titre (H2)').fill('Voyager avec EURO TERANGA');
    await save.click();
    await expect(notice(page, 'Brouillon enregistré (révision 2)')).toBeVisible();
    await publish.getByRole('button', { name: 'Publier le brouillon' }).click();
    await publish.getByRole('button', { name: 'Publier maintenant' }).click();
    await expect(notice(page, 'Révision 2 publiée')).toBeVisible();
    const history = page.getByRole('table', { name: /Révisions de/ });
    await expect(history.getByRole('row').filter({ hasText: 'Première version' })).toContainText(
      'Remplacée',
    );

    await history.getByRole('button', { name: 'Prévisualiser la révision 1' }).click();
    await expect(page.getByText('L’aperçu montre la révision 1')).toBeVisible();
    await expect(
      preview.getByRole('heading', { name: 'Pourquoi voyager avec nous' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Revenir à la version en cours d’édition' }).click();

    await history.getByRole('button', { name: 'Restaurer la révision 1 comme brouillon' }).click();
    await expect(notice(page, 'Révision 1 restaurée comme brouillon (révision 3)')).toBeVisible();
    await expect(cards.getByLabel('Titre (H2)')).toHaveValue('Pourquoi voyager avec nous');

    // Someone else saves the same draft meanwhile: the editor never overwrites it.
    const api = directAdminApi(page.request);
    const entryId = new URL(page.url()).searchParams.get('entree')!;
    const current = (await (await api.get(`/content/entries/${entryId}`)).json()) as {
      draft: { updatedAt: string; document: Record<string, unknown> };
    };
    const concurrent = await api.post(`/content/entries/${entryId}/draft`, {
      document: { ...current.draft.document, title: `Éditeur ${run} (autre poste)` },
      expectedDraftUpdatedAt: current.draft.updatedAt,
    });
    expect(concurrent.status()).toBe(200);
    await form.getByLabel('Titre de la page').fill(`Éditeur ${run} modifié`);
    await save.click();
    const conflict = page.getByRole('alert').filter({ hasText: 'Quelqu’un a modifié ce contenu' });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Recharger la dernière version' }).click();
    await expect(form.getByLabel('Titre de la page')).toHaveValue(`Éditeur ${run} (autre poste)`);

    const discard = page.getByRole('form', { name: 'Abandonner le brouillon' });
    await discard.getByRole('button', { name: 'Abandonner le brouillon' }).click();
    await discard.getByRole('button', { name: 'Abandonner', exact: true }).click();
    await expect(notice(page, 'Brouillon abandonné')).toBeVisible();

    const archive = page.getByRole('form', { name: 'Archiver la page' });
    await archive.getByLabel('Motif de l’archivage').fill('Fin du scénario navigateur CMS-2.');
    await archive.getByRole('button', { name: 'Archiver la page' }).click();
    await archive.getByRole('button', { name: 'Archiver', exact: true }).click();
    await expect(notice(page, 'Page archivée')).toBeVisible();
    await expect(form.getByLabel('Titre de la page')).toBeDisabled();
    // The public API (source of the website, cached ≤ 60 s) no longer serves it.
    const live = await request.get(
      `${BROWSER_API_URL}/v1/content/pages?path=${encodeURIComponent(path)}`,
    );
    expect(live.status()).toBe(404);

    expect(errors).toEqual([]);
  });

  test('a page created from a template keeps its sections and previews real data only', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const run = process.env.E2E_RUN_ID ?? '';
    const path = `/e2e-modele-${run}`;
    const seed = pagesSeed();

    await signedIn(page.context(), 'contentEditor');
    await page.goto(appUrl(ops, '/contenus'));
    const create = page.getByRole('form', { name: 'Créer une page' });
    const templates = create.getByLabel('Modèle');
    for (const label of ['Bagages', 'Comment ça marche', 'FAQ', 'À propos']) {
      await expect(templates.locator('option', { hasText: label })).toHaveCount(1);
    }
    await templates.selectOption({ label: 'Voyage Paris → Dakar' });
    // The template pre-fills the page; the editor keeps the last word.
    await expect(create.getByLabel('Chemin public')).toHaveValue('/paris-dakar');
    await expect(create.getByLabel('Titre')).toHaveValue('Paris → Dakar');
    await create.getByLabel('Chemin public').fill(path);
    await create.getByRole('button', { name: 'Créer la page' }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);

    const form = page.getByRole('form', { name: `Modifier : ${path}` });
    await expect(form.locator('.ops-content-block')).toHaveCount(8);
    const editor = page.getByTestId('content-editor');
    // The template never decides indexing: the page stays a non-indexed draft.
    await expect(editor.getByText('Jamais publiée')).toBeVisible();

    // Dates, itinerary and coaches are read live; PAR and DKR are not stops of
    // this test network, so the preview says that no departure is scheduled.
    const preview = page.frameLocator('[data-testid="content-preview-frame"]');
    await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Paris → Dakar');
    await expect(
      preview.getByText('Aucun départ n’est programmé pour le moment sur ce trajet', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      preview.getByRole('heading', { level: 3, name: seed.coaches[0]!.name }),
    ).toBeVisible();

    // A new coach presentation starts without a coach, and says so.
    await form.locator('summary', { hasText: 'Section 5 : Nos autocars' }).click();
    await form.getByRole('button', { name: 'Présenter un autocar' }).click();
    const coach = form.getByRole('combobox', { name: 'Autocar', exact: true });
    await expect(coach).toHaveValue('');
    await expect(coach.locator('option:checked')).toHaveText('Choisir un autocar');
    await coach.selectOption(seed.coaches[1]!.code);
    await expect(coach).toHaveValue(seed.coaches[1]!.code);
    await expect(coach.locator('option', { hasText: 'Choisir un autocar' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the cargo template pre-fills /fret and stays an editable unpublished draft', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const run = process.env.E2E_RUN_ID ?? '';
    const path = `/e2e-modele-fret-${run}`;

    await signedIn(page.context(), 'contentEditor');
    await page.goto(appUrl(ops, '/contenus'));
    const create = page.getByRole('form', { name: 'Créer une page' });
    await create.getByLabel('Modèle').selectOption({ label: 'Colis & fret' });
    await expect(create.getByLabel('Chemin public')).toHaveValue('/fret');
    await expect(create.getByLabel('Titre')).toHaveValue('Colis & fret Paris ↔ Dakar');
    await expect(create.getByLabel('Description pour les moteurs de recherche')).toHaveValue(
      'Envoyez vos colis et votre fret routier entre Paris et Dakar avec EURO TERANGA : prise en charge, suivi sécurisé et devis adapté à votre envoi.',
    );

    // /fret is already the published fixture: retain the template proof but
    // create this editor-owned draft on a run-scoped path.
    await create.getByLabel('Chemin public').fill(path);
    await create.getByRole('button', { name: 'Créer la page' }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);

    const editor = page.getByTestId('content-editor');
    const form = page.getByRole('form', { name: `Modifier : ${path}` });
    await expect(form.locator('.ops-content-block')).toHaveCount(8);
    await expect(editor.getByText('Jamais publiée')).toBeVisible();

    const preview = page.frameLocator('[data-testid="content-preview-frame"]');
    await expect(preview.getByRole('heading', { level: 1 })).toContainText(
      'Envoyez vos colis entre Paris et Dakar',
    );
    await expect(
      preview.getByRole('heading', { name: 'Votre envoi, étape par étape.' }),
    ).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Demander un devis' }).first()).toHaveAttribute(
      'href',
      '#questions',
    );

    // A normal generic block remains editable; saving never publishes it.
    const hero = form.locator('.ops-content-block').first();
    await hero.locator('summary').click();
    await hero
      .getByLabel('Introduction')
      .fill('Présentation éditoriale de fret modifiée par le scénario navigateur.');
    await form.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(notice(page, 'Brouillon enregistré')).toBeVisible();
    await expect(editor.getByText('Jamais publiée')).toBeVisible();

    const live = await request.get(
      `${BROWSER_API_URL}/v1/content/pages?path=${encodeURIComponent(path)}`,
    );
    expect(live.status()).toBe(404);
    expect(errors).toEqual([]);
  });

  test('a page whose template cannot be applied is still reachable', async ({ page }) => {
    const run = process.env.E2E_RUN_ID ?? '';
    const path = `/e2e-modele-echec-${run}`;
    await signedIn(page.context(), 'contentEditor');
    // The draft save of the template fails once (e.g. the network drops).
    await page.route(`${BROWSER_API_URL}/v1/admin/content/entries/*/draft`, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Service indisponible.' }),
          })
        : route.fallback(),
    );
    await page.goto(appUrl(ops, '/contenus'));
    const create = page.getByRole('form', { name: 'Créer une page' });
    await create.getByLabel('Modèle').selectOption({ label: 'Nos bus' });
    await create.getByLabel('Chemin public').fill(path);
    await create.getByRole('button', { name: 'Créer la page' }).click();
    await expect(create.getByRole('alert')).toContainText(
      `La page ${path} a été créée, mais le modèle n’a pas pu être appliqué : Service indisponible.`,
    );
    await expect(page).toHaveURL(appUrl(ops, '/contenus'));
    // The page exists: it is opened instead of being created a second time.
    await create.getByRole('button', { name: 'Ouvrir la page créée' }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);
    await expect(
      page.getByTestId('content-editor').getByRole('heading', { level: 2, name: path }),
    ).toBeVisible();
  });

  test('without content.read the menu is absent and the API refuses the content', async ({
    page,
  }) => {
    await signedIn(page.context(), 'contentDenied');
    await page.goto(appUrl(ops, '/'));
    await expect(mainNav(page)).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Contenus du site' })).toHaveCount(0);
    await page.goto(appUrl(ops, '/contenus'));
    await expect(page.getByTestId('content-workspace')).toHaveCount(0);
    const api = directAdminApi(page.request);
    expect((await api.get('/content/entries')).status()).toBe(403);
    expect(
      (
        await api.post('/content/entries', {
          kind: 'PAGE',
          path: '/refus',
          title: 'Refus',
          description: 'Refus',
        })
      ).status(),
    ).toBe(403);
  });
});

/**
 * PUBLIC-HOME-1: the home page model (Voyageurs · Colis · Fret) is loaded as a
 * draft of `/` and never published from here. The public website only serves
 * published revisions, so the shared home page of the other scenarios keeps
 * its default content. A CONTENT_EDITOR has no seo.manage: the SEO is kept.
 */
test.describe('ops home page model', () => {
  test('loads the Voyageurs · Colis · Fret sections as an unpublished draft of the home page', async ({
    page,
  }) => {
    await signedIn(page.context(), 'contentEditor');
    await page.goto(appUrl(ops, '/contenus'));
    await expect(page.getByTestId('content-workspace')).toBeVisible();
    const createHome = page.getByRole('button', {
      name: 'Créer la page d’accueil à partir du contenu actuel',
    });
    if (await createHome.count()) await createHome.click();
    else await page.getByRole('link', { name: /la page \/$/ }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);

    const editor = page.getByTestId('content-editor');
    await expect(editor.getByRole('heading', { level: 2, name: '/' })).toBeVisible();
    const model = page.getByRole('form', { name: 'Charger le modèle de page d’accueil' });
    await expect(editor).toContainText('Le référencement actuel est conservé');
    await model.getByRole('button', { name: 'Charger le modèle Voyageurs · Colis · Fret' }).click();
    await model.getByRole('button', { name: 'Charger dans le brouillon' }).click();
    await expect(
      notice(page, 'Modèle Voyageurs · Colis · Fret chargé dans le brouillon'),
    ).toBeVisible();

    // A draft only: nothing is published, the SEO field stays an seo.manage decision.
    await expect(editor.getByText('Jamais publiée')).toBeVisible();
    await expect(editor.locator('.ops-content-badge--live')).toHaveCount(0);
    await expect(editor.getByLabel('Description dans les résultats de recherche')).toBeDisabled();
    const preview = page.frameLocator('[data-testid="content-preview-frame"]');
    await expect(preview.getByRole('heading', { level: 1 })).toHaveText(
      'Voyagez et expédiez entre l’Europe et l’Afrique',
    );
    await expect(
      preview.getByRole('heading', { name: 'Voyageurs, colis ou fret : choisissez votre service' }),
    ).toBeVisible();
  });
});
