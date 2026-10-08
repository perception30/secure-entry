import express from 'express';
import { authenticate, createTokenVerifier } from './authentication.js';
import type { AuthConfig, VerifyToken } from './authentication.js';
import { authorize } from './policy.js';
import { requestLog, jsonLog } from './logging.js';
import type { LogSink } from './logging.js';
import { proxyTo } from './proxy.js';
import { requestContext, notFound, errorHandler } from '../../shared/http.js';

export function createGateway(config: AuthConfig & { backendUrl: URL }, options: { log?: LogSink; verify?: VerifyToken } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(requestContext, requestLog(options.log ?? jsonLog));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.all(/^\/api\/users(?:\/.*)?$/,
    authenticate(options.verify ?? createTokenVerifier(config)),
    authorize(`${config.audience}/users`),
    proxyTo(config.backendUrl),
  );
  app.use(notFound, errorHandler);
  return app;
}
