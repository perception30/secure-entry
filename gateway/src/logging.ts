import type { RequestHandler } from 'express';

export type LogSink = (entry: Record<string, unknown>) => void;
export const jsonLog: LogSink = entry => console.log(JSON.stringify(entry));

export function requestLog(write: LogSink): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.once('close', () => {
      write({
        timestamp: new Date().toISOString(),
        event: 'request',
        requestId: res.locals.requestId,
        method: req.method,
        path: req.path, // Deliberately omit query strings, headers and request bodies.
        sourceIp: req.socket.remoteAddress,
        userId: res.locals.userId ?? null,
        status: res.writableFinished ? res.statusCode : 499,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(res.locals.failureCode ? { failureCode: res.locals.failureCode } : {}),
      });
    });
    next();
  };
}
