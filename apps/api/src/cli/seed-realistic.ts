/**
 * SEED-REALISTIC-1 demonstration dataset (operator CLI, no HTTP endpoint).
 *
 *   pnpm seed:realistic -- [--dry-run | --apply | --summary | --cleanup-seed-only]
 *     [--anchor-date YYYY-MM-DD] [--trips-per-direction N] [--confirm-production]
 *
 * Read only unless --apply or --cleanup-seed-only is given. Writes need
 * ALLOW_REALISTIC_SEED=true and, in production, --confirm-production. Every
 * write goes through the domain services as the `realistic-seed` system
 * actor; the DATA-1 pilot corridor runs first, as `pilot-bootstrap`.
 * Exit codes: 0 done, 2 refused or conflicts, 1 error. The database target
 * is printed masked; no secret is ever printed.
 */
import 'reflect-metadata';
import { ConfigValidationError, loadApiEnv, type ApiEnv } from '@euroteranga/config';
import { createLogger, redactString } from '@euroteranga/logger';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AuditService } from '../authorization/audit.service.js';
import { BaggageService } from '../baggage/baggage.service.js';
import { BookingService } from '../bookings/booking.service.js';
import { PublicBookingService } from '../bookings/public-booking.service.js';
import { NestJsonLogger } from '../common/logging.js';
import { ContentService } from '../content/content.service.js';
import { CrewService } from '../crew/crew.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FleetService } from '../fleet/fleet.service.js';
import { IncidentService } from '../incidents/incident.service.js';
import { NetworkService } from '../network/network.service.js';
import { PassengerDocumentService } from '../passenger-documents/passenger-document.service.js';
import { PaymentService } from '../payments/payment.service.js';
import { PaymentWebhookService } from '../payments/payment-webhook.service.js';
import { PaymentCapabilityRegistry } from '../payments/payment-capability.registry.js';
import { PaymentQuoteService } from '../payments/payment-quote.service.js';
import { PILOT_DATASET_VERSION } from '../pilot/pilot-dataset.js';
import { PricingService } from '../pricing/pricing.service.js';
import { SeatMapService } from '../seat-maps/seat-map.service.js';
import {
  maskedDatabaseTarget,
  parseRealisticArgs,
  realisticRefusal,
  writes,
} from '../seed/realistic/realistic-args.js';
import { REALISTIC_NAMESPACE } from '../seed/realistic/realistic-dataset.js';
import { summarize } from '../seed/realistic/realistic-report.js';
import { RealisticSeed } from '../seed/realistic/realistic-seed.js';
import { TrackingService } from '../tracking/tracking.service.js';
import { TripService } from '../trips/trip.service.js';

const out = (line: string) => process.stdout.write(`${line}\n`);

/**
 * Bookings need SANDBOX payments, which the configuration allows in local and
 * CI only: the commerce layer never runs in staging or production.
 */
function commerceUnavailable(env: ApiEnv, registry: PaymentCapabilityRegistry): string | undefined {
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    return `bookings need SANDBOX payments (local and CI only), APP_ENV=${env.APP_ENV}`;
  }
  if (!registry.provider('SANDBOX')) return 'PAYMENT_PROVIDER is not SANDBOX';
  return undefined;
}
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const parsed = parseRealisticArgs(process.argv.slice(2), new Date());
  if (!parsed.ok) {
    err(parsed.message);
    err(
      'Usage: seed:realistic [--dry-run | --apply | --summary | --cleanup-seed-only] [--anchor-date YYYY-MM-DD] [--trips-per-direction N] [--confirm-production]',
    );
    return 2;
  }
  const { args } = parsed;
  const env = loadApiEnv();
  const refusal = realisticRefusal(
    {
      APP_ENV: env.APP_ENV,
      ALLOW_REALISTIC_SEED: process.env.ALLOW_REALISTIC_SEED,
      REALISTIC_SEED_NAMESPACE: process.env.REALISTIC_SEED_NAMESPACE,
    },
    args,
  );
  out(
    `Realistic dataset ${REALISTIC_NAMESPACE} on pilot ${PILOT_DATASET_VERSION} — APP_ENV=${env.APP_ENV}, ` +
      `database ${maskedDatabaseTarget(process.env.DATABASE_URL)}, mode ${args.mode}` +
      `${args.preview ? ' (preview)' : ''}${writes(args) ? '' : ' (nothing is written)'}.`,
  );
  if (refusal) {
    err(`Refused: ${refusal}`);
    return 2;
  }

  const logger = createLogger({ service: 'realistic-seed-cli', level: 'warn' });
  // The API's own wiring (configuration, providers, audit), without HTTP.
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ env, logger }), {
    logger: new NestJsonLogger(logger),
    abortOnError: false,
  });
  try {
    const database = app.get(DatabaseService);
    const unavailable = commerceUnavailable(
      env,
      app.get(PaymentCapabilityRegistry, { strict: false }),
    );
    const seed = new RealisticSeed({
      db: database.client,
      network: app.get(NetworkService),
      seatMaps: app.get(SeatMapService),
      fleet: app.get(FleetService),
      pricing: app.get(PricingService),
      trips: app.get(TripService),
      content: app.get(ContentService),
      commerce: unavailable
        ? undefined
        : {
            audit: app.get(AuditService),
            bookings: app.get(BookingService, { strict: false }),
            publicBooking: app.get(PublicBookingService, { strict: false }),
            passengers: app.get(PassengerDocumentService, { strict: false }),
            payments: app.get(PaymentService, { strict: false }),
            quotes: app.get(PaymentQuoteService, { strict: false }),
            webhooks: app.get(PaymentWebhookService, { strict: false }),
          },
      operations: unavailable
        ? undefined
        : {
            audit: app.get(AuditService),
            baggage: app.get(BaggageService, { strict: false }),
            crew: app.get(CrewService, { strict: false }),
            incidents: app.get(IncidentService, { strict: false }),
            tracking: app.get(TrackingService, { strict: false }),
          },
    });
    const cleanup = args.mode === 'cleanup-seed-only';
    const report = cleanup
      ? await seed.cleanup({ dryRun: args.preview })
      : await seed.run({
          anchorDate: args.anchorDate,
          tripsPerDirection: args.tripsPerDirection,
          dryRun: args.mode !== 'apply',
          commerceUnavailable: unavailable,
        });
    if (args.mode !== 'summary') {
      for (const line of report.lines) {
        out(
          `${line.outcome.padEnd(9)} ${line.entity.padEnd(11)} ${line.key}${line.detail ? ` — ${line.detail}` : ''}`,
        );
      }
    }
    for (const row of summarize(report.lines, cleanup ? 'cleanup' : 'seed')) out(row);
    if (report.hasConflicts) {
      err('Some items conflict with existing data and were left untouched (see "conflict" lines).');
      return 2;
    }
    return 0;
  } finally {
    await app.close();
  }
}

// exitCode, not exit(): Node then finishes writing the report to a pipe
// before it stops (the application context is already closed).
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    err(
      error instanceof ConfigValidationError
        ? error.message
        : `Realistic seed failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
    );
    process.exitCode = 1;
  });
