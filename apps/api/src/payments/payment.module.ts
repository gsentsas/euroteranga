import {
  PAYPAL_LIVE_MODE_ENABLED,
  STRIPE_LIVE_MODE_ENABLED,
  WAVE_LIVE_MODE_ENABLED,
  type ApiEnv,
} from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule } from '@nestjs/common';
import { API_ENV, API_LOGGER } from '../config/config.module.js';
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
import {
  PayPalPaymentProvider,
  PayPalSdkGateway,
  type PayPalGateway,
} from './providers/paypal-payment.provider.js';
import {
  StripePaymentProvider,
  StripeSdkGateway,
  type StripeGateway,
} from './providers/stripe-payment.provider.js';
import {
  WaveHttpGateway,
  WavePaymentProvider,
  type WaveGateway,
} from './providers/wave-payment.provider.js';

/** Test-only replacement of the Stripe API calls (null: the official SDK). */
export const STRIPE_GATEWAY = Symbol('STRIPE_GATEWAY');
/** Test-only replacement of the PayPal API calls (null: the official SDK). */
export const PAYPAL_GATEWAY = Symbol('PAYPAL_GATEWAY');
/** Test-only replacement of Wave HTTP (null: native server-side fetch). */
export const WAVE_GATEWAY = Symbol('WAVE_GATEWAY');
const TEST_PAYMENT_PROVIDERS = Symbol('TEST_PAYMENT_PROVIDERS');

export interface PaymentModuleOptions {
  /** Tests only: CI never reaches Stripe. Production passes nothing. */
  stripeGateway?: StripeGateway;
  /** Tests only: CI never reaches PayPal. Production passes nothing. */
  paypalGateway?: PayPalGateway;
  /** Tests only: CI never reaches Wave. */
  waveGateway?: WaveGateway;
  /** Tests only: explicitly supplied adapters; production passes none. */
  testPaymentProviders?: readonly PaymentProvider[];
}

/**
 * The configured adapters, side by side: SANDBOX (local and CI only, refused
 * by the configuration when deployed), STRIPE (PAY-EU-1, TEST or LIVE),
 * PAYPAL (PAY-PAYPAL-1, SANDBOX or LIVE) and WAVE (PAY-SN-1A, LIVE only).
 * Every LIVE gate is false in this release. DISABLED wires nothing: no key is
 * read, no client is built and no network call can happen.
 */
export function paymentProvidersFactory(
  config: PaymentConfig,
  logger: Logger,
  stripeGateway: StripeGateway | null,
  paypalGateway: PayPalGateway | null = null,
  waveGateway: WaveGateway | null = null,
  testPaymentProviders: readonly PaymentProvider[] = [],
): PaymentProvider[] {
  const providers: PaymentProvider[] = [...testPaymentProviders];
  if (config.provider === 'SANDBOX' && config.sandboxWebhookKey) {
    providers.push(new SandboxPaymentProvider(config.sandboxWebhookKey));
  }
  if (config.stripe) {
    // The configuration refuses LIVE already; never start one regardless.
    if (config.stripe.mode === 'LIVE' && !STRIPE_LIVE_MODE_ENABLED) {
      throw new Error('PAYMENT_STRIPE_MODE=LIVE is not enabled in this release');
    }
    providers.push(
      new StripePaymentProvider({
        mode: config.stripe.mode,
        webhookSecret: config.stripe.webhookSecret,
        returnUrl: config.returnUrl,
        gateway: stripeGateway ?? new StripeSdkGateway(config.stripe.secretKey),
        logger,
      }),
    );
  }
  if (config.paypal) {
    if (config.paypal.mode === 'LIVE' && !PAYPAL_LIVE_MODE_ENABLED) {
      throw new Error('PAYMENT_PAYPAL_MODE=LIVE is not enabled in this release');
    }
    const { mode, clientId, clientSecret, webhookId } = config.paypal;
    providers.push(
      new PayPalPaymentProvider({
        mode,
        webhookId,
        returnUrl: config.returnUrl,
        gateway: paypalGateway ?? new PayPalSdkGateway(mode, clientId, clientSecret),
        logger,
      }),
    );
  }
  if (config.wave) {
    if (config.wave.mode === 'LIVE' && !WAVE_LIVE_MODE_ENABLED) {
      throw new Error('PAYMENT_WAVE_MODE=LIVE is not enabled in this release');
    }
    const { apiKey, webhookSecret, requestSigningSecret } = config.wave;
    providers.push(
      new WavePaymentProvider({
        webhookSecret,
        returnUrl: config.returnUrl,
        gateway: waveGateway ?? new WaveHttpGateway(apiKey, requestSigningSecret),
        logger,
      }),
    );
  }
  return providers;
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
@Module({})
export class PaymentModule {
  static register(options: PaymentModuleOptions = {}): DynamicModule {
    return {
      module: PaymentModule,
      imports: [DatabaseModule],
      controllers: [CustomerPaymentController, PaymentWebhookController, AdminPaymentController],
      providers: [
        { provide: PAYMENT_CONFIG, useFactory: buildPaymentConfig, inject: [API_ENV] },
        { provide: STRIPE_GATEWAY, useValue: options.stripeGateway ?? null },
        { provide: PAYPAL_GATEWAY, useValue: options.paypalGateway ?? null },
        { provide: WAVE_GATEWAY, useValue: options.waveGateway ?? null },
        { provide: TEST_PAYMENT_PROVIDERS, useValue: options.testPaymentProviders ?? [] },
        {
          provide: PAYMENT_PROVIDERS,
          useFactory: paymentProvidersFactory,
          inject: [
            PAYMENT_CONFIG,
            API_LOGGER,
            STRIPE_GATEWAY,
            PAYPAL_GATEWAY,
            WAVE_GATEWAY,
            TEST_PAYMENT_PROVIDERS,
          ],
        },
        { provide: FX_RATE_SOURCE, useFactory: fxRateSourceFactory, inject: [API_ENV] },
        PaymentCapabilityRegistry,
        PaymentFxService,
        PaymentQuoteService,
        PaymentService,
        PaymentWebhookService,
      ],
    };
  }
}
