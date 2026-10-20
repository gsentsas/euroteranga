# Payment matrix (PAY-HUB-1, PAY-EU-1)

What EURO TERANGA intends to offer each payer country, and how far each
method really is. Four distinct facts, never to be confused:

| Column      | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| SUPPORTED   | The method is in the catalogue (`payment-catalog.ts`) for that country: we intend to offer it. |
| IMPLEMENTED | A real provider adapter in the code collects it there (SANDBOX, test-only, is not counted).    |
| CONFIGURED  | An adapter is wired in this environment, with its merchant account and secrets.                |
| LIVE        | Configured, active and moving real money.                                                      |

Current state: every row below is SUPPORTED; IMPLEMENTED is given per row
(only **STRIPE**, since PAY-EU-1, for `CARD` in France and Spain, `BIZUM` in
Spain and `KLARNA` in France and Spain); **CONFIGURED = NO and LIVE = NO
everywhere**. Production and the pilot run with `PAYMENT_PROVIDER=DISABLED`
and `PAYMENT_STRIPE_MODE=DISABLED`: no method is available there, and the
payment options API says so (`available: false`).

**SANDBOX** collects every method of every country except the `ASYNC_LONG`
ones, in local and CI only (refused by the configuration in staging and
production). It is test-only: it moves no money and is never LIVE.

- **Confirmation**: `INSTANT` (completed on the spot), `ASYNC_SHORT` (a result
  within minutes, inside the hold), `ASYNC_LONG` (days: unavailable until a
  booking policy exists, `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY`).
- **Cards**: one `CARD` choice per country. Its accepted networks are badges
  coming from the provider that would collect it (Stripe: CB, Visa,
  Mastercard, American Express in France; Visa, Mastercard, American Express
  in Spain). `CARD_CB`, `CARD_VISA`, `CARD_MASTERCARD` and `CARD_AMEX` remain
  vocabulary only and are never offered.
- **Declared providers** are those the capability registry
  (`payment-capability.registry.ts`) lists for the method in that country and
  currency, best first. Apart from STRIPE (checked against Stripe's
  documentation, see [stripe-europe.md](stripe-europe.md)), they are
  **planning hypotheses**, to be checked before their adapter PR
  ([provider-onboarding.md](provider-onboarding.md)).
- **Notes** give the documented reason when a provider able to offer a method
  does not collect it for EURO TERANGA.

The tables are generated from the catalogue and the registry; regenerate them
when either changes.

### France (FR), EUR

| Method                 | Label                        | Confirmation | Declared providers | SUPPORTED | IMPLEMENTED  | CONFIGURED | LIVE | Note                                                                                     |
| ---------------------- | ---------------------------- | ------------ | ------------------ | --------- | ------------ | ---------- | ---- | ---------------------------------------------------------------------------------------- |
| `CARD`                 | Carte bancaire (recommended) | INSTANT      | `STRIPE`           | YES       | YES (STRIPE) | NO         | NO   | —                                                                                        |
| `APPLE_PAY`            | Apple Pay                    | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `NOT_SELECTABLE_IN_CHECKOUT`                                                     |
| `GOOGLE_PAY`           | Google Pay                   | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `NOT_SELECTABLE_IN_CHECKOUT`                                                     |
| `PAYPAL`               | PayPal                       | INSTANT      | `PAYPAL`           | YES       | NO           | NO         | NO   | STRIPE: `SEPARATE_PROVIDER_PR`                                                           |
| `SEPA_CREDIT_TRANSFER` | Virement SEPA                | ASYNC_LONG   | —                  | YES       | NO           | NO         | NO   | `ASYNC_LONG`: needs a booking policy; STRIPE: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY` |
| `SEPA_DIRECT_DEBIT`    | Prélèvement SEPA             | ASYNC_LONG   | —                  | YES       | NO           | NO         | NO   | `ASYNC_LONG`: needs a booking policy; STRIPE: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY` |
| `WERO`                 | Wero                         | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `NOT_SUPPORTED_BY_PINNED_SDK`                                                    |
| `KLARNA`               | Klarna                       | INSTANT      | `STRIPE`           | YES       | YES (STRIPE) | NO         | NO   | —                                                                                        |
| `ALMA`                 | Alma                         | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `BUSINESS_CATEGORY_PROHIBITED`                                                   |

### Espagne (ES), EUR

