# Settlement and reconciliation (PAY-HUB-1, PAY-EU-1, PAY-PAYPAL-1, PAY-SN-1A)

Three facts, at three moments, in three models:

| Fact                  | Model               | When                                  | Changes              |
| --------------------- | ------------------- | ------------------------------------- | -------------------- |
| The payer was quoted  | `PaymentQuote`      | Before the attempt                    | Nothing (immutable)  |
| The payment succeeded | `Payment` SUCCEEDED | On the provider's authenticated event | Confirms the booking |
| The money was settled | `PaymentSettlement` | Later, from the provider or the bank  | Nothing else, ever   |

**`Payment.SUCCEEDED` is not "settlement received".** A settlement arriving
days later never changes the payment or the booking retroactively. Provider
settlements are also **not** the operating-expense `Payout` of PR-22.

## PaymentSettlement (foundation)

PAY-HUB-1 creates the table and its guards; no service writes it yet (each
provider PR adds its settlement import). One row per settled payment:

| Column                                                   | Meaning                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `paymentId`                                              | The SUCCEEDED payment (unique: one settlement per payment).      |
| `provider`, `providerTransactionId`                      | Must be the payment's provider and its `providerPaymentId`.      |
| `settlementReference`                                    | The provider's or bank's batch reference (unique per provider).  |
| `grossAmountMinor`, `providerFeeMinor`, `netAmountMinor` | Net = gross − fee, fee ≥ 0 (CHECK).                              |
| `settlementCurrencyCode`, `settlementCurrencyMinorUnit`  | May differ from both the booking and the presentment currency.   |
| `settledAt`                                              | When the provider settled (never more than 5 min in the future). |
| `recordedAt`                                             | Set by PostgreSQL when the row is written.                       |

Guards (`payment_settlement_guard`): only for a SUCCEEDED payment, with its
own provider transaction; immutable (no update, delete or truncate). There is
no parallel ledger: finance keeps reading `Payment` amounts (booking currency),
and the settlement is the reconciliation evidence.

## Reconciling

For a provider and a period:

1. every SUCCEEDED payment of that provider should eventually have one
   settlement; a missing one is a reconciliation item, not a payment error;
2. the settled gross is compared with the quote's presentment amount (what
   the payer was asked for), and the fee is recorded as such;
3. the booking amount (`Payment.amountMinor`) stays the business amount.

STAFF can already filter attempts by provider, method, payer country,
presentment currency and creation period (`GET /v1/admin/payments`), and the
staff view shows each attempt's quote (method, country, presented amount,
rate).

## Stripe (PAY-EU-1)

Never confuse, for a Stripe attempt:

1. `Payment` SUCCEEDED: a signed Checkout event said the session was paid;
2. the Stripe charge (PaymentIntent) that collected it;
3. its balance transaction (gross, Stripe fee, net), once Stripe knows it;
4. the payout that later moves a batch of balance to the bank.

None of 2-4 is imported yet: no fee, net or payout is invented, and
`payment_settlement` stays empty for Stripe until a settlement import PR.

Money collected without a confirmed booking (a success after the hold, or on
a cancelled attempt) is visible as a `PAYMENT_SUCCEEDED` event on an attempt
that is not SUCCEEDED; it is refunded from the Stripe Dashboard, then the
refund is recorded in OPS. See [stripe-europe.md](stripe-europe.md#reconciliation).

## PayPal (PAY-PAYPAL-1)

Five PayPal facts, never merged: the **order** (stored as
`providerPaymentId`), its **capture** (the money; a `PAYMENT.CAPTURE.COMPLETED`
event succeeds the attempt), a **refund**, PayPal's **fee**
(`seller_receivable_breakdown`, not read) and the **payout** to the bank. Only
the order id is kept; no capture id, fee, net amount, settlement or payout is
stored or invented.

A capture completed after the hold, or after a trip or booking cancellation,
is recorded and refused: it shows as a `PAYMENT_SUCCEEDED` event on an attempt
that is not SUCCEEDED (the query above, with `p.provider = 'PAYPAL'`), and is
refunded in the PayPal account, then recorded in OPS. See
[paypal.md](paypal.md#refunds-and-reconciliation).

## Wave Sénégal direct (PAY-SN-1A)

Le `providerPaymentId` est l'id de Checkout Session `cos-…`; le
`client_reference` est toujours `Payment.reference`. Avant de créer une
session, et après tout timeout de création, l'adaptateur utilise la recherche
officielle par `client_reference`. Un résultat exact est repris, zéro résultat
permet la création, plusieurs résultats bloquent l'initiation. Un timeout
reste `PENDING`, jamais `FAILED` automatiquement.

Les cas à réconcilier sont : PENDING sans id après un résultat de création
inconnu; événement succès après expiration du hold ou annulation; expiration
Wave au résultat inconnu; montant, devise ou référence discordants; checkout
`complete/succeeded` dont l'événement signé n'est pas encore arrivé. Ils ne
doivent jamais être résolus depuis le retour navigateur.

Wave documente un endpoint de remboursement, mais PAY-SN-1A ne l'appelle pas.
Tout argent reçu sans réservation confirmée est traité manuellement dans le
compte Wave puis enregistré dans OPS, en conservant l'événement et son hash
comme preuve. Aucun frais, net, batch de règlement ou remboursement provider
n'est inventé dans `payment_settlement`. Voir
[wave-senegal.md](wave-senegal.md).
