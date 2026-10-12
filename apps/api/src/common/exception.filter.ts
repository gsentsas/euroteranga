import type { Logger } from '@euroteranga/logger';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentRequestId } from './request-context.js';

export interface ErrorResponse {
  code: string;
  message: string;
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

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const publicError =
      PUBLIC_ERRORS[status] ??
      (status >= 500 ? INTERNAL_ERROR : { code: 'HTTP_ERROR', message: 'Request failed' });

    const logFields = {
      method: request.method,
      route: request.originalUrl.split('?')[0],
      status,
      error: exception,
    };
    if (status >= 500) this.logger.error('request failed', logFields);
    else this.logger.debug('request rejected', logFields);

    if (response.headersSent) return;

    const body: ErrorResponse = { ...publicError, requestId: currentRequestId() ?? null };
    response.status(status).json(body);
  }
}
