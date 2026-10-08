import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';

export interface RequestContext {
  requestId: string;
  userId?: string;
  failureCode?: string;
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
  res.status(404).json({ error: 'Not found', requestId: res.locals.requestId });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
  const errors: Record<string, [number, string]> = {
    'entity.parse.failed': [400, 'Invalid JSON'],
    'entity.too.large': [413, 'Request body too large'],
    'encoding.unsupported': [415, 'Unsupported encoding'],
    'charset.unsupported': [415, 'Unsupported charset'],
  };
  const [status, message] = error instanceof URIError ? [400, 'Invalid path'] : (typeof type === 'string' && errors[type]) || [500, 'Internal server error'];
  res.locals.failureCode = status === 500 ? 'INTERNAL_ERROR' : 'INVALID_BODY';
  if (res.headersSent) { res.destroy(); return; }
  res.status(status).json({ error: message, requestId: res.locals.requestId });
};

export function isHeaderIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value) && !value.includes(',');
}
