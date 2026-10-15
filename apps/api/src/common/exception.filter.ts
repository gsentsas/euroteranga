import type { Logger } from '@euroteranga/logger';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { currentRequestId } from './request-context.js';

export interface ErrorResponse {
  code: string;
  message: string;
  /** Server-built stable codes only (PublicApiError.publicDetails). */
  details?: Readonly<Record<string, unknown>>;
  requestId: string | null;
}

const PUBLIC_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request is invalid' },
  401: { code: 'UNAUTHORIZED', message: 'Authentication is required' },
  403: { code: 'FORBIDDEN', message: 'Access is denied' },
  404: { code: 'NOT_FOUND', message: 'Resource not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  409: { code: 'CONFLICT', message: 'The request conflicts with the current state' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request payload is too large' },
  422: { code: 'UNPROCESSABLE_ENTITY', message: 'The request could not be processed' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
};

const INTERNAL_ERROR = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };

/**
 * Body-parser failures happen before Nest routing and are not HttpExceptions.
 * An oversized body (body-parser `entity.too.large`) keeps its 413 instead of
 * becoming an internal error; nothing else of such errors is trusted.
 */
function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  if (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { type?: unknown }).type === 'entity.too.large'
  ) {
    return 413;
  }
  return 500;
}

/**
 * Single error shape for every failure: { code, message, requestId }.
 *
 * Messages are fixed per status rather than copied from the exception, so
 * driver errors, SQL, connection strings and stack traces can never reach the
 * client. The full error is logged server-side, where the logger redacts
 * credentials.
 */
@Catch()
export class FoundationExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const status = statusOf(exception);
    // PublicApiError carries a code and message written for clients; any
    // other error gets the fixed message of its status.
    const publicError =
      exception instanceof PublicApiError
        ? { code: exception.code, message: exception.publicMessage }
        : (PUBLIC_ERRORS[status] ??
          (status >= 500 ? INTERNAL_ERROR : { code: 'HTTP_ERROR', message: 'Request failed' }));

    const logFields = {
      method: request.method,
      route: request.originalUrl.split('?')[0],
      status,
      // Client errors are logged by name only: messages of body-parsing errors
      // can quote the submitted payload (e.g. a password in malformed JSON).
      error:
        status >= 500
          ? exception
          : { name: exception instanceof Error ? exception.name : 'unknown' },
    };
    if (status >= 500) this.logger.error('request failed', logFields);
    else this.logger.debug('request rejected', logFields);

    if (response.headersSent) return;
    if (exception instanceof PublicApiError) {
      for (const [name, value] of Object.entries(exception.headers))
        response.setHeader(name, value);
    }

    const details = exception instanceof PublicApiError ? exception.publicDetails : undefined;
    const body: ErrorResponse = {
      ...publicError,
      ...(details ? { details } : {}),
      requestId: currentRequestId() ?? null,
    };
    response.status(status).json(body);
  }
}
