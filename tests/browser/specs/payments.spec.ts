import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { FIXTURE_PASSWORD, FIXTURES } from '../fixtures.js';
import { paymentSearch, sandboxSuccess, shortPaymentHold, waitForHoldExpiry } from '../payments.js';

const bookingApp = appByName('booking');
const clientApp = appByName('client');

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openPaymentTrip(page: Page) {
  const seed = paymentSearch();
  await page.goto(appUrl(bookingApp));
  await page.getByLabel('Origine', { exact: true }).selectOption({ label: seed.origin });
  await page.getByLabel('Destination', { exact: true }).selectOption({ label: seed.destination });
  await page.getByLabel('Date de départ', { exact: true }).fill(seed.departureDate);
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  await page.getByRole('button', { name: `Choisir le voyage ${seed.tripReference}` }).click();
  await expect(page.getByRole('heading', { name: 'Choisissez vos sièges' })).toBeVisible();
}

/**
 * One customer sign-in for the whole payment journey: the authentication
 * rate limit (30 sign-ins per client address per 15 minutes) is shared by
 * every browser scenario, all run from one address. The OPS payment
 * scenarios extend the booking OPS tests, which already sign in.
 */
test('payment customer: SANDBOX payments confirm bookings, which keep their seats after expiry', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  // A real hold expiring in 60 s (the minimum API lifetime), on seat 2A.
  const expiring = await shortPaymentHold(FIXTURES.paymentCustomer.email, '2A', 60_000);

  // Booking app: hold seat 1A, then pay it; nothing is collected in the page.
  await openPaymentTrip(page);
  await page.getByRole('button', { name: 'Siège 1A, disponible' }).click();
  await page.getByRole('button', { name: 'Retenir 1 siège' }).click();
  const login = page.getByRole('form', { name: 'Connexion client' });
  await login.getByLabel('Adresse e-mail').fill(FIXTURES.paymentCustomer.email);
  await login.getByLabel('Mot de passe', { exact: true }).fill(FIXTURE_PASSWORD);
  await login.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Réservation provisoire' })).toBeVisible();
  const reference = (await page.getByTestId('booking-reference').textContent())?.trim() ?? '';
  expect(reference).toMatch(/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
  const payment = page.getByRole('region', { name: 'Paiement' });
  await expect(payment.getByTestId('payment-test-mode')).toContainText('paiement simulé (SANDBOX)');
  await expect(payment).toContainText('jamais votre numéro de carte');
  // No card, security code or IBAN field, and no third-party frame.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  // PAY-HUB-1: a payer country and a method (France and a card by default),
  // then the exact amount quoted by the server, before anything starts.
  await expect(payment.getByLabel('Pays du payeur')).toHaveValue('FR');
  await payment.getByRole('button', { name: 'Continuer vers le paiement' }).click();
  await expect(payment.getByTestId('payment-quote-amount')).toHaveText('123,45 EUR');
  await payment
    .getByRole('button', {
      name: new RegExp(`^Confirmer le paiement de 123,45\\s+EUR pour ${reference}$`),
    })
    .click();
  await expect(payment.getByRole('status')).toContainText('en attente de confirmation');
  // The provider's signed event, sent by the test harness; the page refreshes by itself.
  const firstPayment = await sandboxSuccess(page.request, reference);
  await expect(page.getByRole('heading', { name: 'Réservation confirmée' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('booking-paid-amount')).toHaveText('123,45 EUR');
  await expect(page.getByTestId('payment-reference')).toHaveText(firstPayment);
  await expect(page.getByText(/Billet émis|Billet confirmé/)).toHaveCount(0);

  // Client app, same session: pay the expiring HELD booking from “Mes réservations”.
  await page.getByRole('link', { name: 'Mes réservations' }).click();
  await expect(page).toHaveURL(appUrl(clientApp, '/compte'));
  await expect(page.getByTestId('payment-test-mode')).toContainText('paiement simulé (SANDBOX)');
  await expect(page.getByRole('article', { name: reference })).toContainText('Confirmée');
  const held = page.getByRole('article', { name: expiring.reference });
  await expect(held).toContainText('Provisoire');
  await expect(held).toContainText('123,45 EUR');
  await held
    .getByRole('button', { name: `Continuer vers le paiement de ${expiring.reference}` })
    .click();
  await expect(held.getByTestId('payment-quote-amount')).toHaveText('123,45 EUR');
  await held
    .getByRole('button', {
      name: new RegExp(`^Confirmer le paiement de 123,45\\s+EUR pour ${expiring.reference}$`),
    })
    .click();
  await expect(held.getByRole('status')).toContainText('en attente de confirmation');
  await expect(held.getByRole('button', { name: /Continuer vers le paiement/ })).toHaveCount(0);
  const secondPayment = await sandboxSuccess(page.request, expiring.reference);
  expect(secondPayment).toMatch(/^ETP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
  await expect(held).toContainText('Confirmée', { timeout: 15_000 });
  await expect(page.getByTestId(`paid-amount-${expiring.reference}`)).toHaveText('123,45 EUR');
  await expect(page.getByTestId(`payment-reference-${expiring.reference}`)).toHaveText(
    secondPayment,
  );
  await expect(held.getByRole('button', { name: /Annuler la réservation/ })).toHaveCount(0);
  await expect(page.getByText(/Billet émis|Remboursement/)).toHaveCount(0);

  // Once the hold time has passed, both paid seats stay unavailable.
  await waitForHoldExpiry(expiring.id, 90_000);
  await page.reload();
  await expect(page.getByRole('article', { name: expiring.reference })).toContainText('Confirmée');
  await openPaymentTrip(page);
  await expect(page.getByRole('button', { name: 'Siège 2A, indisponible' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Siège 1A, indisponible' })).toBeDisabled();
  expect(errors).toEqual([]);
});
