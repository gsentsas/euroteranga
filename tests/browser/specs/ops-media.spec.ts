import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { preauthenticatedSession } from '../fixtures.js';
import { BROWSER_API_URL, directAdminApi } from '../staff.js';

const ops = appByName('ops');
const web = appByName('web');

/** Pre-created session: this scenario does not consume the shared login-IP budget. */
async function signedIn(context: BrowserContext) {
  await context.addCookies([
    {
      name: 'et_staff_session',
      value: preauthenticatedSession('mediaEditor'),
      url: BROWSER_API_URL,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A synthetic RGB PNG: a horizontal gradient, its colour derived from the run. */
function syntheticPng(width: number, height: number, seed: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      rows[row + 1 + x * 3] = (seed * 37 + x) % 256;
      rows[row + 2 + x * 3] = (seed * 91 + y) % 256;
      rows[row + 3 + x * 3] = 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function notice(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

/** The image really loaded (CSP img-src, CORP), not only an <img> element. */
async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

/**
 * MEDIA-1: a CONTENT_EDITOR imports an image into the public media library,
 * describes it, chooses it in a page, sees it in the sandboxed preview and
 * on the website (WebP from the API origin), and cannot archive it while
 * the page shows it.
 */
test.describe('ops public media library', () => {
  test('an editor imports an image, uses it on a page and cannot archive it while shown', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const run = process.env.E2E_RUN_ID ?? `${Date.now()}`;
    const seed = [...run].reduce((total, char) => total + char.charCodeAt(0), 0);
    const alt = `Autocar EURO TERANGA au départ ${run}`;
    const path = `/e2e-media-${run}`;
    const png = syntheticPng(640, 480, seed);

    await signedIn(page.context());
    await page.goto(appUrl(ops, '/'));
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Médiathèque' })
      .click();
    await expect(page).toHaveURL(appUrl(ops, '/mediatheque'));
    await expect(page.getByTestId('media-library')).toBeVisible();

    await page.getByRole('button', { name: 'Importer une image' }).click();
    const upload = page.getByTestId('media-upload-form');
    // Refused formats are explained before anything is sent.
    await upload.getByLabel('Fichier image').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    await expect(upload.getByRole('alert')).toContainText('Formats acceptés');
    await upload
      .getByLabel('Fichier image')
      .setInputFiles({ name: 'autocar.png', mimeType: 'image/png', buffer: png });
    await upload.getByLabel('Texte alternatif').fill(alt);
    await upload.getByLabel(/^Crédit photo/).fill('EURO TERANGA (synthétique)');
    await upload.getByLabel(/^Horizontal/).fill('30');
    await upload.getByRole('button', { name: 'Importer l’image' }).click();
    await expect(notice(page, 'Image importée.')).toBeVisible();

    const detail = page.getByTestId('media-detail');
    await expect(detail.getByRole('heading', { level: 2, name: alt })).toBeVisible();
    await expect(detail.getByText('640 × 480 px')).toBeVisible();
    await expect(detail.getByLabel(/^Horizontal/)).toHaveValue('30');
    await expectLoaded(
      page.getByRole('list', { name: 'Images' }).getByRole('button', { name: alt }).locator('img'),
    );
    await detail.getByLabel(/^Légende/).fill('Départ du soir (synthétique)');
    await detail.getByRole('button', { name: 'Enregistrer la description' }).click();
    await expect(notice(page, 'Description enregistrée.')).toBeVisible();

    // The same file twice is refused; the existing image is one click away.
    await page.getByRole('button', { name: 'Importer une image' }).click();
    await upload
      .getByLabel('Fichier image')
      .setInputFiles({ name: 'copie.png', mimeType: 'image/png', buffer: png });
    await upload.getByLabel('Texte alternatif').fill('Copie');
    await upload.getByRole('button', { name: 'Importer l’image' }).click();
    await expect(upload.getByRole('alert')).toContainText('déjà dans la médiathèque');
    await upload.getByRole('button', { name: 'Ouvrir l’image déjà présente' }).click();
    await expect(detail.getByRole('heading', { level: 2, name: alt })).toBeVisible();

    // A page shows the image, chosen in the editor's picker.
    await page.goto(appUrl(ops, '/contenus'));
    const create = page.getByRole('form', { name: 'Créer une page' });
    await create.getByLabel('Chemin public').fill(path);
    await create.getByLabel('Titre').fill(`Médiathèque ${run}`);
    await create
      .getByLabel('Description pour les moteurs de recherche')
      .fill('Page créée par le scénario navigateur MEDIA-1.');
    await create.getByRole('button', { name: 'Créer la page' }).click();
    await expect(page).toHaveURL(/\/contenus\/edition\?entree=/);

    const form = page.getByRole('form', { name: `Modifier : ${path}` });
    // The social image is search metadata: locked without seo.manage.
    const social = form.locator('.ops-content-media').filter({ hasText: 'Image de partage' });
    await expect(social.getByText('Aucune image.')).toBeVisible();
    await expect(social.getByRole('button')).toHaveCount(0);
    await form.getByLabel('Nouvelle section').selectOption('image');
    await form.getByRole('button', { name: 'Ajouter la section' }).click();
    const block = form.locator('.ops-content-block').nth(0);
    await block.getByRole('button', { name: 'Choisir une image' }).click();
    const picker = block.getByTestId('media-picker');
    await expect(picker.getByRole('heading', { name: /Choisir une image/ })).toBeFocused();
    await picker.getByRole('button', { name: `Choisir : ${alt}` }).click();
    await expect(picker).toHaveCount(0);
    await expectLoaded(block.getByRole('img', { name: alt }));

    const preview = page.frameLocator('[data-testid="content-preview-frame"]');
    await expectLoaded(preview.getByRole('img', { name: alt }));
    await expect(preview.getByText('Crédit photo : EURO TERANGA (synthétique)')).toBeVisible();

    await form.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(notice(page, 'Brouillon enregistré (révision 1)')).toBeVisible();
    const publish = page.getByRole('form', { name: 'Publier le brouillon' });
    await publish.getByRole('button', { name: 'Publier le brouillon' }).click();
    await publish.getByRole('button', { name: 'Publier maintenant' }).click();
    await expect(notice(page, 'Révision 1 publiée')).toBeVisible();

    // The website serves responsive WebP renditions from the API origin.
    const site = await page.context().newPage();
    const response = await site.goto(appUrl(web, path));
    expect(response?.status()).toBe(200);
    const image = site.getByRole('img', { name: alt });
    await expectLoaded(image);
    expect(await image.getAttribute('src')).toMatch(
      // 640 px wide: renditions of 480 and 640 px, the larger one as fallback.
      new RegExp(`^${BROWSER_API_URL}/v1/media/files/[0-9a-f-]{36}/640\\.webp$`),
    );
    expect(await image.getAttribute('srcset')).toMatch(/480\.webp 480w, .+640\.webp 640w$/);
    await expect(site.getByText('Départ du soir (synthétique)')).toBeVisible();
    await expect(site.getByText('Crédit photo : EURO TERANGA (synthétique)')).toBeVisible();
    await site.close();

    // Shown by a page: archiving is not offered, and the API refuses it.
    await page.goto(appUrl(ops, '/mediatheque'));
    await page.getByRole('list', { name: 'Images' }).getByRole('button', { name: alt }).click();
    await expect(detail.getByText(`Page ${path} (en ligne)`)).toBeVisible();
    await expect(detail.getByText('Retirez d’abord l’image des contenus')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Archiver l’image' })).toHaveCount(0);
    const api = directAdminApi(page.request);
    const listed = (await (await api.get('/media?limit=100')).json()) as {
      items: Array<{ id: string; altText: string }>;
    };
    const id = listed.items.find((item) => item.altText === alt)!.id;
    const refused = await api.post(`/media/${id}/archive`, { reason: 'Encore affichée' });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('MEDIA_IN_USE');

    expect(errors).toEqual([]);
  });
});