| Method                 | Label               | Confirmation | Declared providers | SUPPORTED | IMPLEMENTED  | CONFIGURED | LIVE | Note                                                                                     |
| ---------------------- | ------------------- | ------------ | ------------------ | --------- | ------------ | ---------- | ---- | ---------------------------------------------------------------------------------------- |
| `CARD`                 | Carte bancaire      | INSTANT      | `STRIPE`           | YES       | YES (STRIPE) | NO         | NO   | —                                                                                        |
| `APPLE_PAY`            | Apple Pay           | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `NOT_SELECTABLE_IN_CHECKOUT`                                                     |
| `GOOGLE_PAY`           | Google Pay          | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `NOT_SELECTABLE_IN_CHECKOUT`                                                     |
| `PAYPAL`               | PayPal              | INSTANT      | `PAYPAL`           | YES       | NO           | NO         | NO   | STRIPE: `SEPARATE_PROVIDER_PR`                                                           |
| `SEPA_CREDIT_TRANSFER` | Virement SEPA       | ASYNC_LONG   | —                  | YES       | NO           | NO         | NO   | `ASYNC_LONG`: needs a booking policy; STRIPE: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY` |
| `SEPA_DIRECT_DEBIT`    | Prélèvement SEPA    | ASYNC_LONG   | —                  | YES       | NO           | NO         | NO   | `ASYNC_LONG`: needs a booking policy; STRIPE: `ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY` |
| `BIZUM`                | Bizum (recommended) | INSTANT      | `STRIPE`           | YES       | YES (STRIPE) | NO         | NO   | —                                                                                        |
| `KLARNA`               | Klarna              | INSTANT      | `STRIPE`           | YES       | YES (STRIPE) | NO         | NO   | —                                                                                        |
| `ALMA`                 | Alma                | INSTANT      | —                  | YES       | NO           | NO         | NO   | STRIPE: `BUSINESS_CATEGORY_PROHIBITED`                                                   |

### Maroc (MA), MAD

| Method                | Label                   | Confirmation | Declared providers     | SUPPORTED | IMPLEMENTED | CONFIGURED | LIVE | Note                                 |
| --------------------- | ----------------------- | ------------ | ---------------------- | --------- | ----------- | ---------- | ---- | ------------------------------------ |
| `CARD`                | Carte bancaire          | INSTANT      | `CMI`                  | YES       | NO          | NO         | NO   | —                                    |
| `MAROCPAY`            | MarocPay                | ASYNC_SHORT  | `CMI`, `CHARIPAY`      | YES       | NO          | NO         | NO   | —                                    |
| `CMI_CARD`            | Carte CMI (recommended) | INSTANT      | `CMI`                  | YES       | NO          | NO         | NO   | —                                    |
| `MOROCCO_CASH_AGENCY` | Paiement en agence      | ASYNC_LONG   | `CASH`                 | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |
| `BANK_TRANSFER`       | Virement bancaire       | ASYNC_LONG   | `MANUAL_BANK_TRANSFER` | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |

### Mauritanie (MR), MRU

| Method           | Label                 | Confirmation | Declared providers     | SUPPORTED | IMPLEMENTED | CONFIGURED | LIVE | Note                                 |
| ---------------- | --------------------- | ------------ | ---------------------- | --------- | ----------- | ---------- | ---- | ------------------------------------ |
| `CARD`           | Carte bancaire        | INSTANT      | —                      | YES       | NO          | NO         | NO   | —                                    |
| `BANKILY_MR`     | Bankily (recommended) | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `MASRVI_MR`      | Masrvi                | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `SEDAD_MR`       | Sedad                 | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `BIMBANK_MR`     | BimBank               | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `CLICK_MR`       | Click                 | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `BCI_PAY_MR`     | BCI Pay               | ASYNC_SHORT  | `MOOSYL`               | YES       | NO          | NO         | NO   | —                                    |
| `BANK_TRANSFER`  | Virement bancaire     | ASYNC_LONG   | `MANUAL_BANK_TRANSFER` | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |
| `CASH_AT_AGENCY` | Paiement en agence    | ASYNC_LONG   | `CASH`                 | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |

### Sénégal (SN), XOF

| Method            | Label              | Confirmation | Declared providers                    | SUPPORTED | IMPLEMENTED | CONFIGURED | LIVE | Note                                 |
| ----------------- | ------------------ | ------------ | ------------------------------------- | --------- | ----------- | ---------- | ---- | ------------------------------------ |
| `CARD`            | Carte bancaire     | INSTANT      | `PAYDUNYA`, `PAYTECH`                 | YES       | NO          | NO         | NO   | —                                    |
| `PAYPAL`          | PayPal             | INSTANT      | `PAYPAL`                              | YES       | NO          | NO         | NO   | —                                    |
| `WAVE_SN`         | Wave (recommended) | ASYNC_SHORT  | `WAVE`, `PAYDUNYA`, `PAYTECH`         | YES       | NO          | NO         | NO   | —                                    |
| `ORANGE_MONEY_SN` | Orange Money       | ASYNC_SHORT  | `ORANGE_MONEY`, `PAYDUNYA`, `PAYTECH` | YES       | NO          | NO         | NO   | —                                    |
| `FREE_MONEY_SN`   | Free Money         | ASYNC_SHORT  | `PAYDUNYA`, `PAYTECH`                 | YES       | NO          | NO         | NO   | —                                    |
| `EXPRESSO_SN`     | Expresso           | ASYNC_SHORT  | `PAYDUNYA`, `PAYTECH`                 | YES       | NO          | NO         | NO   | —                                    |
| `WIZALL_SN`       | Wizall             | ASYNC_SHORT  | `PAYDUNYA`, `PAYTECH`                 | YES       | NO          | NO         | NO   | —                                    |
| `DJAMO_SN`        | Djamo              | ASYNC_SHORT  | `PAYDUNYA`, `PAYTECH`                 | YES       | NO          | NO         | NO   | —                                    |
| `BANK_TRANSFER`   | Virement bancaire  | ASYNC_LONG   | `MANUAL_BANK_TRANSFER`                | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |
| `CASH_AT_AGENCY`  | Paiement en agence | ASYNC_LONG   | `CASH`                                | YES       | NO          | NO         | NO   | `ASYNC_LONG`: needs a booking policy |

## Presentment currencies

| Payer country | Currency | Minor unit |
| ------------- | -------- | ---------- |
| FR, ES        | EUR      | 2          |
| MA            | MAD      | 2          |
| MR            | MRU      | 2          |
| SN            | XOF      | 0          |

See [multi-currency.md](multi-currency.md).
