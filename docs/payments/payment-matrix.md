# Payment matrix (PAY-HUB-1)

What EURO TERANGA intends to offer each payer country, and how far each
method really is. Four distinct facts, never to be confused:

| Column      | Meaning                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| SUPPORTED   | The method is in the catalogue (`payment-catalog.ts`) for that country: we intend to offer it.                          |
| IMPLEMENTED | A provider adapter able to collect it exists in the code. PAY-HUB-1 only builds the foundation: no real adapter exists. |
| CONFIGURED  | An adapter is wired in this environment, with its merchant account and secrets.                                         |
| LIVE        | Configured, active and moving real money.                                                                               |

Current state, for every row below: SUPPORTED = YES, IMPLEMENTED = foundation
only (no adapter), CONFIGURED = NO, LIVE = NO. Production runs with
`PAYMENT_PROVIDER=DISABLED`: no method is available there, and the payment
options API says so (`available: false`).

**SANDBOX** collects every method of every country, in local and CI only
(refused by the configuration in staging and production). It is test-only:
it moves no money and is never LIVE.

"Declared providers" are the providers the capability registry
(`payment-capability.registry.ts`) lists as able to collect the method in that
country and currency, best first. They are **planning hypotheses**: each one
must be checked against the provider's contract and documentation before its
adapter PR (see [provider-onboarding.md](provider-onboarding.md)). A method
with no declared provider still needs one to be chosen.

The tables are generated from the catalogue and the registry; regenerate them
when either changes.

### France (FR), EUR

| Method                 | Label                  | Declared providers | SUPPORTED | IMPLEMENTED                 | CONFIGURED | LIVE |
| ---------------------- | ---------------------- | ------------------ | --------- | --------------------------- | ---------- | ---- |
| `CARD_CB`              | Carte CB (recommended) | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_VISA`            | Visa                   | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_MASTERCARD`      | Mastercard             | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_AMEX`            | American Express       | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `APPLE_PAY`            | Apple Pay              | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `GOOGLE_PAY`           | Google Pay             | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `PAYPAL`               | PayPal                 | `PAYPAL`           | YES       | foundation only, no adapter | NO         | NO   |
| `SEPA_CREDIT_TRANSFER` | Virement SEPA          | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `SEPA_DIRECT_DEBIT`    | Prélèvement SEPA       | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `BIZUM`                | Bizum                  | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `WERO`                 | Wero                   | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `KLARNA`               | Klarna                 | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `ALMA`                 | Alma                   | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |

### Espagne (ES), EUR

| Method                 | Label               | Declared providers | SUPPORTED | IMPLEMENTED                 | CONFIGURED | LIVE |
| ---------------------- | ------------------- | ------------------ | --------- | --------------------------- | ---------- | ---- |
| `CARD_VISA`            | Visa                | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_MASTERCARD`      | Mastercard          | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_AMEX`            | American Express    | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `APPLE_PAY`            | Apple Pay           | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `GOOGLE_PAY`           | Google Pay          | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `PAYPAL`               | PayPal              | `PAYPAL`           | YES       | foundation only, no adapter | NO         | NO   |
| `SEPA_CREDIT_TRANSFER` | Virement SEPA       | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `SEPA_DIRECT_DEBIT`    | Prélèvement SEPA    | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `BIZUM`                | Bizum (recommended) | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |
| `KLARNA`               | Klarna              | `STRIPE`           | YES       | foundation only, no adapter | NO         | NO   |

### Maroc (MA), MAD

| Method                | Label                   | Declared providers     | SUPPORTED | IMPLEMENTED                 | CONFIGURED | LIVE |
| --------------------- | ----------------------- | ---------------------- | --------- | --------------------------- | ---------- | ---- |
| `CARD_VISA`           | Visa                    | `CMI`, `STRIPE`        | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_MASTERCARD`     | Mastercard              | `CMI`, `STRIPE`        | YES       | foundation only, no adapter | NO         | NO   |
| `MAROCPAY`            | MarocPay                | `CMI`, `CHARIPAY`      | YES       | foundation only, no adapter | NO         | NO   |
| `CMI_CARD`            | Carte CMI (recommended) | `CMI`                  | YES       | foundation only, no adapter | NO         | NO   |
| `MOROCCO_CASH_AGENCY` | Paiement en agence      | `CASH`                 | YES       | foundation only, no adapter | NO         | NO   |
| `BANK_TRANSFER`       | Virement bancaire       | `MANUAL_BANK_TRANSFER` | YES       | foundation only, no adapter | NO         | NO   |

