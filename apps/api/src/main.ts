import 'reflect-metadata';
import { ConfigValidationError, loadApiEnv, type ApiEnv } from '@euroteranga/config';
import { redactString } from '@euroteranga/logger';
import { createApp } from './app.factory.js';
import { createApiLogger } from './common/logging.js';

function loadEnvOrExit(): ApiEnv {
  try {
    return loadApiEnv();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Fail fast with an actionable message instead of crashing later.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnvOrExit();
  const logger = createApiLogger(env.LOG_LEVEL);
  const app = await createApp({ env, logger });

  // SIGTERM/SIGINT close the application, which runs module destroy hooks and
  // releases database connections before the process exits.
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);
  logger.info('api started', { host: env.API_HOST, port: env.API_PORT, app_env: env.APP_ENV });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`API failed to start: ${redactString(message)}\n`);
  process.exit(1);
});
