import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { errorDetails, jsonError } from './logging.js';
import type { LogSink } from './logging.js';

export interface RequestContext {
  requestId: string;
  userId?: string;
  failureCode?: string;
  errorCode?: string;
  terminationCause?: 'client_aborted' | 'upstream_failure' | 'internal_error';
}

declare global {
  // Express uses namespace merging for typed middleware context.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals extends RequestContext {} // eslint-disable-line @typescript-eslint/no-empty-object-type
  }
}

export const requestContext: RequestHandler = (_req, res, next) => {
  res.locals.requestId = randomUUID();
  res.set({ 'X-Request-ID': res.locals.requestId, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  next();
};

export const notFound: RequestHandler = (_req, res) => {
  res.locals.failureCode = 'NOT_FOUND';
  res.status(404).json({ error: 'Not found', requestId: res.locals.requestId });
};

export function errorHandler(service: string, write: LogSink = jsonError): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'request.aborted') {
      res.locals.terminationCause = 'client_aborted';
      res.locals.failureCode = 'CLIENT_ABORTED';
      res.destroy();
      return;
    }
    const errors: Record<string, [number, string, string]> = {
      'entity.parse.failed': [400, 'Invalid JSON', 'INVALID_JSON'],
      'entity.too.large': [413, 'Request body too large', 'REQUEST_BODY_TOO_LARGE'],
      'encoding.unsupported': [415, 'Unsupported encoding', 'UNSUPPORTED_ENCODING'],
      'charset.unsupported': [415, 'Unsupported charset', 'UNSUPPORTED_CHARSET'],
    };
    const [status, message, failureCode] = error instanceof URIError ? [400, 'Invalid path', 'INVALID_PATH'] : (typeof type === 'string' && errors[type]) || [500, 'Internal server error', 'INTERNAL_ERROR'];
    res.locals.failureCode = failureCode;
    if (status === 500) {
      write({ timestamp: new Date().toISOString(), event: 'request_error', service, requestId: res.locals.requestId, failureCode, ...errorDetails(error) });
    }
    if (res.headersSent) { res.locals.terminationCause = 'internal_error'; res.destroy(); return; }
    res.status(status).json({ error: message, requestId: res.locals.requestId });
  };
}

export function isHeaderIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value) && !value.includes(',');
}