### Mauritanie (MR), MRU

| Method            | Label                 | Declared providers     | SUPPORTED | IMPLEMENTED                 | CONFIGURED | LIVE |
| ----------------- | --------------------- | ---------------------- | --------- | --------------------------- | ---------- | ---- |
| `CARD_VISA`       | Visa                  | `STRIPE`               | YES       | foundation only, no adapter | NO         | NO   |
| `CARD_MASTERCARD` | Mastercard            | `STRIPE`               | YES       | foundation only, no adapter | NO         | NO   |
| `BANKILY_MR`      | Bankily (recommended) | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `MASRVI_MR`       | Masrvi                | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `SEDAD_MR`        | Sedad                 | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `BIMBANK_MR`      | BimBank               | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `CLICK_MR`        | Click                 | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `BCI_PAY_MR`      | BCI Pay               | `MOOSYL`               | YES       | foundation only, no adapter | NO         | NO   |
| `BANK_TRANSFER`   | Virement bancaire     | `MANUAL_BANK_TRANSFER` | YES       | foundation only, no adapter | NO         | NO   |
| `CASH_AT_AGENCY`  | Paiement en agence    | `CASH`                 | YES       | foundation only, no adapter | NO         | NO   |

### Sénégal (SN), XOF

| Method            | Label              | Declared providers                    | SUPPORTED | IMPLEMENTED                 | CONFIGURED | LIVE |
| ----------------- | ------------------ | ------------------------------------- | --------- | --------------------------- | ---------- | ---- |
| `CARD`            | Carte bancaire     | `STRIPE`, `PAYDUNYA`, `PAYTECH`       | YES       | foundation only, no adapter | NO         | NO   |
| `PAYPAL`          | PayPal             | `PAYPAL`                              | YES       | foundation only, no adapter | NO         | NO   |
| `WAVE_SN`         | Wave (recommended) | `WAVE`, `PAYDUNYA`, `PAYTECH`         | YES       | foundation only, no adapter | NO         | NO   |
| `ORANGE_MONEY_SN` | Orange Money       | `ORANGE_MONEY`, `PAYDUNYA`, `PAYTECH` | YES       | foundation only, no adapter | NO         | NO   |
| `FREE_MONEY_SN`   | Free Money         | `PAYDUNYA`, `PAYTECH`                 | YES       | foundation only, no adapter | NO         | NO   |
| `EXPRESSO_SN`     | Expresso           | `PAYDUNYA`, `PAYTECH`                 | YES       | foundation only, no adapter | NO         | NO   |
| `WIZALL_SN`       | Wizall             | `PAYDUNYA`, `PAYTECH`                 | YES       | foundation only, no adapter | NO         | NO   |
| `DJAMO_SN`        | Djamo              | `PAYDUNYA`, `PAYTECH`                 | YES       | foundation only, no adapter | NO         | NO   |
| `BANK_TRANSFER`   | Virement bancaire  | `MANUAL_BANK_TRANSFER`                | YES       | foundation only, no adapter | NO         | NO   |
| `CASH_AT_AGENCY`  | Paiement en agence | `CASH`                                | YES       | foundation only, no adapter | NO         | NO   |

## Presentment currencies

| Payer country | Currency | Minor unit |
| ------------- | -------- | ---------- |
| FR, ES        | EUR      | 2          |
| MA            | MAD      | 2          |
| MR            | MRU      | 2          |
| SN            | XOF      | 0          |

See [multi-currency.md](multi-currency.md).
