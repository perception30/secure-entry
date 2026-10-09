import express from 'express';
import { describe, expect, it } from 'vitest';
import { gatewayConfig, port, ConfigurationError } from '../shared/config.js';
import { errorHandler, requestContext, isHeaderIdentity } from '../shared/http.js';
import { createGateway } from '../gateway/src/app.js';
import { jsonLog, requestLog } from '../shared/logging.js';
import { startServer, startupFailure } from '../shared/server.js';
import { once } from 'node:events';
import { listen, audience, clientId } from './helpers.js';
import { vi } from 'vitest';

const valid = { OIDC_ISSUER: 'https://issuer.example/pool', OIDC_JWKS_URI: 'https://issuer.example/pool/keys', OIDC_AUDIENCE: audience, OIDC_CLIENT_ID: clientId, BACKEND_URL: 'http://127.0.0.1:3001' };
describe('configuration and error boundaries', () => {
  it('uses safe local defaults and supports explicit ports', () => {
    expect(gatewayConfig(valid)).toMatchObject({ host: '127.0.0.1', port: 3000 });
    expect(gatewayConfig({ ...valid, GATEWAY_HOST: '0.0.0.0', GATEWAY_PORT: '3100' })).toMatchObject({ host: '0.0.0.0', port: 3100 });
    expect(port(undefined, 3001)).toBe(3001);
  });
  it.each(['', '0', '-1', '65536', '1.1', 'abc'])('rejects invalid port %j', value => expect(() => port(value, 3000)).toThrow());
  it.each(Object.keys(valid))('requires %s at startup', name => expect(() => gatewayConfig({ ...valid, [name]: '' })).toThrow());
  it.each([
    ['OIDC_ISSUER', 'http://issuer.test'], ['OIDC_JWKS_URI', 'http://issuer.test/keys'],
    ['OIDC_JWKS_URI', 'file:///tmp/keys'], ['OIDC_ISSUER', 'https://user:secret@issuer.test'],
    ['BACKEND_URL', 'http://backend.test/path'], ['BACKEND_URL', 'http://backend.test/?secret=value'],
    ['OIDC_ISSUER', 'https://issuer.test/#fragment'], ['OIDC_ISSUER', 'not a url'],
  ])('rejects unsafe %s=%s', (name, value) => expect(() => gatewayConfig({ ...valid, [name]: value })).toThrow());
  it.each([undefined, '', 'one,two', '\r\n', 'a'.repeat(256)])('rejects unsafe identity %j', identity => expect(isHeaderIdentity(identity)).toBe(false));
  it('serializes logs as JSON', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    jsonLog({ method: 'GET', path: '/api/users' });
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual({ method: 'GET', path: '/api/users' });
    output.mockRestore();
  });
  it.each(['gateway', 'backend'])('logs unexpected %s exceptions with safe diagnostics and correlation', async service => {
    const logs: Record<string, unknown>[] = [];
    const app = express();
    app.use(requestContext, requestLog(service, entry => logs.push(entry)));
    app.get('/', () => { throw new TypeError('secret stack and database URL'); });
    app.use(errorHandler(service, entry => logs.push(entry)));
    const server = await listen(app);
    try {
      const response = await fetch(server.url);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: 'Internal server error', requestId: expect.any(String) });
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({ event: 'request_error', service, requestId: body.requestId, failureCode: 'INTERNAL_ERROR', errorType: 'TypeError', locations: expect.arrayContaining([expect.objectContaining({ file: 'config-errors.test.ts', line: expect.any(Number) })]) });
      expect(logs[1]).toMatchObject({ event: 'request', service, requestId: body.requestId, status: 500, sourceIp: '127.0.0.1', failureCode: 'INTERNAL_ERROR' });
      expect(JSON.stringify(logs)).not.toMatch(/secret|database URL/);
    } finally { await server.close(); }
  });
  it.each([
    ['OIDC_ISSUER', '', 'CONFIG_REQUIRED'],
    ['OIDC_JWKS_URI', 'invalid secret URL', 'CONFIG_INVALID_URL'],
    ['GATEWAY_PORT', 'secret', 'CONFIG_INVALID_PORT'],
    ['OIDC_ISSUER', 'http://issuer.example', 'CONFIG_HTTPS_REQUIRED'],
    ['BACKEND_URL', 'http://backend.example/path', 'CONFIG_INVALID_BACKEND_ORIGIN'],
  ])('records the failing configuration key %s without its value', (key, value, code) => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      try { gatewayConfig({ ...valid, [key]: value }); } catch (error) { startupFailure('gateway', error, 'invalid_configuration'); }
      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({ event: 'invalid_configuration', service: 'gateway', configKey: key, errorCode: code });
      expect(JSON.stringify(output.mock.calls)).not.toContain('secret');
      expect(process.exitCode).toBe(1);
      expect(() => port('invalid', 3001, 'BACKEND_PORT')).toThrowError(new ConfigurationError('BACKEND_PORT', 'CONFIG_INVALID_PORT'));
    } finally { output.mockRestore(); process.exitCode = previousExitCode; }
  });
  it('records an internal error after headers without misclassifying it as client cancellation', async () => {
    const logs: Record<string, unknown>[] = [];
    const app = express();
    app.use(requestContext, requestLog('backend', entry => logs.push(entry)));
    app.get('/', (_req, res, next) => { res.write('{'); setTimeout(() => next(new Error('private exception')), 20); });
    app.use(errorHandler('backend', entry => logs.push(entry)));
    const server = await listen(app);
    try {
      const response = await fetch(server.url);
      await expect(response.text()).rejects.toThrow();
      await vi.waitFor(() => expect(logs).toHaveLength(2));
      expect(logs[0]).toMatchObject({ event: 'request_error', failureCode: 'INTERNAL_ERROR' });
      expect(logs[1]).toMatchObject({ status: 500, responseStatus: 200, sourceIp: '127.0.0.1', terminationCause: 'internal_error', failureCode: 'INTERNAL_ERROR' });
      expect(logs[1]?.requestId).toBe(logs[0]?.requestId);
      expect(JSON.stringify(logs)).not.toContain('private exception');
    } finally { await server.close(); }
  });
  it('logs the socket error code when startup cannot bind', async () => {
    const occupied = await listen(express());
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const normal = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    const signals = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, process.listeners(signal)]));
    try {
      const server = startServer(express(), Number(new URL(occupied.url).port), '127.0.0.1', 'backend');
      await once(server, 'error');
      expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({ event: 'startup_failed', service: 'backend', errorCode: 'EADDRINUSE' });
      expect(normal).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      for (const [signal, before] of signals) for (const listener of process.listeners(signal)) if (!before.includes(listener)) process.removeListener(signal, listener);
      output.mockRestore(); normal.mockRestore(); process.exitCode = previousExitCode;
      await occupied.close();
    }
  });
  it('fails closed with safe logs for non-JOSE verifier failures', async () => {
    const logs: Record<string, unknown>[] = [];
    const server = await listen(createGateway(gatewayConfig(valid), { verify: async () => { throw new Error('sensitive provider details'); }, log: entry => logs.push(entry) }));
    try {
      const response = await fetch(`${server.url}/api/users`, { headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
      expect(response.status).toBe(401);
      expect(logs[0]).toMatchObject({ failureCode: 'JWKS_UNAVAILABLE', userId: null });
      expect(JSON.stringify(logs)).not.toContain('sensitive');
    } finally { await server.close(); }
  });
});
