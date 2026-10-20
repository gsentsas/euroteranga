import type { ApiEnv } from '@euroteranga/config';
import { Module } from '@nestjs/common';
import { API_ENV } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminPaymentController } from './admin-payment.controller.js';
import { buildPaymentConfig, PAYMENT_CONFIG, type PaymentConfig } from './payment.config.js';
import { PaymentService } from './payment.service.js';
import { PaymentCapabilityRegistry } from './payment-capability.registry.js';
import {
  FX_RATE_SOURCE,
  PaymentFxService,
  SyntheticCiFxRateSource,
  type FxRateSource,
} from './payment-fx.service.js';
import { PaymentQuoteService } from './payment-quote.service.js';
import { PaymentWebhookController } from './payment-webhook.controller.js';
import { PaymentWebhookService } from './payment-webhook.service.js';
import { CustomerPaymentController } from './customer-payment.controller.js';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './providers/payment-provider.js';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider.js';

/**
 * The configured adapters: SANDBOX (local and CI only, refused by the
 * configuration when deployed) or none (DISABLED). PAY-HUB-1 has no adapter
 * for a real provider: no real money can be taken.
 */
function paymentProvidersFactory(config: PaymentConfig): PaymentProvider[] {
  if (config.provider === 'SANDBOX' && config.sandboxWebhookKey) {
    return [new SandboxPaymentProvider(config.sandboxWebhookKey)];
  }
  return [];
}

/**
 * Conversion rates: the deterministic synthetic table in local and CI only.
 * Deployed environments have no rate source yet, so any conversion between
 * two different currencies is unavailable (fail closed); same-currency
 * quotes need no rate.
 */
function fxRateSourceFactory(env: ApiEnv): FxRateSource | null {
  return env.APP_ENV === 'local' || env.APP_ENV === 'ci' ? new SyntheticCiFxRateSource() : null;
}

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CustomerPaymentController, PaymentWebhookController, AdminPaymentController],
  providers: [
    { provide: PAYMENT_CONFIG, useFactory: buildPaymentConfig, inject: [API_ENV] },
    { provide: PAYMENT_PROVIDERS, useFactory: paymentProvidersFactory, inject: [PAYMENT_CONFIG] },
    { provide: FX_RATE_SOURCE, useFactory: fxRateSourceFactory, inject: [API_ENV] },
    PaymentCapabilityRegistry,
    PaymentFxService,
    PaymentQuoteService,
    PaymentService,
    PaymentWebhookService,
  ],
})
export class PaymentModule {}
