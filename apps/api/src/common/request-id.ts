import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Logger } from '@euroteranga/logger';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Accept a caller-provided id (e.g. from the reverse proxy) only when it is a
 * short token of safe characters, so it cannot inject content into logs.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && VALID_REQUEST_ID.test(value);
}

/**
 * Assigns a request id, echoes it in the X-Request-Id response header, binds
 * it to the async context and logs one line per completed request. Only the
 * method, path (without query string), status and duration are logged —
 * never headers, cookies or bodies.
 */
export function requestIdMiddleware(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.header(REQUEST_ID_HEADER);
    const requestId = isValidRequestId(incoming) ? incoming : randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = performance.now();
    const path = request.originalUrl.split('?')[0] ?? '/';

    requestContext.run({ requestId }, () => {
      response.on('finish', () => {
        const fields = {
          method: request.method,
          route: path,
          status: response.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
          result: response.statusCode >= 500 ? 'error' : 'ok',
        };
        // Probes run every few seconds; keep them out of normal-level logs.
        if (path.startsWith('/health')) logger.debug('request completed', fields);
        else logger.info('request completed', fields);
      });
      next();
    });
  };
}
