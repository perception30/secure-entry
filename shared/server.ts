import type { Express } from 'express';
import { ConfigurationError } from './config.js';
import { errorDetails, jsonError } from './logging.js';

export function startupFailure(service: string, error: unknown, event = 'startup_failed') {
  jsonError({ timestamp: new Date().toISOString(), event, service, ...errorDetails(error),
    ...(error instanceof ConfigurationError ? { configKey: error.key } : {}),
  });
  process.exitCode = 1;
}

export function startServer(app: Express, port: number, host: string, service: string) {
  const server = app.listen(port, host, (error?: Error) => {
    if (!error) console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'listening', service, host, port }));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', error => startupFailure(service, error));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit());
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}
