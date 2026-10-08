import type { RequestHandler } from 'express';

// A single API permission keeps policy separate without inventing roles or ownership rules.
export function authorize(requiredScope: string): RequestHandler {
  return (_req, res, next) => {
    const scope: unknown = res.locals.scope;
    if (typeof scope !== 'string' || !scope.split(' ').includes(requiredScope)) {
      res.locals.failureCode = 'INSUFFICIENT_SCOPE';
      res.status(403).json({ error: 'Forbidden', requestId: res.locals.requestId });
      return;
    }
    next();
  };
}
