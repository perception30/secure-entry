import express from 'express';
import { describe, expect, it } from 'vitest';
import { gatewayConfig, port } from '../shared/config.js';
import { errorHandler, requestContext, isHeaderIdentity } from '../shared/http.js';
import { createGateway } from '../gateway/src/app.js';
import { jsonLog } from '../gateway/src/logging.js';
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
  it('hides unexpected internal exceptions from clients', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/', () => { throw new Error('secret stack and database URL'); });
    app.use(errorHandler);
    const server = await listen(app);
    try {
      const response = await fetch(server.url);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: 'Internal server error', requestId: expect.any(String) });
    } finally { await server.close(); }
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
