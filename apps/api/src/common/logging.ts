import { createLogger, type LogLevel, type Logger } from '@euroteranga/logger';
import type { LoggerService } from '@nestjs/common';
import { currentRequestId } from './request-context.js';

export function createApiLogger(level: LogLevel): Logger {
  return createLogger({
    service: 'api',
    level,
    context: () => ({ requestId: currentRequestId() }),
  });
}

/** Routes NestJS framework logs through the structured JSON logger. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }

  // Nest calls error(message, stack, context) or error(message, context).
  error(message: unknown, ...params: unknown[]): void {
    const [first, second] = params;
    const fields = second === undefined ? { context: first } : { context: second, stack: first };
    this.logger.error(String(message), fields);
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }

  verbose(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }

  fatal(message: unknown, context?: string): void {
    this.logger.error(String(message), { context, fatal: true });
  }
}
