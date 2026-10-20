# Onboarding a payment provider (after PAY-HUB-1)

PAY-HUB-1 activates no real provider: every real declaration is SUPPORTED
only (see [payment-matrix.md](payment-matrix.md)). Each provider gets its own
reviewed PR, in this order, and stays disabled until the owner decides to go
live.

## 1. Before any code

- Merchant contract and the merchant entity country it requires
  (`requiresMerchantEntityCountry`).
- Check the declared capability against the provider's documentation and
  contract: methods, payer countries, currencies, refunds, partial refunds,
  webhooks, redirect or phone flow. **The declarations in
  `payment-capability.registry.ts` are planning hypotheses**: correct them
  first.
- Sandbox credentials from the provider. Never commit a secret, even a test
  one; secrets go to the environment file of the target only.

## 2. The adapter PR

- Implement `PaymentProvider` (`providers/payment-provider.ts`):
  - `createPayment` with the payment reference as the provider-side
    idempotency key; it receives the presentment amount, currency and minor
    unit, the method and the payer country, nothing else;
  - `verifyWebhook`: content type, size, timestamp tolerance, signature
    compared in constant time;
  - `parseWebhook`: normalized types and failure codes, never raw provider
    text; the payload is hashed, not stored.
- Its `capability` comes from the declaration (`declaredCapability`), and the
  declaration becomes `implemented: true`.
- Configuration: its own variables, validated at startup, refused when
  incomplete; disabled by default. The module wires the adapter only when
  configured.
- A webhook route of its own, authenticated by the provider's signature.
- No network call inside a database transaction; the PENDING attempt is
  committed before the call (PR-10 order).
- Tests: signature, replay, timestamps, payload size, amount and currency
  against the quote's presentment, same-method fallback, no cross-method
  fallback, no confirmation from a redirect.

## 3. FX, when the provider is not in the booking currency

Choose and implement a rate source (`FX_MANUAL_OPS`, `FX_PROVIDER` or
`FX_EXTERNAL_SERVICE`) in its own PR. Until then, conversions stay
unavailable outside local and CI.

## 4. Going live

- Owner approval, in writing.
- Configured in staging with the provider's sandbox; end-to-end check with
  real webhooks.
- Production configuration, with a smoke test of a small real payment and
  its refund, decided by the owner.
- Settlement import for reconciliation ([reconciliation.md](reconciliation.md)).

## Status at PAY-HUB-1

| Provider                                                                                                 | Adapter        | Configured     | Live  |
| -------------------------------------------------------------------------------------------------------- | -------------- | -------------- | ----- |
| SANDBOX                                                                                                  | yes, test-only | local, CI only | never |
| STRIPE, PAYPAL, PAYDUNYA, PAYTECH, WAVE, ORANGE_MONEY, CMI, CHARIPAY, MOOSYL, MANUAL_BANK_TRANSFER, CASH | no             | no             | no    |
