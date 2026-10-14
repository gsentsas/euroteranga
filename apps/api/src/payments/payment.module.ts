import { Module } from '@nestjs/common';
import { API_ENV } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminPaymentController } from './admin-payment.controller.js';
import { buildPaymentConfig, PAYMENT_CONFIG, type PaymentConfig } from './payment.config.js';
import { PaymentService } from './payment.service.js';
import { PaymentWebhookController } from './payment-webhook.controller.js';
import { PaymentWebhookService } from './payment-webhook.service.js';
import { CustomerPaymentController } from './customer-payment.controller.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.js';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider.js';

/** The configured provider: SANDBOX (dev/test/CI only) or none (DISABLED). */
function paymentProviderFactory(config: PaymentConfig): PaymentProvider | null {
  if (config.provider === 'SANDBOX' && config.sandboxWebhookKey) {
    return new SandboxPaymentProvider(config.sandboxWebhookKey);
  }
  return null;
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
    { provide: PAYMENT_PROVIDER, useFactory: paymentProviderFactory, inject: [PAYMENT_CONFIG] },
    PaymentService,
    PaymentWebhookService,
  ],
})
export class PaymentModule {}
