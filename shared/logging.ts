import type { RequestHandler } from 'express';

export type LogSink = (entry: Record<string, unknown>) => void;
export const jsonLog: LogSink = entry => console.log(JSON.stringify(entry));
export const jsonError: LogSink = entry => console.error(JSON.stringify(entry));

export function errorDetails(error: unknown) {
  const value = error instanceof Error ? error : undefined;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  // Exclude exception messages and source text: either may contain credentials or input.
  const locations = (value?.stack?.split('\n').slice(1) ?? []).flatMap(frame => {
    const match = /[ /]([^/\s():]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/.exec(frame);
    return match ? [{ file: match[1], line: Number(match[2]), column: Number(match[3]) }] : [];
  }).slice(0, 3);
  return {
    errorType: value instanceof TypeError ? 'TypeError' : value instanceof RangeError ? 'RangeError' : value instanceof SyntaxError ? 'SyntaxError' : 'Error',
    ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { errorCode: code } : {}),
    ...(locations.length ? { locations } : {}),
  };
}

export function requestLog(service: string, write: LogSink): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const metadata = { method: req.method, path: req.path, sourceIp: req.socket.remoteAddress ?? null };
    res.once('close', () => {
      const completed = res.writableFinished;
      const terminationCause = completed ? 'completed' : res.locals.terminationCause ?? 'client_aborted';
      const failureCode = terminationCause === 'client_aborted' ? 'CLIENT_ABORTED' : res.locals.failureCode;
      write({
        timestamp: new Date().toISOString(), event: 'request', service,
        requestId: res.locals.requestId, ...metadata,
        userId: res.locals.userId ?? null,
        status: completed ? res.statusCode : terminationCause === 'client_aborted' ? 499 : terminationCause === 'upstream_failure' ? 502 : 500,
        terminationCause,
        ...(!completed && res.headersSent ? { responseStatus: res.statusCode } : {}),
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(failureCode ? { failureCode } : {}),
        ...(res.locals.errorCode ? { errorCode: res.locals.errorCode } : {}),
      });
    });
    next();
  };
}
