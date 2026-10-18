import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { bookingSeed, FIXTURE_PASSWORD, FIXTURES, paymentSeed } from '../fixtures.js';
import { directAdminApi, signInAndEnroll } from '../staff.js';

const bookingApp = appByName('booking');
const clientApp = appByName('client');
const opsApp = appByName('ops');

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigation principale' });
}

async function searchBookableTrip(page: Page): Promise<void> {
  const seed = bookingSeed();
  await page.getByLabel('Origine', { exact: true }).selectOption({
    label: `Gare de départ réservation (Ville départ, ${seed.countryName})`,
  });
  await page.getByLabel('Destination', { exact: true }).selectOption({
    label: `Gare d’arrivée réservation (Ville arrivée, ${seed.countryName})`,
  });
  await page.getByLabel('Date de départ', { exact: true }).fill(seed.departureDate);
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  const result = page.getByRole('article').filter({ hasText: seed.tripReference });
  // Exact per-seat fare and live availability, before any choice.
  await expect(result).toContainText('123,45 EUR');
  await expect(result).toContainText(/sur 4 sièges disponibles/);
  await page.getByRole('button', { name: `Choisir le voyage ${seed.tripReference}` }).click();
  await expect(page.getByRole('heading', { name: 'Choisissez vos sièges' })).toBeVisible();
}

