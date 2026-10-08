import type { Express } from 'express';

export function startServer(app: Express, port: number, host: string, service: string) {
  const server = app.listen(port, host, () => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'listening', service, host, port }));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: 'startup_failed', service }));
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit());
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}