test('booking customer: two-seat hold, account cancellation and restored availability', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = trackPageErrors(page);
  const seed = bookingSeed();

  await page.goto(appUrl(bookingApp));
  await searchBookableTrip(page);
  const recap = page.getByRole('complementary', { name: 'Récapitulatif' });
  await expect(recap).toContainText('123,45 EUR');
  await page.getByRole('button', { name: 'Siège 1A, disponible' }).click();
  await page.getByRole('button', { name: 'Siège 1B, disponible' }).click();
  await expect(page.getByRole('button', { name: 'Siège 1A, disponible' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 2 x 123,45 EUR, computed exactly.
  await expect(page.getByTestId('booking-total')).toHaveText('246,90 EUR');
  await page.getByRole('button', { name: 'Retenir 2 sièges' }).click();

  const login = page.getByRole('form', { name: 'Connexion client' });
  await login.getByLabel('Adresse e-mail').fill(FIXTURES.customer.email);
  await login.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await login.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page.getByRole('heading', { name: 'Réservation provisoire' })).toBeVisible();
  await expect(page.getByText(seed.tripReference)).toBeVisible();
  await expect(page.getByText('1A, 1B')).toBeVisible();
  await expect(page.getByText('246,90 EUR')).toBeVisible();
  const reference = (await page.getByTestId('booking-reference').textContent())?.trim() ?? '';
  expect(reference).toMatch(/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
  await expect(page.getByTestId('booking-expiration')).toContainText('(Etc/UTC)');
  await expect(page.getByText('Vos sièges sont retenus jusqu’au')).toBeVisible();
  // A provisional hold: nothing is paid and no ticket is issued.
  await expect(page.getByText(/Paiement réussi|Billet confirmé|Achat effectué/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Mes réservations' }).click();
  await expect(page).toHaveURL(appUrl(clientApp, '/compte'));
  const customerBooking = page.getByRole('article', { name: reference });
  await expect(customerBooking).toContainText('Provisoire');
  await expect(customerBooking).toContainText('1A, 1B');
  await customerBooking
    .getByRole('button', { name: `Annuler la réservation ${reference}` })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: `Réservation ${reference} annulée.` }),
  ).toBeVisible();
  await expect(page.getByRole('article', { name: reference })).toContainText('Annulée');

  await page.goto(appUrl(bookingApp));
  await searchBookableTrip(page);
  await expect(page.getByRole('button', { name: 'Siège 1A, disponible' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Siège 1B, disponible' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('ops booking agent: MFA, list, detail and reasoned cancellation', async ({ page }) => {
  const errors = trackPageErrors(page);
  const seed = bookingSeed();
  await signInAndEnroll(page, FIXTURES.bookingAdmin.email);
  await mainNav(page).getByRole('link', { name: 'Réservations' }).click();
  await expect(page).toHaveURL(appUrl(opsApp, '/bookings'));
  await page
    .getByRole('button', { name: `Consulter la réservation ${seed.staffBookingReference}` })
    .click();
  await expect(page.locator('#booking-detail-panel')).toBeFocused();
  const detail = page.getByRole('region', {
    name: `Réservation ${seed.staffBookingReference}`,
  });
  await expect(detail).toContainText(seed.tripReference);
  await expect(detail).toContainText('2B');
  const cancel = detail.getByRole('form', {
    name: `Annuler la réservation ${seed.staffBookingReference}`,
  });
  await cancel.getByLabel('Motif de l’annulation').fill('Demande du client — scénario synthétique');
  await cancel.getByRole('button', { name: 'Annuler la réservation' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Réservation ${seed.staffBookingReference} annulée.` }),
  ).toBeVisible();
  await expect(detail).toContainText('Annulée');
  // PR-10 (same sign-in): BOOKING_AGENT holds payment.read. The booking shows
  // its (absent) payments, and the Paiements space lists and details them,
  // with no control able to make an attempt succeed.
  await expect(detail.getByTestId('booking-payments')).toContainText(
    'Aucune tentative de paiement.',
  );
  const payments = paymentSeed();
  await mainNav(page).getByRole('link', { name: 'Paiements' }).click();
  await expect(page).toHaveURL(appUrl(opsApp, '/payments'));
  const row = page.getByRole('row').filter({ hasText: payments.paymentReference });
  await expect(row).toContainText(payments.confirmedBookingReference);
  await expect(row).toContainText('Réussi');
  await expect(row).toContainText('123,45 EUR');
  await page
    .getByRole('button', { name: `Consulter le paiement ${payments.paymentReference}` })
    .click();
  await expect(page.locator('#payment-detail-panel')).toBeFocused();
  const payment = page.getByRole('region', { name: `Paiement ${payments.paymentReference}` });
  await expect(payment).toContainText('Confirmée');
  await expect(payment.getByTestId('payment-timeline')).toContainText(
    'Succès signalé par le prestataire',
  );
  // payment.read only: no cancellation form, and no "mark paid" control at all.
  await expect(payment.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /payé|forcer|marquer/i })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('ops booking.read: read-only UI and direct mutation refused', async ({ page }) => {
  const errors = trackPageErrors(page);
  const seed = bookingSeed();
  await signInAndEnroll(page, FIXTURES.bookingReader.email);
  await mainNav(page).getByRole('link', { name: 'Réservations' }).click();
  await expect(page.getByTestId('bookings-workspace')).toBeVisible();

  const list = await directAdminApi(page.request).get('/bookings?limit=100');
  expect(list.status()).toBe(200);
  const booking = (
    (await list.json()) as { items: Array<{ id: string; reference: string }> }
  ).items.find((candidate) => candidate.reference === seed.staffBookingReference);
  expect(booking).toBeDefined();
  await page
    .getByRole('button', { name: `Consulter la réservation ${seed.staffBookingReference}` })
    .click();
  await expect(page.getByTestId('booking-detail')).toBeVisible();
  await expect(page.getByRole('form', { name: /Annuler la réservation/ })).toHaveCount(0);

  const refused = await directAdminApi(page.request).post(`/bookings/${booking?.id}/cancel`, {
    reason: 'Mutation interdite',
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('FORBIDDEN');
  // PR-10 (same sign-in): booking.read without payment.read. No financial
  // payment detail on the booking, no Paiements menu, and the API refuses.
  await expect(page.getByTestId('booking-payments')).toHaveCount(0);
  const detail = await directAdminApi(page.request).get(`/bookings/${booking?.id}`);
  expect(detail.status()).toBe(200);
  expect(Object.keys((await detail.json()) as object)).not.toContain('payments');
  await expect(mainNav(page).getByRole('link', { name: 'Paiements' })).toHaveCount(0);
  const payments = await directAdminApi(page.request).get('/payments');
  expect(payments.status()).toBe(403);
  expect(((await payments.json()) as { code: string }).code).toBe('FORBIDDEN');
  await page.goto(appUrl(opsApp, '/payments'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('payments-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('ops without booking.read: menu absent and direct read refused', async ({ page }) => {
  const errors = trackPageErrors(page);
  await signInAndEnroll(page, FIXTURES.bookingDenied.email);
  await expect(mainNav(page).getByRole('link', { name: 'Réservations' })).toHaveCount(0);
  const refused = await directAdminApi(page.request).get('/bookings');
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('FORBIDDEN');

  await page.goto(appUrl(opsApp, '/bookings'));
  await expect(
    page.getByText('Vous n’avez pas la permission d’afficher cette page.'),
  ).toBeVisible();
  await expect(page.getByTestId('bookings-workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
